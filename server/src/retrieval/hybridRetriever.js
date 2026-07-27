/**
 * Retriever ibrido: instrada la query (router), esegue vector retrieval
 * (sempre) ed eventualmente graph retrieval (in base alla strategia),
 * fonde e riordina i risultati con lo scoring configurabile, con fallback
 * sicuro al solo vettoriale se il grafo non e' disponibile o fallisce.
 */
import { classifyQuery, usesGraph } from './router.js';
import { vectorRetrieve } from './vectorRetriever.js';
import { graphRetrieve } from './graphRetriever.js';
import { hybridScore, computeGraphProximity, computeRecency } from './scoring.js';
import { chunkId } from '../ids.js';

function noopMetrics() {
  return { increment() {}, time: async (_n, fn) => fn() };
}

/**
 * @param {{queryText:string, namespace:string, k?:number, seedChunks?:object[]}} params
 *        `seedChunks`, se gia' disponibili (es. `/api/query` ha gia' fatto
 *        embed+query per la risposta vettoriale), evita una seconda
 *        chiamata embed/Chroma identica: il chiamante passa direttamente i
 *        risultati vettoriali gia' calcolati.
 * @param {{vector:{embed?:Function, collection:object, distanceThreshold?:number}, graphRepo?:object, graphEnabled:boolean,
 *          graphRetrieval:object, scoring:object, metrics?:object, logger?:object}} deps
 */
export async function hybridRetrieve({ queryText, namespace, k = 6, seedChunks: precomputedSeedChunks }, deps) {
  const { vector, graphRepo, graphEnabled, graphRetrieval, scoring, metrics = noopMetrics(), logger = console } = deps;
  const { category, strategy } = classifyQuery(queryText);

  const seedChunks = precomputedSeedChunks
    ?? (await metrics.time('vector_retrieval_duration', () => vectorRetrieve({ queryText, namespace, k }, vector)));

  const base = {
    category,
    strategy,
    usedGraph: false,
    fallbackToVector: false,
    decisions: [],
    contradictions: [],
    entities: [],
    nodes: [],
    edges: [],
  };

  if (!usesGraph(strategy) || !graphEnabled || !graphRepo) {
    const results = scoreVectorOnly(seedChunks, scoring);
    metrics.increment('retrieved_chunks', results.length);
    return { ...base, results };
  }

  let graphResult;
  try {
    graphResult = await metrics.time('graph_retrieval_duration', () =>
      graphRetrieve({ queryText, namespace, seedChunks }, { graphRepo, ...graphRetrieval })
    );
  } catch (err) {
    logger.error?.(`[hybrid-retriever] graph retrieval fallito, fallback al solo vettoriale: ${err.message}`);
    metrics.increment('graph_failures');
    metrics.increment('fallback_to_vector');
    const results = scoreVectorOnly(seedChunks, scoring);
    metrics.increment('retrieved_chunks', results.length);
    return { ...base, fallbackToVector: true, results };
  }

  metrics.increment('graph_expansion_nodes', graphResult.nodes.length);
  metrics.increment('graph_expansion_edges', graphResult.edges.length);

  const results = await metrics.time('hybrid_retrieval_duration', () =>
    mergeAndScore({ seedChunks, graphResult, namespace, scoring, collection: vector?.collection, logger })
  );
  metrics.increment('retrieved_chunks', results.length);

  return {
    ...base,
    usedGraph: true,
    results,
    decisions: graphResult.decisionNodes,
    contradictions: graphResult.contradictions,
    entities: graphResult.entityNodes,
    nodes: graphResult.nodes,
    edges: graphResult.edges,
  };
}

function scoreVectorOnly(seedChunks, scoring) {
  return seedChunks
    .map((chunk) => {
      const components = {
        vectorSimilarity: chunk.similarity,
        graphProximity: 0,
        relationConfidence: 0,
        recency: computeRecency(chunk.metadata?.timestamp),
        namespaceRelevance: 1,
      };
      const score = hybridScore(components, {}, scoring.weights, scoring.penalties);
      return { ...chunk, score, components, source: 'vector' };
    })
    .sort((a, b) => b.score - a.score);
}

async function mergeAndScore({ seedChunks, graphResult, namespace, scoring, collection, logger }) {
  const byChromaId = new Map();

  for (const chunk of seedChunks) {
    byChromaId.set(chunk.id, {
      id: chunk.id,
      text: chunk.text,
      metadata: chunk.metadata,
      similarity: chunk.similarity,
      hop: 0,
      relationConfidence: 0,
      sources: new Set(['vector']),
    });
  }

  const relationConfidenceByChunkGraphId = new Map();
  for (const edge of graphResult.edges) {
    const conf = edge.confidence ?? 0;
    for (const nodeId of [edge.fromId, edge.toId]) {
      relationConfidenceByChunkGraphId.set(nodeId, Math.max(relationConfidenceByChunkGraphId.get(nodeId) ?? 0, conf));
    }
  }

  for (const node of graphResult.evidenceChunkNodes) {
    const chromaId = node.metadata?.chroma_id;
    if (!chromaId) continue;
    const existing = byChromaId.get(chromaId);
    const relationConfidence = relationConfidenceByChunkGraphId.get(node.id) ?? 0;
    if (existing) {
      existing.hop = Math.min(existing.hop, node.hop ?? 2);
      existing.relationConfidence = Math.max(existing.relationConfidence, relationConfidence);
      existing.sources.add('graph');
    } else {
      byChromaId.set(chromaId, {
        id: chromaId,
        // Placeholder: il nodo Chunk conserva solo i primi 280 caratteri
        // (`summary`). Il testo completo viene recuperato subito sotto da
        // ChromaDB tramite `chroma_id`, prima che il risultato sia finale.
        text: node.summary ?? '',
        metadata: { timestamp: node.metadata?.timestamp },
        similarity: 0,
        hop: node.hop ?? 2,
        relationConfidence,
        sources: new Set(['graph']),
      });
    }
  }

  // I chunk scoperti SOLO tramite espansione grafo hanno per ora solo il
  // riepilogo troncato del nodo Chunk (e nessuna provenienza: il nodo Chunk
  // non porta source_url/platform/file_path, quelli vivono sulla Memory).
  // Recuperiamo da ChromaDB, in un'unica chiamata batched, sia il documento
  // completo (fino a 800 caratteri) sia i metadata originali: senza questi
  // ultimi, groupAndFormatChunks li classificherebbe tutti come "unknown"
  // e senza fonte, perche' il solo `{ timestamp }` non basta.
  const graphOnlyIds = [...byChromaId.values()]
    .filter((c) => c.sources.has('graph') && !c.sources.has('vector'))
    .map((c) => c.id);
  if (graphOnlyIds.length > 0 && collection) {
    try {
      const full = await collection.get({ ids: graphOnlyIds, include: ['documents', 'metadatas'] });
      const fullIds = full.ids ?? [];
      const fullDocs = full.documents ?? [];
      const fullMetas = full.metadatas ?? [];
      fullIds.forEach((id, i) => {
        const candidate = byChromaId.get(id);
        if (!candidate) return;
        if (fullDocs[i]) candidate.text = fullDocs[i];
        if (fullMetas[i]) candidate.metadata = { ...candidate.metadata, ...fullMetas[i] };
      });
    } catch (err) {
      logger?.error?.(`[hybrid-retriever] impossibile recuperare testo/metadati completi dei chunk graph-only: ${err.message}`);
    }
  }

  const results = [...byChromaId.values()].map((candidate) => {
    const components = {
      vectorSimilarity: candidate.similarity ?? 0,
      graphProximity: computeGraphProximity(candidate.hop),
      relationConfidence: candidate.relationConfidence ?? 0,
      recency: computeRecency(candidate.metadata?.timestamp),
      namespaceRelevance: 1,
    };
    const flags = { missingEvidence: candidate.relationConfidence === 0 && candidate.sources.has('graph') && !candidate.sources.has('vector') };
    const score = hybridScore(components, flags, scoring.weights, scoring.penalties);
    return {
      id: candidate.id,
      text: candidate.text,
      metadata: candidate.metadata,
      score,
      components,
      source: [...candidate.sources].join('+'),
    };
  });

  return results.sort((a, b) => b.score - a.score);
}

// Esportato per riuso/test isolati (es. verificare la chiave di dedup coerente con dualWrite).
export { chunkId };
