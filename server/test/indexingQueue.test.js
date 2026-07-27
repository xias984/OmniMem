import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphIndexingQueue } from '../src/graph/indexingQueue.js';
import { InMemoryGraphRepo } from './support/inMemoryGraphRepo.js';

function silentLogger() {
  return { error() {} };
}

test('esegue il job e ritorna ok senza retry quando va a buon fine subito', async () => {
  let calls = 0;
  const queue = new GraphIndexingQueue({
    runJob: async () => { calls += 1; return { ok: true }; },
    maxRetries: 3,
    retryDelayMs: 1,
    logger: silentLogger(),
    sleep: async () => {},
  });
  await queue.enqueue({ namespace: 'ns', chunks: [] });
  await queue.drain();
  assert.equal(calls, 1);
});

test('ritenta un numero limitato di volte prima di arrendersi', async () => {
  let calls = 0;
  const queue = new GraphIndexingQueue({
    runJob: async () => { calls += 1; return { ok: false, error: new Error('boom') }; },
    maxRetries: 2,
    retryDelayMs: 1,
    logger: silentLogger(),
    sleep: async () => {},
  });
  await queue.enqueue({ namespace: 'ns', chunks: [] });
  await queue.drain();
  assert.equal(calls, 3); // tentativo iniziale + 2 retry
});

test('un job non riuscito finisce nella dead-letter con la ragione del fallimento', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimem-dlq-'));
  const deadLetterPath = join(dir, 'dead-letter.jsonl');
  const queue = new GraphIndexingQueue({
    runJob: async () => ({ ok: false, error: new Error('estrazione non valida') }),
    maxRetries: 0,
    retryDelayMs: 1,
    deadLetterPath,
    logger: silentLogger(),
    sleep: async () => {},
  });
  await queue.enqueue({ namespace: 'ns', memory: { sourceUrl: 'x' }, chunks: [{ id: 'c1' }] });
  await queue.drain();

  const content = await readFile(deadLetterPath, 'utf8');
  const entry = JSON.parse(content.trim());
  assert.equal(entry.namespace, 'ns');
  assert.deepEqual(entry.chunkIds, ['c1']);
  assert.match(entry.error, /estrazione non valida/);

  await rm(dir, { recursive: true, force: true });
});

test('un job che lancia un eccezione viene comunque gestito senza propagarsi', async () => {
  const queue = new GraphIndexingQueue({
    runJob: async () => { throw new Error('crash improvviso'); },
    maxRetries: 1,
    retryDelayMs: 1,
    logger: silentLogger(),
    sleep: async () => {},
  });
  await assert.doesNotReject(async () => {
    await queue.enqueue({ namespace: 'ns', chunks: [] });
    await queue.drain();
  });
});

test('i job vengono processati in sequenza, uno alla volta', async () => {
  const order = [];
  const queue = new GraphIndexingQueue({
    runJob: async (job) => {
      order.push(`start:${job.id}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${job.id}`);
      return { ok: true };
    },
    maxRetries: 0,
    logger: silentLogger(),
  });
  queue.enqueue({ id: 1 });
  queue.enqueue({ id: 2 });
  await queue.drain();
  assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2']);
});

test('la stessa coda riusata per la cancellazione di un namespace ritenta e finisce in dead-letter se il repository fallisce sempre', async () => {
  const graphRepo = new InMemoryGraphRepo();
  let calls = 0;
  const brokenRepo = {
    ...graphRepo,
    deleteNamespace: async () => { calls += 1; return { ok: false, error: new Error('Neo4j giu') }; },
  };
  const queue = new GraphIndexingQueue({
    runJob: (job) => brokenRepo.deleteNamespace(job.namespace),
    maxRetries: 2,
    retryDelayMs: 1,
    logger: silentLogger(),
    sleep: async () => {},
  });
  const result = await queue.enqueue({ namespace: 'hearthfall' });
  assert.equal(result.ok, false);
  assert.equal(calls, 3); // tentativo iniziale + 2 retry
});

test('la cancellazione di un namespace riesce quando il repository funziona', async () => {
  const graphRepo = new InMemoryGraphRepo();
  await graphRepo.upsertNode('Entity', { id: 'e1', namespace: 'hearthfall', name: 'Unity' });
  const queue = new GraphIndexingQueue({
    runJob: (job) => graphRepo.deleteNamespace(job.namespace),
    maxRetries: 0,
    logger: silentLogger(),
  });
  const result = await queue.enqueue({ namespace: 'hearthfall' });
  assert.equal(result.ok, true);
  assert.equal(await graphRepo.findEntity('hearthfall', 'e1'), null);
});
