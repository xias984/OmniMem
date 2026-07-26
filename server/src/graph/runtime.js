/**
 * Punto di composizione del sotto-sistema GraphRAG: assembla Neo4j client,
 * repository, estrattore, coda di indicizzazione, in base ai feature flag.
 * Se GraphRAG e' disattivato (default), ritorna un runtime "no-op" cosi'
 * il resto del server puo' chiamarlo incondizionatamente senza `if` sparsi
 * e senza cambiare comportamento rispetto a oggi.
 */
import { getNeo4jClient } from './neo4jClient.js';
import { GraphRepository } from './graphRepository.js';
import { createExtractor } from './extractor/extractor.js';
import { GraphIndexingQueue } from './indexingQueue.js';
import { indexMemoryIntoGraph } from './dualWrite.js';
import { embedOne } from '../embeddings.js';
import { MetricsCollector } from '../observability/metrics.js';

function noopRuntime(reason) {
  return {
    enabled: false,
    indexingEnabled: false,
    shadowMode: false,
    graphRepo: null,
    metrics: new MetricsCollector(),
    reason,
    enqueueIndexing() {},
    async healthCheck() {
      return { healthy: false, reason };
    },
    async close() {},
  };
}

export function createGraphRuntime(cfg) {
  if (!cfg.graphRagEnabled && !cfg.graphIndexingEnabled && !cfg.graphShadowMode) {
    return noopRuntime('GraphRAG disattivato (OMNIMEM_GRAPHRAG_ENABLED=false)');
  }

  const metrics = new MetricsCollector();
  const client = getNeo4jClient(cfg.neo4j);
  const graphRepo = new GraphRepository(client);
  const extractor = cfg.graphIndexingEnabled ? createExtractor(cfg) : { async extract() { return { ok: true, data: { entities: [], relations: [], decisions: [] } }; } };

  const queue = new GraphIndexingQueue({
    runJob: (job) =>
      indexMemoryIntoGraph(job, {
        graphRepo,
        extractor,
        embed: embedOne,
        thresholds: cfg.entityResolution,
        extractorVersion: cfg.extractor.version,
        metrics,
      }),
    maxRetries: cfg.indexingQueue.maxRetries,
    retryDelayMs: cfg.indexingQueue.retryDelayMs,
    deadLetterPath: cfg.indexingQueue.deadLetterPath,
    metrics,
  });

  return {
    enabled: cfg.graphRagEnabled,
    indexingEnabled: cfg.graphIndexingEnabled,
    shadowMode: cfg.graphShadowMode,
    graphRepo,
    extractor,
    metrics,
    config: cfg,
    /** Accoda l'indicizzazione grafo per una memory. No-op se l'indicizzazione e' disattivata. */
    enqueueIndexing(job) {
      if (!cfg.graphIndexingEnabled) return;
      queue.enqueue(job).catch((err) => {
        metrics.increment('graph_failures');
        console.error(`[graph-runtime] enqueue fallito: ${err.message}`);
      });
    },
    async healthCheck() {
      return graphRepo.healthCheck();
    },
    async close() {
      await client.close();
    },
  };
}
