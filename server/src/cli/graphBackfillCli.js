#!/usr/bin/env node
/**
 * CLI di backfill: indicizza nel knowledge graph i chunk gia' presenti in
 * ChromaDB. Uso:
 *
 *   node src/cli/graphBackfillCli.js
 *   node src/cli/graphBackfillCli.js --namespace=Hearthfall
 *   node src/cli/graphBackfillCli.js --dry-run
 *   node src/cli/graphBackfillCli.js --limit=100
 *   node src/cli/graphBackfillCli.js --since=2026-01-01 --until=2026-06-01
 *   node src/cli/graphBackfillCli.js --extractor-version=v2 --batch-size=100
 *
 * Equivalente concettuale a "omnimem graph backfill [opzioni]" richiesto
 * dal task: qui e' uno script Node standalone (nessun framework CLI e'
 * presente nel repo, quindi non se ne introduce uno solo per questo).
 */
import { getCollection } from '../chroma.js';
import { getNeo4jClient } from '../graph/neo4jClient.js';
import { GraphRepository } from '../graph/graphRepository.js';
import { createExtractor } from '../graph/extractor/extractor.js';
import { embedOne } from '../embeddings.js';
import { runBackfill } from '../graph/backfill.js';
import { config } from '../config.js';

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    const match = arg.match(/^--([a-z-]+)(?:=(.*))?$/i);
    if (!match) continue;
    const key = match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    options[key] = match[2] ?? true;
  }
  return options;
}

function toTimestamp(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? Number(value) : ts;
}

/** Pagina i chunk di ChromaDB filtrati per topic (namespace) e li normalizza. */
function makeChromaFetcher(collection) {
  return async ({ namespace, offset, limit }) => {
    const where = namespace ? { topic: { $eq: namespace } } : undefined;
    const results = await collection.get({
      where,
      include: ['documents', 'metadatas'],
      limit,
      offset,
    });
    const ids = results.ids ?? [];
    const docs = results.documents ?? [];
    const metas = results.metadatas ?? [];
    const items = ids.map((id, i) => ({ id, document: docs[i], metadata: metas[i] ?? {} }));
    return { items, hasMore: items.length === limit };
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = {
    namespace: args.namespace ?? null,
    dryRun: Boolean(args.dryRun),
    limit: args.limit ? Number(args.limit) : Infinity,
    since: toTimestamp(args.since),
    until: toTimestamp(args.until),
    batchSize: args.batchSize ? Number(args.batchSize) : config.backfill.defaultBatchSize,
    extractorVersion: args.extractorVersion ?? config.extractor.version,
  };

  const collection = await getCollection();
  const client = getNeo4jClient(config.neo4j);
  const health = await client.healthCheck();
  if (!health.healthy && !options.dryRun) {
    console.error(`[graph-backfill] Neo4j non raggiungibile (${health.error}). Interrompo (usa --dry-run per una simulazione senza scritture).`);
    process.exitCode = 1;
    return;
  }

  const graphRepo = new GraphRepository(client);
  const extractor = config.graphIndexingEnabled ? createExtractor(config) : { async extract() { return { ok: true, data: { entities: [], relations: [], decisions: [] } }; } };

  if (!options.dryRun) {
    await graphRepo.bootstrapSchema();
  }

  const summary = await runBackfill(options, {
    fetchChunksPage: makeChromaFetcher(collection),
    graphRepo,
    extractor,
    embed: embedOne,
    thresholds: config.entityResolution,
    checkpointPath: config.backfill.checkpointPath,
    logger: console,
  });

  console.log('[graph-backfill] riepilogo finale:', JSON.stringify(summary, null, 2));
  await client.close();
}

main().catch((err) => {
  console.error('[graph-backfill] errore fatale:', err);
  process.exitCode = 1;
});
