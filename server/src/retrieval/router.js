/**
 * Query router deterministico: classifica la domanda in una categoria e
 * sceglie la strategia di retrieval. Nessuna chiamata LLM obbligatoria per
 * ogni query (requisito esplicito) — solo pattern/keyword, in italiano e
 * inglese. In caso di dubbio ricade sempre su "vector" (fallback sicuro).
 */

export const CATEGORIES = Object.freeze([
  'relational',
  'causal',
  'temporal',
  'decision',
  'dependency',
  'contradiction',
  'global_summary',
  'semantic',
]);

/** Strategia per categoria, come da specifica. */
export const CATEGORY_STRATEGY = Object.freeze({
  semantic: 'vector',
  relational: 'vector+graph',
  causal: 'vector+graph',
  temporal: 'graph+vector',
  decision: 'graph+vector',
  dependency: 'graph+vector',
  contradiction: 'graph+vector',
  global_summary: 'vector', // community detection futura, non bloccante per questo rilascio
});

// Pattern ordinati per specificita': il primo che matcha vince. L'ordine
// conta perche' alcune query toccano piu' categorie (es. "perche' e' stata
// superata questa decisione" e' sia causale che decisionale: vince decision).
const PATTERNS = [
  { category: 'contradiction', regex: /\b(contraddi|contraddittori|in conflitto|incongruen|contradict)/i },
  { category: 'decision', regex: /\b(decision[ei]|deciso|scelta|scelto|supersed|sostitu\w*|rejected|rifiutat)/i },
  { category: 'dependency', regex: /\b(dipend\w*|blocc\w*|prerequisit|depend\w*|blocked)/i },
  // Niente \b di chiusura: alcune parole italiane terminano in vocale accentata
  // (perché, così...) e \b tratta i caratteri accentati come "non-word",
  // rendendo il confine finale inaffidabile subito dopo di essi.
  { category: 'temporal', regex: /\b(quando|prima di|dopo di|nel tempo|storico|evoluzione|timeline|valid[oa] (fino|dal)|when|before|after)/i },
  { category: 'causal', regex: /\b(perch[eé]|per quale motivo|come mai|why)/i },
  { category: 'global_summary', regex: /\b(panoramica|riassum\w*|sommario|overview|in generale|complessivamente|summary)/i },
  { category: 'relational', regex: /\b(relazion\w*|collegat\w*|legat\w* a|connesso a|related to|collegamento)/i },
];

/**
 * @param {string} query
 * @returns {{category: string, strategy: string}}
 */
export function classifyQuery(query) {
  const text = (query ?? '').trim();
  if (!text) return { category: 'semantic', strategy: CATEGORY_STRATEGY.semantic };

  for (const { category, regex } of PATTERNS) {
    if (regex.test(text)) {
      return { category, strategy: CATEGORY_STRATEGY[category] };
    }
  }
  return { category: 'semantic', strategy: CATEGORY_STRATEGY.semantic };
}

/** true se la strategia prevede anche il retrieval grafo. */
export function usesGraph(strategy) {
  return strategy === 'vector+graph' || strategy === 'graph+vector';
}
