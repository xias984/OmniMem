import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, renderContextMarkdown } from '../src/context/contextBuilder.js';

const config = { tokenBudget: 1000, charsPerToken: 4 };

function baseRetrieval(overrides = {}) {
  return {
    category: 'semantic',
    usedGraph: false,
    fallbackToVector: false,
    results: [],
    decisions: [],
    contradictions: [],
    entities: [],
    nodes: [],
    edges: [],
    ...overrides,
  };
}

test('separa decisioni attive da quelle storiche/superate', () => {
  const retrieval = baseRetrieval({
    decisions: [
      { id: 'd1', name: 'Usiamo Unity WebGL', status: 'active', confidence: 0.9, metadata: {} },
      { id: 'd2', name: 'Usiamo PixiJS', status: 'superseded', confidence: 0.8, metadata: {} },
    ],
  });
  const context = buildContext({ query: 'q', namespace: 'ns', retrieval }, config);
  assert.equal(context.sections.activeDecisions.length, 1);
  assert.equal(context.sections.historicalDecisions.length, 1);
  assert.equal(context.sections.activeDecisions[0].statement, 'Usiamo Unity WebGL');
  assert.equal(context.sections.historicalDecisions[0].status, 'superseded');
});

test('una decisione superata non appare mai tra quelle attive', () => {
  const retrieval = baseRetrieval({
    decisions: [{ id: 'd1', name: 'Vecchia decisione', status: 'superseded', confidence: 0.5, metadata: {} }],
  });
  const context = buildContext({ query: 'q', namespace: 'ns', retrieval }, config);
  assert.equal(context.sections.activeDecisions.length, 0);
  assert.ok(context.sections.historicalDecisions.some((d) => d.statement === 'Vecchia decisione'));
});

test('collega la decisione superata a quella che l ha sostituita, quando nota', () => {
  const retrieval = baseRetrieval({
    nodes: [{ id: 'd_new', name: 'Nuova decisione' }],
    edges: [{ type: 'SUPERSEDES', fromId: 'd_new', toId: 'd_old' }],
    decisions: [{ id: 'd_old', name: 'Vecchia decisione', status: 'superseded', confidence: 0.5, metadata: {} }],
  });
  const context = buildContext({ query: 'q', namespace: 'ns', retrieval }, config);
  assert.equal(context.sections.historicalDecisions[0].supersededBy, 'Nuova decisione');
});

test('espone le contraddizioni senza risolverle automaticamente', () => {
  const retrieval = baseRetrieval({
    nodes: [{ id: 'a', name: 'Memoria A' }, { id: 'b', name: 'Memoria B' }],
    contradictions: [{ fromId: 'a', toId: 'b', type: 'CONTRADICTS' }],
  });
  const context = buildContext({ query: 'q', namespace: 'ns', retrieval }, config);
  assert.equal(context.sections.contradictions.length, 1);
  assert.equal(context.sections.contradictions[0].resolved, false);
  assert.equal(context.sections.contradictions[0].a, 'Memoria A');
});

test('non include mai due volte lo stesso chunk nei fatti attuali', () => {
  const retrieval = baseRetrieval({
    results: [
      { id: 'c1', text: 'testo', score: 0.9, metadata: {} },
      { id: 'c1', text: 'testo', score: 0.9, metadata: {} },
    ],
  });
  const context = buildContext({ query: 'q', namespace: 'ns', retrieval }, config);
  assert.equal(context.sections.currentFacts.length, 1);
  assert.equal(context.sections.evidence.length, 1);
});

test('rispetta il token budget troncando i contenuti in eccesso', () => {
  const bigText = 'x'.repeat(300); // sotto ai 400 char di budget (100 token * 4 char/token), ma il secondo no
  const retrieval = baseRetrieval({
    results: [
      { id: 'c1', text: bigText, score: 0.9, metadata: {} },
      { id: 'c2', text: bigText, score: 0.8, metadata: {} },
    ],
  });
  const context = buildContext({ query: 'q', namespace: 'ns', retrieval }, { tokenBudget: 100, charsPerToken: 4 });
  assert.equal(context.sections.currentFacts.length, 1); // il secondo non entra nel budget
  assert.equal(context.truncatedByBudget, true);
});

test('include provenienza (source_url, platform, timestamp) per ogni fatto', () => {
  const retrieval = baseRetrieval({
    results: [{ id: 'c1', text: 'testo', score: 0.9, metadata: { source_url: 'https://x', platform: 'ChatGPT', timestamp: 123 } }],
  });
  const context = buildContext({ query: 'q', namespace: 'ns', retrieval }, config);
  assert.deepEqual(context.sections.currentFacts[0].provenance, {
    chunk_id: 'c1', source_url: 'https://x', platform: 'ChatGPT', timestamp: 123,
  });
  assert.equal(context.sections.sources[0].source_url, 'https://x');
});

test('estrae le dipendenze (DEPENDS_ON/BLOCKED_BY) risolvendo i nomi dei nodi', () => {
  const retrieval = baseRetrieval({
    nodes: [{ id: 't1', name: 'Task A' }, { id: 't2', name: 'Task B' }],
    edges: [{ type: 'DEPENDS_ON', fromId: 't1', toId: 't2', confidence: 0.8 }],
  });
  const context = buildContext({ query: 'q', namespace: 'ns', retrieval }, config);
  assert.equal(context.sections.dependencies.length, 1);
  assert.equal(context.sections.dependencies[0].from, 'Task A');
  assert.equal(context.sections.dependencies[0].to, 'Task B');
});

test('renderContextMarkdown produce una stringa non vuota coerente con le sezioni', () => {
  const retrieval = baseRetrieval({
    decisions: [{ id: 'd1', name: 'Decisione attiva', status: 'active', confidence: 0.9, metadata: {} }],
    results: [{ id: 'c1', text: 'testo rilevante', score: 0.9, metadata: {} }],
  });
  const context = buildContext({ query: 'q', namespace: 'ns', retrieval }, config);
  const markdown = renderContextMarkdown(context);
  assert.match(markdown, /Decisione attiva/);
  assert.match(markdown, /testo rilevante/);
});
