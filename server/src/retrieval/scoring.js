/**
 * Hybrid scoring: formula trasparente e configurabile (nessun peso
 * hardcoded nella logica — i pesi arrivano sempre da config.js/env).
 *
 * score = vector_similarity * w1 + graph_proximity * w2 + relation_confidence * w3
 *       + recency * w4 + namespace_relevance * w5
 *       - penalita' applicabili
 */

/** Prossimita' nel grafo: 1 a hop 0 (il chunk stesso), decade con la distanza. */
export function computeGraphProximity(hopDistance) {
  if (hopDistance === null || hopDistance === undefined) return 0;
  return 1 / (1 + Math.max(0, hopDistance));
}

/** Recency con decadimento esponenziale (half-life configurabile in giorni). */
export function computeRecency(timestampMs, { halfLifeDays = 90, now = Date.now() } = {}) {
  if (!timestampMs) return 0;
  const daysSince = Math.max(0, (now - timestampMs) / (1000 * 60 * 60 * 24));
  return 0.5 ** (daysSince / halfLifeDays);
}

/**
 * @param {{vectorSimilarity?:number, graphProximity?:number, relationConfidence?:number, recency?:number, namespaceRelevance?:number}} components
 * @param {{outOfNamespace?:boolean, missingEvidence?:boolean, supersededDecision?:boolean, ambiguousEntity?:boolean, lowConfidence?:boolean, highGraphDistance?:boolean, duplicateContent?:boolean}} flags
 * @param {{vectorSimilarity:number, graphProximity:number, relationConfidence:number, recency:number, namespaceRelevance:number}} weights
 * @param {object} penalties
 */
export function hybridScore(components, flags, weights, penalties) {
  const base =
    (components.vectorSimilarity ?? 0) * weights.vectorSimilarity +
    (components.graphProximity ?? 0) * weights.graphProximity +
    (components.relationConfidence ?? 0) * weights.relationConfidence +
    (components.recency ?? 0) * weights.recency +
    (components.namespaceRelevance ?? 0) * weights.namespaceRelevance;

  let penalty = 0;
  if (flags?.outOfNamespace) penalty += penalties.outOfNamespace;
  if (flags?.missingEvidence) penalty += penalties.missingEvidence;
  if (flags?.supersededDecision) penalty += penalties.supersededDecision;
  if (flags?.ambiguousEntity) penalty += penalties.ambiguousEntity;
  if (flags?.lowConfidence) penalty += penalties.lowConfidence;
  if (flags?.highGraphDistance) penalty += penalties.highGraphDistance;
  if (flags?.duplicateContent) penalty += penalties.duplicateContent;

  return Math.max(0, base - penalty);
}
