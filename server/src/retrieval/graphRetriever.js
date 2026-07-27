/**
 * Local graph retrieval: dai chunk seed (gia' trovati dal vector retriever)
 * espande il grafo per un numero limitato di hop, risolve le entita'
 * menzionate nella query e recupera i chunk aggiuntivi che ne costituiscono
 * evidenza (decisioni, relazioni, contraddizioni collegate).
 *
 * Nessuna chiamata LLM e' necessaria per riconoscere le entita' nella query:
 * si usa un matching esatto/alias sugli n-gram della domanda (economico,
 * deterministico, adatto perche' il volume di entita' per namespace e'
 * tipicamente piccolo). E' un compromesso prudente documentato nel piano.
 */
import { chunkId } from '../ids.js';
import { QUERY_RESOLVABLE_LABELS } from '../graph/entityTypeMapping.js';

const STOPWORDS = new Set([
  'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra',
  'che', 'chi', 'cui', 'come', 'quale', 'quali', 'quando', 'dove', 'perche', 'perché', 'e', 'o', 'ma', 'non', 'del',
  'della', 'dello', 'dei', 'delle', 'degli', 'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'is', 'are', 'was',
]);

function tokenize(text) {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Genera n-gram (1..maxN parole) dalla query, come candidati nomi di entita'. */
export function extractCandidatePhrases(query, { maxN = 3, maxCandidates = 20 } = {}) {
  const tokens = tokenize(query);
  const phrases = new Set();
  for (let n = maxN; n >= 1; n -= 1) {
    for (let i = 0; i + n <= tokens.length; i += 1) {
      phrases.add(tokens.slice(i, i + n).join(' '));
      if (phrases.size >= maxCandidates * 3) break;
    }
  }
  return [...phrases].slice(0, maxCandidates);
}

async function resolveQueryEntities(namespace, query, graphRepo, maxCandidates) {
  const candidates = extractCandidatePhrases(query, { maxCandidates });
  const matched = new Map();
  for (const phrase of candidates) {
    // Cerca su tutte le label "nameable" (Entity, Project, Tool, Task, File,
    // Session, Source): un'entita' citata nella query puo' essere stata
    // indicizzata sotto una qualsiasi di queste, non solo :Entity.
    // eslint-disable-next-line no-await-in-loop
    const found = await graphRepo.findEntitiesByAlias(namespace, phrase, { label: QUERY_RESOLVABLE_LABELS, limit: 5 });
    for (const entity of found) matched.set(entity.id, entity);
  }
  return [...matched.values()];
}

/**
 * @param {{queryText:string, namespace:string, seedChunks:{id:string}[]}} params
 * @param {{graphRepo:object, maxHops?:number, maxSeedChunks?:number, maxExpansionNodes?:number, maxExpansionEdges?:number}} config
 */
export async function graphRetrieve({ queryText, namespace, seedChunks }, config) {
  const { graphRepo, maxHops = 2, maxSeedChunks = 8, maxExpansionNodes = 100, maxExpansionEdges = 300 } = config;

  const seeds = (seedChunks ?? []).slice(0, maxSeedChunks);
  const seedGraphIds = seeds.map((c) => chunkId(namespace, c.id));

  const matchedEntities = await resolveQueryEntities(namespace, queryText, graphRepo, 20);

  const [fromChunks, fromEntities] = await Promise.all([
    graphRepo.expandFromChunks(namespace, seedGraphIds, { maxHops, maxNodes: maxExpansionNodes, maxEdges: maxExpansionEdges }),
    matchedEntities.length > 0
      ? graphRepo.expandFromEntities(namespace, matchedEntities.map((e) => e.id), { maxHops, maxNodes: maxExpansionNodes, maxEdges: maxExpansionEdges })
      : { nodes: [], edges: [] },
  ]);

  const nodesById = new Map();
  for (const node of [...fromChunks.nodes, ...fromEntities.nodes]) {
    const existing = nodesById.get(node.id);
    if (!existing || node.hop < existing.hop) nodesById.set(node.id, node);
  }

  const edgesByKey = new Map();
  for (const edge of [...fromChunks.edges, ...fromEntities.edges]) {
    const key = `${edge.fromId}::${edge.type}::${edge.toId}`;
    if (!edgesByKey.has(key)) edgesByKey.set(key, edge);
  }

  const evidenceChunkNodes = [...nodesById.values()].filter((n) => n.__labels?.includes('Chunk'));
  const decisionNodes = [...nodesById.values()].filter((n) => n.__labels?.includes('Decision'));
  const entityNodes = [...nodesById.values()].filter((n) => QUERY_RESOLVABLE_LABELS.some((l) => n.__labels?.includes(l)));
  const contradictions = [...edgesByKey.values()].filter((e) => e.type === 'CONTRADICTS');

  return {
    matchedEntities,
    nodes: [...nodesById.values()],
    edges: [...edgesByKey.values()],
    evidenceChunkNodes,
    decisionNodes,
    entityNodes,
    contradictions,
  };
}
