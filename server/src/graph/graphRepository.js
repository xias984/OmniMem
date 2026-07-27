/**
 * Repository che incapsula Neo4j. Il resto dell'applicazione non deve mai
 * importare `neo4j-driver` o scrivere Cypher: passa sempre da qui.
 *
 * Le uniche stringhe interpolate direttamente nelle query (label, tipo di
 * relazione) sono sempre validate contro gli enum di schema.js PRIMA
 * dell'interpolazione: non arrivano mai da input utente/LLM non validato.
 */
import { isValidLabel, isValidRelationType, bootstrapStatements } from './schema.js';
import { normalizeName } from '../ids.js';
import { QUERY_RESOLVABLE_LABELS } from './entityTypeMapping.js';

function assertLabel(label) {
  if (!isValidLabel(label)) throw new Error(`Label grafo non valida: ${label}`);
}

function assertLabels(labels) {
  for (const label of labels) assertLabel(label);
}

function assertRelationType(type) {
  if (!isValidRelationType(type)) throw new Error(`Tipo di relazione non valido: ${type}`);
}

/**
 * Le letture non devono MAI confondere "nessun risultato" con "la query e'
 * fallita" (Neo4j giu', timeout...): un errore silenziosamente convertito in
 * `[]` avrebbe fatto proseguire il retrieval ibrido come se il grafo fosse
 * vuoto, invece di attivare il fallback al solo vettoriale. Qui si lancia
 * sempre, cosi' chi chiama (hybridRetriever, dualWrite via entityResolver)
 * puo' intercettare e reagire esplicitamente.
 */
function unwrapOrThrow(result, context) {
  if (!result.ok) {
    throw new Error(`Query Neo4j fallita (${context}): ${result.error?.message ?? 'errore sconosciuto'}`);
  }
  return result.records;
}

/** Clausola "n:Label1 OR n:Label2 ..." per una lista di label candidate (gia' validate). */
function anyLabelClause(variable, labels) {
  return labels.map((l) => `${variable}:${l}`).join(' OR ');
}

function toRecordObject(record, key) {
  const value = record.get(key);
  if (value === null || value === undefined) return null;
  return { ...value.properties };
}

function parseMetadata(node) {
  if (!node) return node;
  if (typeof node.metadata === 'string') {
    try {
      node.metadata = JSON.parse(node.metadata);
    } catch {
      node.metadata = {};
    }
  }
  return node;
}

export class GraphRepository {
  /**
   * @param {import('./neo4jClient.js').Neo4jClient} client
   */
  constructor(client) {
    this.client = client;
  }

  async healthCheck() {
    return this.client.healthCheck();
  }

  /** Crea (idempotente) constraint e indici di base. */
  async bootstrapSchema() {
    const statements = bootstrapStatements();
    const results = [];
    for (const statement of statements) {
      const result = await this.client.run(statement, {}, { mode: 'WRITE' });
      results.push({ statement, ok: result.ok, error: result.error?.message });
    }
    return results;
  }

  /**
   * Upsert generico di un nodo. `props` deve contenere almeno `id` e
   * `namespace`. `metadata` (oggetto) viene serializzato in JSON perche'
   * Neo4j non supporta mappe annidate come proprieta'.
   */
  async upsertNode(label, props) {
    assertLabel(label);
    if (!props?.id || !props?.namespace) {
      throw new Error('upsertNode richiede almeno { id, namespace }');
    }

    const { id, namespace, metadata, aliases, ...rest } = props;
    const flatProps = { ...rest };
    if (rest.name) flatProps.name_normalized = normalizeName(rest.name);
    const metadataJson = JSON.stringify(metadata ?? {});
    const aliasList = Array.isArray(aliases) ? aliases : [];
    // Gli alias si confrontano sempre in forma normalizzata (findEntitiesByAlias
    // cerca in aliases_normalized): un alias salvato con casing/punteggiatura
    // originali ("Neo4J") non troverebbe mai match con una query normalizzata
    // ("neo4j") se confrontato cosi' com'e'.
    const aliasesNormalized = aliasList.map((a) => normalizeName(a));

    const cypher = `
      MERGE (n:${label} {namespace: $namespace, id: $id})
      ON CREATE SET n += $flatProps, n.aliases = $aliases, n.aliases_normalized = $aliasesNormalized, n.metadata = $metadataJson, n.created_at = $now, n.updated_at = $now
      ON MATCH SET n += $flatProps, n.aliases = $aliases, n.aliases_normalized = $aliasesNormalized, n.metadata = $metadataJson, n.updated_at = $now
      RETURN n
    `;
    const result = await this.client.run(cypher, {
      namespace,
      id,
      flatProps,
      aliases: aliasList,
      aliasesNormalized,
      metadataJson,
      now: new Date().toISOString(),
    });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, node: parseMetadata(toRecordObject(result.records[0], 'n')) };
  }

  /**
   * Upsert idempotente di una relazione. Una singola relazione per (a, tipo, b)
   * viene mantenuta: le chiamate successive aggiornano confidence (max) e
   * source_chunk_ids (unione), non creano archi duplicati.
   */
  async upsertRelation({ fromLabel, fromId, toLabel, toId, type, namespace, confidence = 0, sourceChunkIds = [], extractorVersion, metadata }) {
    try {
      assertLabel(fromLabel);
      assertLabel(toLabel);
      assertRelationType(type);
    } catch (error) {
      return { ok: false, error };
    }
    if (!sourceChunkIds || sourceChunkIds.length === 0) {
      // Una relazione priva di evidenza non e' considerata affidabile: non si upserta.
      return { ok: false, error: new Error('sourceChunkIds vuoto: relazione senza evidenza rifiutata') };
    }

    const existing = await this.findRelation(namespace, fromId, type, toId);
    const mergedChunkIds = Array.from(new Set([...(existing?.source_chunk_ids ?? []), ...sourceChunkIds]));
    const mergedConfidence = Math.max(existing?.confidence ?? 0, confidence ?? 0);
    const metadataJson = JSON.stringify(metadata ?? {});

    const cypher = `
      MATCH (a:${fromLabel} {namespace: $namespace, id: $fromId})
      MATCH (b:${toLabel} {namespace: $namespace, id: $toId})
      MERGE (a)-[r:${type}]->(b)
      SET r.confidence = $confidence,
          r.source_chunk_ids = $sourceChunkIds,
          r.extractor_version = $extractorVersion,
          r.metadata = $metadataJson,
          r.created_at = coalesce(r.created_at, $now),
          r.updated_at = $now
      RETURN r
    `;
    const result = await this.client.run(cypher, {
      namespace,
      fromId,
      toId,
      confidence: mergedConfidence,
      sourceChunkIds: mergedChunkIds,
      extractorVersion: extractorVersion ?? 'unknown',
      metadataJson,
      now: new Date().toISOString(),
    });
    if (!result.ok) return { ok: false, error: result.error };
    if (result.records.length === 0) {
      return { ok: false, error: new Error('Nodi sorgente/destinazione della relazione non trovati') };
    }
    return { ok: true, relation: parseMetadata(toRecordObject(result.records[0], 'r')) };
  }

  async findRelation(namespace, fromId, type, toId) {
    assertRelationType(type);
    const cypher = `
      MATCH (a {namespace: $namespace, id: $fromId})-[r:${type}]->(b {namespace: $namespace, id: $toId})
      RETURN r LIMIT 1
    `;
    const result = await this.client.run(cypher, { namespace, fromId, toId }, { mode: 'READ' });
    const records = unwrapOrThrow(result, 'findRelation');
    if (records.length === 0) return null;
    return parseMetadata(toRecordObject(records[0], 'r'));
  }

  /** Ricerca esatta per chiave canonica (namespace + type + id gia' calcolato altrove). */
  async findEntity(namespace, id, label = 'Entity') {
    assertLabel(label);
    const cypher = `MATCH (n:${label} {namespace: $namespace, id: $id}) RETURN n LIMIT 1`;
    const result = await this.client.run(cypher, { namespace, id }, { mode: 'READ' });
    const records = unwrapOrThrow(result, 'findEntity');
    if (records.length === 0) return null;
    return parseMetadata(toRecordObject(records[0], 'n'));
  }

  /**
   * Ricerca per alias o nome normalizzato (case/punteggiatura-insensitive).
   * `label` accetta una singola label (uso tipico in fase di indicizzazione,
   * dove il tipo concreto e' gia' noto) oppure un array di label candidate
   * (uso tipico in fase di query, dove un'entita' citata nel testo puo'
   * essere un Project, un Tool, un Task... non solo un Entity generico).
   */
  async findEntitiesByAlias(namespace, alias, { label = 'Entity', limit = 50 } = {}) {
    const labels = Array.isArray(label) ? label : [label];
    assertLabels(labels);
    const normalized = normalizeName(alias);
    const cypher = `
      MATCH (n {namespace: $namespace})
      WHERE (${anyLabelClause('n', labels)})
        AND (n.name_normalized = $normalized OR $normalized IN n.aliases_normalized)
      RETURN n LIMIT $limit
    `;
    const result = await this.client.run(
      cypher,
      { namespace, normalized, limit: neo4jInt(limit) },
      { mode: 'READ' }
    );
    const records = unwrapOrThrow(result, 'findEntitiesByAlias');
    return records.map((r) => parseMetadata(toRecordObject(r, 'n')));
  }

  /** Tutte le entita' dello stesso tipo in un namespace (per fuzzy matching). */
  async findEntitiesByType(namespace, entityType, { label = 'Entity', limit = 200 } = {}) {
    assertLabel(label);
    const cypher = `
      MATCH (n:${label} {namespace: $namespace, type: $entityType})
      RETURN n LIMIT $limit
    `;
    const result = await this.client.run(
      cypher,
      { namespace, entityType, limit: neo4jInt(limit) },
      { mode: 'READ' }
    );
    const records = unwrapOrThrow(result, 'findEntitiesByType');
    return records.map((r) => parseMetadata(toRecordObject(r, 'n')));
  }

  async findChunksByEntity(namespace, entityId, { limit = 50 } = {}) {
    const cypher = `
      MATCH (c:Chunk {namespace: $namespace})-[:MENTIONS]->(e {namespace: $namespace, id: $entityId})
      RETURN DISTINCT c LIMIT $limit
    `;
    const result = await this.client.run(
      cypher,
      { namespace, entityId, limit: neo4jInt(limit) },
      { mode: 'READ' }
    );
    const records = unwrapOrThrow(result, 'findChunksByEntity');
    return records.map((r) => parseMetadata(toRecordObject(r, 'c')));
  }

  /**
   * Elimina tutti i nodi (e le relazioni collegate) di un namespace, a
   * prescindere dalla label. Usato quando un topic viene cancellato da
   * ChromaDB (`DELETE /api/topics/:topic`): senza questo, il grafo
   * continuerebbe a esporre entita'/decisioni di un topic che l'utente ha
   * esplicitamente rimosso.
   */
  async deleteNamespace(namespace) {
    const cypher = `MATCH (n {namespace: $namespace}) DETACH DELETE n`;
    const result = await this.client.run(cypher, { namespace }, { mode: 'WRITE' });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true };
  }

  /**
   * Espande il grafo a partire da un set di chunk seed, fino a `maxHops`
   * salti (massimo 2, mai variable-length illimitato). Ogni hop e' una
   * query esplicita e separata, cosi' possiamo tracciare la distanza reale
   * di ogni nodo scoperto (serve alla graph_proximity dello scoring) e gli
   * estremi precisi di ogni relazione, con LIMIT espliciti su entrambi i
   * livelli.
   */
  async expandFromChunks(namespace, chunkIds, options = {}) {
    return this.expandFromSeeds('Chunk', namespace, chunkIds, options);
  }

  /**
   * Le entita' seed possono avere label diverse da `Entity` (Project, Tool,
   * Task, File, Session, Source sono tutte label concrete usate in fase di
   * indicizzazione): un vincolo `:Entity` fisso qui perderebbe silenziosamente
   * qualsiasi seed tipizzato.
   */
  async expandFromEntities(namespace, entityIds, options = {}) {
    return this.expandFromSeeds(QUERY_RESOLVABLE_LABELS, namespace, entityIds, options);
  }

  /** @param {string|string[]} seedLabel una label singola o un elenco di label candidate */
  async expandFromSeeds(seedLabel, namespace, seedIds, { maxHops = 2, maxNodes = 100, maxEdges = 300 } = {}) {
    const seedLabels = Array.isArray(seedLabel) ? seedLabel : [seedLabel];
    assertLabels(seedLabels);
    if (!seedIds || seedIds.length === 0) return { nodes: [], edges: [] };
    const hops = Math.max(1, Math.min(maxHops, 2));
    const seedClause = anyLabelClause('seed', seedLabels);

    const hop1Cypher = `
      MATCH (seed {namespace: $namespace})
      WHERE (${seedClause}) AND seed.id IN $seedIds
      MATCH (seed)-[r1]-(n1 {namespace: $namespace})
      RETURN DISTINCT n1 AS node, r1 AS rel, startNode(r1).id AS relFrom, endNode(r1).id AS relTo, 1 AS hop
      LIMIT $maxEdges
    `;
    const hop1 = await this.client.run(hop1Cypher, { namespace, seedIds, maxEdges: neo4jInt(maxEdges) }, { mode: 'READ' });
    const hop1Records = unwrapOrThrow(hop1, 'expandFromSeeds:hop1');

    let hop2Records = [];
    if (hops >= 2) {
      const hop2Cypher = `
        MATCH (seed {namespace: $namespace})
        WHERE (${seedClause}) AND seed.id IN $seedIds
        MATCH (seed)-[]-(n1 {namespace: $namespace})
        MATCH (n1)-[r2]-(n2 {namespace: $namespace})
        WHERE NOT n2.id IN $seedIds
        RETURN DISTINCT n2 AS node, r2 AS rel, startNode(r2).id AS relFrom, endNode(r2).id AS relTo, 2 AS hop
        LIMIT $maxEdges
      `;
      const hop2 = await this.client.run(hop2Cypher, { namespace, seedIds, maxEdges: neo4jInt(maxEdges) }, { mode: 'READ' });
      hop2Records = unwrapOrThrow(hop2, 'expandFromSeeds:hop2');
    }

    return collectExpansion([...hop1Records, ...hop2Records], maxNodes);
  }

  async findActiveDecisions(namespace, { limit = 50 } = {}) {
    const cypher = `
      MATCH (d:Decision {namespace: $namespace, status: 'active'})
      RETURN d ORDER BY d.updated_at DESC LIMIT $limit
    `;
    const result = await this.client.run(cypher, { namespace, limit: neo4jInt(limit) }, { mode: 'READ' });
    const records = unwrapOrThrow(result, 'findActiveDecisions');
    return records.map((r) => parseMetadata(toRecordObject(r, 'd')));
  }

  async findSupersededDecisions(namespace, { limit = 50 } = {}) {
    const cypher = `
      MATCH (d:Decision {namespace: $namespace, status: 'superseded'})
      OPTIONAL MATCH (newer:Decision {namespace: $namespace})-[:SUPERSEDES]->(d)
      RETURN d, collect(newer) AS supersededBy ORDER BY d.updated_at DESC LIMIT $limit
    `;
    const result = await this.client.run(cypher, { namespace, limit: neo4jInt(limit) }, { mode: 'READ' });
    const records = unwrapOrThrow(result, 'findSupersededDecisions');
    return records.map((r) => ({
      ...parseMetadata(toRecordObject(r, 'd')),
      supersededBy: (r.get('supersededBy') ?? []).map((n) => parseMetadata({ ...n.properties })),
    }));
  }

  async findContradictions(namespace, { limit = 50 } = {}) {
    const cypher = `
      MATCH (a {namespace: $namespace})-[r:CONTRADICTS]->(b {namespace: $namespace})
      RETURN a, r, b LIMIT $limit
    `;
    const result = await this.client.run(cypher, { namespace, limit: neo4jInt(limit) }, { mode: 'READ' });
    const records = unwrapOrThrow(result, 'findContradictions');
    return records.map((r) => ({
      a: parseMetadata(toRecordObject(r, 'a')),
      relation: parseMetadata(toRecordObject(r, 'r')),
      b: parseMetadata(toRecordObject(r, 'b')),
    }));
  }
}

function neo4jInt(n) {
  // neo4j-driver richiede interi JS "safe"; i limiti qui sono sempre piccoli.
  return Math.trunc(n);
}

/**
 * @param {import('neo4j-driver').Record[]} records righe con node/rel/relFrom/relTo/hop
 */
function collectExpansion(records, maxNodes) {
  const nodesById = new Map();
  const edgesByKey = new Map();

  for (const record of records) {
    const node = record.get('node');
    const rel = record.get('rel');
    const hop = typeof record.get('hop')?.toNumber === 'function' ? record.get('hop').toNumber() : record.get('hop');

    if (node) {
      const id = node.properties.id;
      const existing = nodesById.get(id);
      const parsed = parseMetadata({ ...node.properties, __labels: node.labels, hop });
      if (!existing) {
        if (nodesById.size < maxNodes) nodesById.set(id, parsed);
      } else if (hop < existing.hop) {
        existing.hop = hop;
      }
    }
    if (rel) {
      const relFrom = record.get('relFrom');
      const relTo = record.get('relTo');
      const key = `${relFrom}::${rel.type}::${relTo}`;
      if (!edgesByKey.has(key)) {
        edgesByKey.set(key, {
          type: rel.type,
          fromId: relFrom,
          toId: relTo,
          hop,
          ...parseMetadata({ ...rel.properties }),
        });
      }
    }
  }
  return { nodes: [...nodesById.values()], edges: [...edgesByKey.values()] };
}
