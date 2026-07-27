#!/usr/bin/env node
/**
 * Bootstrap dello schema Neo4j (constraint + indici) e health check.
 * Uso: node src/cli/graphBootstrapCli.js
 */
import { getNeo4jClient } from '../graph/neo4jClient.js';
import { GraphRepository } from '../graph/graphRepository.js';
import { config } from '../config.js';

async function main() {
  const client = getNeo4jClient(config.neo4j);
  const health = await client.healthCheck();
  console.log('[graph-bootstrap] health check:', health);
  if (!health.healthy) {
    console.error(`[graph-bootstrap] Neo4j non raggiungibile su ${config.neo4j.uri}. Interrompo.`);
    process.exitCode = 1;
    return;
  }

  const repo = new GraphRepository(client);
  const results = await repo.bootstrapSchema();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok' : 'ERRORE'}  ${r.statement.split('\n')[0].trim()}${r.error ? ` — ${r.error}` : ''}`);
  }
  console.log(`[graph-bootstrap] completato: ${results.length - failed.length}/${results.length} statement applicati`);
  await client.close();
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[graph-bootstrap] errore fatale:', err);
  process.exitCode = 1;
});
