/**
 * Dual write: dopo il salvataggio vettoriale (ChromaDB, invariato), questo
 * modulo indicizza lo stesso contenuto nel knowledge graph. E' pensato per
 * essere eseguito in modo asincrono e non bloccante rispetto alla risposta
 * HTTP: il fallimento di una qualsiasi delle sue fasi non deve mai
 * ripercuotersi sul salvataggio vettoriale, gia' avvenuto in precedenza.
 *
 * Nessuna query Cypher e' generata dal modello: l'estrattore produce solo
 * JSON validato (vedi extractor/schema.js), questo modulo costruisce le
 * chiamate al graphRepository.
 */
import { memoryId, chunkId, decisionId } from '../ids.js';
import { resolveEntity } from './entityResolver.js';
import { labelForEntityType } from './entityTypeMapping.js';

function noopMetrics() {
  return { increment() {} };
}

/**
 * @param {{namespace:string, memory:{sourceUrl?:string, captureId?:string, title?:string, platform?:string, topic?:string}, chunks:{id:string, text:string, timestamp?:number}[]}} input
 * @param {{graphRepo:object, extractor:object, embed?:Function, thresholds:object, extractorVersion:string, metrics?:object}} deps
 */
export async function indexMemoryIntoGraph(input, deps) {
  const { namespace, memory, chunks } = input;
  const { graphRepo, extractor, embed, thresholds, extractorVersion, metrics = noopMetrics() } = deps;

  if (!namespace) throw new Error('namespace obbligatorio per il dual write');
  if (!chunks || chunks.length === 0) {
    return { ok: true, stats: emptyStats() };
  }

  // ── 1. Struttura portante: Memory + Chunk + CHUNK_OF (sempre, indipendente dall'estrazione) ──
  // Queste scritture sono la base su cui si appoggia tutto il resto (entita',
  // relazioni, evidence): se una di loro fallisce (Neo4j giu', timeout...) il
  // job deve essere considerato fallito e ritentato dalla coda, non "riuscito
  // a meta'". upsertNode/upsertRelation non lanciano mai: vanno controllati.
  const memGraphId = memoryId(namespace, memory?.sourceUrl, memory?.captureId);
  const memoryResult = await graphRepo.upsertNode('Memory', {
    id: memGraphId,
    namespace,
    type: 'memory',
    name: memory?.title ?? memory?.sourceUrl ?? memGraphId,
    metadata: { source_url: memory?.sourceUrl ?? '', platform: memory?.platform ?? 'unknown', topic: memory?.topic ?? '' },
  });
  if (!memoryResult.ok) {
    metrics.increment('graph_failures');
    return { ok: false, stage: 'structural', error: memoryResult.error, stats: emptyStats() };
  }

  /** @type {Map<string,string>} chroma chunk id -> graph chunk id */
  const chunkGraphIds = new Map();
  for (const chunk of chunks) {
    const cid = chunkId(namespace, chunk.id);
    chunkGraphIds.set(chunk.id, cid);
    // eslint-disable-next-line no-await-in-loop
    const chunkResult = await graphRepo.upsertNode('Chunk', {
      id: cid,
      namespace,
      type: 'chunk',
      name: chunk.id,
      summary: (chunk.text ?? '').slice(0, 280),
      metadata: { chroma_id: chunk.id, timestamp: chunk.timestamp ?? null },
    });
    if (!chunkResult.ok) {
      metrics.increment('graph_failures');
      return { ok: false, stage: 'structural', error: chunkResult.error, stats: emptyStats() };
    }
    // eslint-disable-next-line no-await-in-loop
    const chunkOfResult = await graphRepo.upsertRelation({
      fromLabel: 'Chunk',
      fromId: cid,
      toLabel: 'Memory',
      toId: memGraphId,
      type: 'CHUNK_OF',
      namespace,
      confidence: 1,
      sourceChunkIds: [cid], // il chunk e' evidenza di se stesso: relazione strutturale
      extractorVersion: 'structural',
    });
    if (!chunkOfResult.ok) {
      metrics.increment('graph_failures');
      return { ok: false, stage: 'structural', error: chunkOfResult.error, stats: emptyStats() };
    }
  }

  // ── 2. Estrazione strutturata (puo' fallire senza intaccare la struttura sopra) ──
  const extraction = await extractor.extract(
    chunks.map((c) => ({ id: c.id, text: c.text })),
    { namespace }
  );
  if (!extraction.ok) {
    metrics.increment('graph_failures');
    return { ok: false, stage: 'extract', error: extraction.error, stats: emptyStats() };
  }

  const knownChromaChunkIds = new Set(chunks.map((c) => c.id));
  const stats = emptyStats();

  // Le scritture da qui in poi (entita', MENTIONS, decisioni, DERIVED_FROM,
  // SUPERSEDES) arricchiscono il grafo ma non sono "portanti" come Memory/
  // Chunk/CHUNK_OF: si continua a processare il resto anche se una fallisce,
  // per non perdere le altre entita'/relazioni della stessa memory. Il job
  // pero' NON viene dichiarato riuscito se anche una sola di queste scritture
  // e' fallita: si ritenta l'intero job (idempotente, quindi sicuro anche per
  // le scritture gia' andate a buon fine).
  let firstFailure = null;
  function noteFailure(result) {
    if (!result.ok && !firstFailure) firstFailure = result.error;
    return result;
  }

  // ── 3. Entita' dichiarate esplicitamente dall'estrattore ──
  /** @type {Map<string,{id:string,label:string}>} nome (as-is) -> riferimento nel grafo */
  const nameToRef = new Map();

  for (const entity of extraction.data.entities) {
    const label = labelForEntityType(entity.type);
    // eslint-disable-next-line no-await-in-loop
    const resolution = await resolveEntity(
      { namespace, type: entity.type, name: entity.name, aliases: entity.aliases, label },
      { graphRepo, embed, thresholds }
    );
    stats.entities_extracted += 1;

    let targetId = resolution.entityId;
    if (resolution.decision === 'automatic_merge') {
      stats.entity_merges += 1;
      const existingAliases = resolution.matchedEntity?.aliases ?? [];
      const mergedAliases = Array.from(new Set([...existingAliases, ...(entity.aliases ?? []), entity.name]));
      const mergeHistory = [
        ...(resolution.matchedEntity?.metadata?.merge_history ?? []),
        { merged_temporary_id: entity.temporary_id, merged_name: entity.name, reason: resolution.reason, at: new Date().toISOString() },
      ];
      // eslint-disable-next-line no-await-in-loop
      noteFailure(await graphRepo.upsertNode(label, {
        id: targetId,
        namespace,
        type: entity.type,
        name: resolution.matchedEntity?.name ?? entity.name,
        aliases: mergedAliases,
        metadata: { ...(resolution.matchedEntity?.metadata ?? {}), merge_history: mergeHistory },
      }));
    } else if (resolution.decision === 'possible_duplicate') {
      stats.possible_duplicates += 1;
      // eslint-disable-next-line no-await-in-loop
      noteFailure(await graphRepo.upsertNode(label, {
        id: targetId,
        namespace,
        type: entity.type,
        name: entity.name,
        aliases: entity.aliases,
        metadata: { possible_duplicate_of: resolution.candidateEntityId, possible_duplicate_score: resolution.score },
      }));
    } else if (resolution.decision === 'new_entity') {
      // eslint-disable-next-line no-await-in-loop
      noteFailure(await graphRepo.upsertNode(label, {
        id: targetId,
        namespace,
        type: entity.type,
        name: entity.name,
        aliases: entity.aliases,
        metadata: {},
      }));
    }
    // exact_match: nodo gia' presente e identico, nessuna scrittura necessaria.

    // Collega l'entita' a tutti i chunk di questa memory: e' l'unica evidenza
    // disponibile per un'entita' dichiarata (lo schema dell'estrattore non
    // porta un evidence_chunk_id per-entita', solo per relazioni/decisioni).
    // Senza questi archi MENTIONS, findChunksByEntity e l'espansione seedata
    // da entita' non troverebbero mai alcun chunk per un'entita' che non
    // compare anche come source/target di una relazione.
    for (const cid of chunkGraphIds.values()) {
      // eslint-disable-next-line no-await-in-loop
      noteFailure(await graphRepo.upsertRelation({
        fromLabel: 'Chunk',
        fromId: cid,
        toLabel: label,
        toId: targetId,
        type: 'MENTIONS',
        namespace,
        confidence: 1,
        sourceChunkIds: [cid],
        extractorVersion,
      }));
    }

    nameToRef.set(entity.name, { id: targetId, label });
    for (const alias of entity.aliases ?? []) nameToRef.set(alias, { id: targetId, label });
  }

  /** Risolve (o crea al volo, come tipo 'other') un riferimento nome -> nodo grafo. */
  async function resolveNameToRef(name) {
    if (nameToRef.has(name)) return nameToRef.get(name);
    const resolution = await resolveEntity(
      { namespace, type: 'other', name, aliases: [], label: 'Entity' },
      { graphRepo, embed, thresholds }
    );
    if (resolution.decision === 'new_entity' || resolution.decision === 'possible_duplicate') {
      noteFailure(await graphRepo.upsertNode('Entity', {
        id: resolution.entityId,
        namespace,
        type: 'other',
        name,
        aliases: [],
        metadata: resolution.decision === 'possible_duplicate'
          ? { possible_duplicate_of: resolution.candidateEntityId, possible_duplicate_score: resolution.score }
          : {},
      }));
    }
    const ref = { id: resolution.entityId, label: 'Entity' };
    nameToRef.set(name, ref);
    return ref;
  }

  // ── 4. Relazioni estratte ──
  for (const relation of extraction.data.relations) {
    if (!knownChromaChunkIds.has(relation.evidence_chunk_id)) {
      // Difesa in profondita': anche se l'estrattore dovrebbe gia' averlo scartato.
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const fromRef = await resolveNameToRef(relation.source);
    // eslint-disable-next-line no-await-in-loop
    const toRef = await resolveNameToRef(relation.target);
    const evidenceGraphChunkId = chunkGraphIds.get(relation.evidence_chunk_id);

    // Entita' risolte "al volo" (tipo 'other', non dichiarate esplicitamente
    // dall'estrattore) non ricevono i MENTIONS per-batch dello step 3: qui
    // colleghiamo comunque il chunk di evidenza specifico. Per le entita'
    // gia' dichiarate e' un'unione idempotente con l'arco gia' creato sopra.
    for (const ref of [fromRef, toRef]) {
      // eslint-disable-next-line no-await-in-loop
      noteFailure(await graphRepo.upsertRelation({
        fromLabel: 'Chunk',
        fromId: evidenceGraphChunkId,
        toLabel: ref.label,
        toId: ref.id,
        type: 'MENTIONS',
        namespace,
        confidence: relation.confidence,
        sourceChunkIds: [evidenceGraphChunkId],
        extractorVersion,
      }));
    }

    // eslint-disable-next-line no-await-in-loop
    const result = noteFailure(await graphRepo.upsertRelation({
      fromLabel: fromRef.label,
      fromId: fromRef.id,
      toLabel: toRef.label,
      toId: toRef.id,
      type: relation.relationship,
      namespace,
      confidence: relation.confidence,
      sourceChunkIds: [evidenceGraphChunkId],
      extractorVersion,
      metadata: { description: relation.description },
    }));
    if (result.ok) stats.relations_extracted += 1;
    else stats.relations_rejected += 1;
  }

  // ── 5. Decisioni estratte ──
  for (const decision of extraction.data.decisions) {
    if (!knownChromaChunkIds.has(decision.evidence_chunk_id)) continue;
    const did = decisionId(namespace, decision.statement);
    const evidenceGraphChunkId = chunkGraphIds.get(decision.evidence_chunk_id);

    // eslint-disable-next-line no-await-in-loop
    noteFailure(await graphRepo.upsertNode('Decision', {
      id: did,
      namespace,
      type: 'decision',
      name: decision.statement,
      status: decision.status,
      confidence: decision.confidence,
      metadata: { evidence_chunk_id: decision.evidence_chunk_id },
    }));
    // eslint-disable-next-line no-await-in-loop
    noteFailure(await graphRepo.upsertRelation({
      fromLabel: 'Decision',
      fromId: did,
      toLabel: 'Chunk',
      toId: evidenceGraphChunkId,
      type: 'DERIVED_FROM',
      namespace,
      confidence: decision.confidence,
      sourceChunkIds: [evidenceGraphChunkId],
      extractorVersion,
    }));
    stats.decisions_extracted += 1;

    if (decision.supersedes) {
      const oldId = decisionId(namespace, decision.supersedes);
      // eslint-disable-next-line no-await-in-loop
      const oldExisting = await graphRepo.findEntity(namespace, oldId, 'Decision');
      if (!oldExisting) {
        // Crea uno stub: l'arco SUPERSEDES deve avere un target valido, ma non
        // inventiamo contenuto oltre al riferimento testuale gia' fornito.
        // eslint-disable-next-line no-await-in-loop
        noteFailure(await graphRepo.upsertNode('Decision', {
          id: oldId, namespace, type: 'decision', name: decision.supersedes, status: 'historical', confidence: 0,
          metadata: { stub: true },
        }));
      } else if (oldExisting.status === 'active') {
        // eslint-disable-next-line no-await-in-loop
        noteFailure(await graphRepo.upsertNode('Decision', {
          id: oldId, namespace, type: 'decision', name: oldExisting.name, status: 'superseded',
          confidence: oldExisting.confidence, metadata: oldExisting.metadata,
        }));
      }
      // eslint-disable-next-line no-await-in-loop
      noteFailure(await graphRepo.upsertRelation({
        fromLabel: 'Decision',
        fromId: did,
        toLabel: 'Decision',
        toId: oldId,
        type: 'SUPERSEDES',
        namespace,
        confidence: decision.confidence,
        sourceChunkIds: [evidenceGraphChunkId],
        extractorVersion,
      }));
    }
  }

  metrics.increment('entities_extracted', stats.entities_extracted);
  metrics.increment('relations_extracted', stats.relations_extracted);
  metrics.increment('entity_merges', stats.entity_merges);
  metrics.increment('possible_duplicates', stats.possible_duplicates);

  if (firstFailure) {
    metrics.increment('graph_failures');
    return { ok: false, stage: 'partial', error: firstFailure, stats };
  }

  return { ok: true, stats };
}

function emptyStats() {
  return {
    entities_extracted: 0,
    relations_extracted: 0,
    relations_rejected: 0,
    decisions_extracted: 0,
    entity_merges: 0,
    possible_duplicates: 0,
  };
}
