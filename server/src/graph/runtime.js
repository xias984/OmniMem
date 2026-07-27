/**
 * Punto di composizione del sotto-sistema GraphRAG: assembla Neo4j client,
 * repository, estrattore, coda di indicizzazione, in base ai feature flag.
 *
 * Il client Neo4j e il repository vengono creati SEMPRE, anche quando
 * `OMNIMEM_GRAPHRAG_ENABLED`/`_GRAPH_INDEXING_ENABLED`/`_GRAPH_SHADOW_MODE`
 * sono tutti `false`: la connessione e' lazy (nessun I/O alla costruzione,
 * vedi neo4jClient.js), quindi non c'e' alcun costo quando Neo4j non e'
 * nemmeno configurato. Il motivo per cui NON si torna a un runtime "no-op
 * puro" come prima e' la cancellazione di un namespace (`DELETE
 * /api/topics/:topic`): il grafo puo' essere stato popolato in un run
 * precedente con i flag attivi, e se poi vengono disattivati un topic
 * cancellato dall'utente deve comunque essere ripulito anche li' — altrimenti
 * riattivando GraphRAG in futuro riemergerebbero dati che l'utente ha
 * esplicitamente rimosso. Indicizzazione e retrieval restano invece
 * strettamente gated dai rispettivi flag (`enqueueIndexing` e i controlli in
 * server.js su `enabled`/`shadowMode`): solo la pulizia e' incondizionata.
 */
import { getNeo4jClient } from './neo4jClient.js';
import { GraphRepository } from './graphRepository.js';
import { createExtractor } from './extractor/extractor.js';
import { GraphIndexingQueue } from './indexingQueue.js';
import { indexMemoryIntoGraph } from './dualWrite.js';
import { embedOne } from '../embeddings.js';
import { MetricsCollector } from '../observability/metrics.js';

export function createGraphRuntime(cfg) {
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

  // Coda separata per la cancellazione di un namespace (DELETE /api/topics/:topic):
  // stesso pattern di retry/dead-letter dell'indicizzazione, cosi' un fallimento
  // Neo4j non lascia silenziosamente ChromaDB e il grafo divergenti per sempre.
  const deleteQueue = new GraphIndexingQueue({
    runJob: (job) => graphRepo.deleteNamespace(job.namespace),
    maxRetries: cfg.indexingQueue.maxRetries,
    retryDelayMs: cfg.indexingQueue.retryDelayMs,
    deadLetterPath: cfg.indexingQueue.deleteDeadLetterPath,
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
    /**
     * Accoda la cancellazione di un namespace nel grafo. A differenza di
     * `enqueueIndexing`, NON e' gated da alcun feature flag: gira sempre,
     * anche a GraphRAG completamente disattivato, perche' il grafo puo'
     * essere stato popolato in un run precedente con i flag attivi. Se
     * Neo4j non e' configurato/raggiungibile il job finisce semplicemente
     * in dead-letter (nessun impatto sulla risposta HTTP).
     */
    enqueueNamespaceDeletion(namespace) {
      deleteQueue.enqueue({ namespace }).catch((err) => {
        metrics.increment('graph_failures');
        console.error(`[graph-runtime] enqueue cancellazione namespace fallito: ${err.message}`);
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
