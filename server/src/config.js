/**
 * Configurazione centrale per la parte GraphRAG di OmniMem.
 * Tutti i valori sono letti da variabili d'ambiente con default prudenti
 * (GraphRAG spento) cosi' il comportamento esistente non cambia mai
 * a meno di un'attivazione esplicita.
 */

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'on', 'yes'].includes(String(value).toLowerCase());
}

function num(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env) {
  return {
    // ── Feature flags ──────────────────────────────────────────────────
    graphRagEnabled: bool(env.OMNIMEM_GRAPHRAG_ENABLED, false),
    graphIndexingEnabled: bool(env.OMNIMEM_GRAPH_INDEXING_ENABLED, false),
    graphShadowMode: bool(env.OMNIMEM_GRAPH_SHADOW_MODE, false),

    // ── Neo4j ───────────────────────────────────────────────────────────
    neo4j: {
      uri: env.NEO4J_URI ?? 'bolt://localhost:7687',
      username: env.NEO4J_USERNAME ?? 'neo4j',
      password: env.NEO4J_PASSWORD ?? '',
      database: env.NEO4J_DATABASE ?? 'neo4j',
      connectionTimeoutMs: num(env.NEO4J_CONNECTION_TIMEOUT_MS, 5000),
      queryTimeoutMs: num(env.NEO4J_QUERY_TIMEOUT_MS, 8000),
    },

    // ── Structured knowledge extractor ─────────────────────────────────
    extractor: {
      provider: env.OMNIMEM_EXTRACTOR_PROVIDER ?? 'ollama', // 'ollama' | 'none'
      model: env.OMNIMEM_EXTRACTOR_MODEL ?? 'llama3.1',
      version: env.OMNIMEM_EXTRACTOR_VERSION ?? 'v1',
      maxRetries: num(env.OMNIMEM_EXTRACTOR_MAX_RETRIES, 1),
      timeoutMs: num(env.OMNIMEM_EXTRACTOR_TIMEOUT_MS, 30000),
    },

    // ── Entity resolution ───────────────────────────────────────────────
    entityResolution: {
      exactMatchThreshold: num(env.OMNIMEM_ER_EXACT_THRESHOLD, 1.0),
      automaticMergeThreshold: num(env.OMNIMEM_ER_AUTO_MERGE_THRESHOLD, 0.93),
      possibleDuplicateThreshold: num(env.OMNIMEM_ER_POSSIBLE_DUPLICATE_THRESHOLD, 0.8),
      semanticCompareEnabled: bool(env.OMNIMEM_ER_SEMANTIC_COMPARE_ENABLED, true),
      maxCandidates: num(env.OMNIMEM_ER_MAX_CANDIDATES, 50),
    },

    // ── Graph retrieval ──────────────────────────────────────────────────
    graphRetrieval: {
      maxHops: num(env.OMNIMEM_GRAPH_MAX_HOPS, 2),
      maxSeedChunks: num(env.OMNIMEM_GRAPH_MAX_SEED_CHUNKS, 8),
      maxExpansionNodes: num(env.OMNIMEM_GRAPH_MAX_EXPANSION_NODES, 100),
      maxExpansionEdges: num(env.OMNIMEM_GRAPH_MAX_EXPANSION_EDGES, 300),
    },

    // ── Hybrid scoring (pesi configurabili, mai hardcoded nella logica) ──
    scoring: {
      weights: {
        vectorSimilarity: num(env.OMNIMEM_SCORE_W_VECTOR, 0.45),
        graphProximity: num(env.OMNIMEM_SCORE_W_GRAPH_PROXIMITY, 0.20),
        relationConfidence: num(env.OMNIMEM_SCORE_W_RELATION_CONFIDENCE, 0.15),
        recency: num(env.OMNIMEM_SCORE_W_RECENCY, 0.10),
        namespaceRelevance: num(env.OMNIMEM_SCORE_W_NAMESPACE, 0.10),
      },
      penalties: {
        outOfNamespace: num(env.OMNIMEM_PENALTY_OUT_OF_NAMESPACE, 1.0),
        missingEvidence: num(env.OMNIMEM_PENALTY_MISSING_EVIDENCE, 0.5),
        supersededDecision: num(env.OMNIMEM_PENALTY_SUPERSEDED, 0.4),
        ambiguousEntity: num(env.OMNIMEM_PENALTY_AMBIGUOUS_ENTITY, 0.2),
        lowConfidence: num(env.OMNIMEM_PENALTY_LOW_CONFIDENCE, 0.2),
        highGraphDistance: num(env.OMNIMEM_PENALTY_HIGH_DISTANCE, 0.15),
        duplicateContent: num(env.OMNIMEM_PENALTY_DUPLICATE, 1.0),
      },
    },

    // ── Context builder ──────────────────────────────────────────────────
    contextBuilder: {
      tokenBudget: num(env.OMNIMEM_CONTEXT_TOKEN_BUDGET, 3000),
      charsPerToken: num(env.OMNIMEM_CONTEXT_CHARS_PER_TOKEN, 4),
    },

    // ── Indexing queue / dual write ──────────────────────────────────────
    indexingQueue: {
      maxRetries: num(env.OMNIMEM_GRAPH_QUEUE_MAX_RETRIES, 3),
      retryDelayMs: num(env.OMNIMEM_GRAPH_QUEUE_RETRY_DELAY_MS, 1000),
      deadLetterPath: env.OMNIMEM_GRAPH_DEAD_LETTER_PATH ?? 'data/graph-dead-letter.jsonl',
    },

    // ── Backfill ──────────────────────────────────────────────────────────
    backfill: {
      checkpointPath: env.OMNIMEM_GRAPH_BACKFILL_CHECKPOINT_PATH ?? 'data/graph-backfill-checkpoint.json',
      defaultBatchSize: num(env.OMNIMEM_GRAPH_BACKFILL_BATCH_SIZE, 50),
    },
  };
}

export const config = loadConfig();
