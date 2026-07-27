/**
 * Servizio di risoluzione delle entita'. Pipeline (nell'ordine richiesto):
 *   1. corrispondenza esatta su chiave canonica
 *   2. confronto con alias noti
 *   3. normalizzazione (gia' incorporata nei passi 1/2, vedi ids.js)
 *   4. fuzzy matching (distanza di Levenshtein normalizzata)
 *   5. confronto semantico via embedding (solo in fascia ambigua, per non
 *      sprecare chiamate di embedding quando il fuzzy match e' gia' chiaro)
 *   6. classificazione: exact_match | automatic_merge | possible_duplicate | new_entity
 *
 * Nessun merge distruttivo: "automatic_merge" ricollega al nodo canonico
 * esistente conservando gli alias; "possible_duplicate" crea comunque
 * un'entita' separata, marcata come candidata a revisione manuale.
 */
import { entityId, normalizeName } from '../ids.js';

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  let prevRow = new Array(lb + 1);
  for (let j = 0; j <= lb; j += 1) prevRow[j] = j;

  for (let i = 1; i <= la; i += 1) {
    const currRow = new Array(lb + 1);
    currRow[0] = i;
    for (let j = 1; j <= lb; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1, // cancellazione
        currRow[j - 1] + 1, // inserimento
        prevRow[j - 1] + cost // sostituzione
      );
    }
    prevRow = currRow;
  }
  return prevRow[lb];
}

/** Similarita' normalizzata in [0,1]: 1 = stringhe identiche. */
export function stringSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(na, nb) / maxLen;
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * @param {{namespace:string,type:string,name:string,aliases?:string[],label?:string}} candidate
 * @param {{graphRepo: object, embed?: (text:string)=>Promise<number[]>, thresholds: object}} deps
 */
export async function resolveEntity(candidate, deps) {
  const { namespace, type, name, aliases = [], label = 'Entity' } = candidate;
  const { graphRepo, embed, thresholds } = deps;
  const canonicalId = entityId(namespace, type, name);

  // 1. corrispondenza esatta su chiave canonica
  const exact = await graphRepo.findEntity(namespace, canonicalId, label);
  if (exact) {
    return { decision: 'exact_match', entityId: canonicalId, matchedEntity: exact, score: 1, reason: 'canonical_key' };
  }

  // 2. alias noti (controlla sia il nome proposto sia i suoi alias)
  for (const aliasCandidate of [name, ...aliases]) {
    // eslint-disable-next-line no-await-in-loop
    const found = await graphRepo.findEntitiesByAlias(namespace, aliasCandidate, {
      label,
      limit: thresholds.maxCandidates,
    });
    if (found.length > 0) {
      return {
        decision: 'automatic_merge',
        entityId: found[0].id,
        matchedEntity: found[0],
        score: 1,
        reason: 'alias_match',
      };
    }
  }

  // 4. fuzzy matching contro le entita' dello stesso tipo nel namespace
  const sameType = await graphRepo.findEntitiesByType(namespace, type, {
    label,
    limit: thresholds.maxCandidates,
  });

  let best = null;
  for (const existing of sameType) {
    const score = stringSimilarity(name, existing.name ?? '');
    if (!best || score > best.score) best = { entity: existing, score };
  }

  let finalScore = best?.score ?? 0;
  let reason = 'fuzzy_match';

  // 5. confronto semantico solo nella fascia ambigua (risparmia chiamate embed)
  const inAmbiguousBand =
    best && finalScore >= thresholds.possibleDuplicateThreshold && finalScore < thresholds.automaticMergeThreshold;
  if (inAmbiguousBand && thresholds.semanticCompareEnabled && typeof embed === 'function') {
    try {
      const [embA, embB] = await Promise.all([embed(name), embed(best.entity.name)]);
      const semanticScore = cosineSimilarity(embA, embB);
      finalScore = Math.max(finalScore, semanticScore);
      reason = 'semantic_match';
    } catch {
      // se l'embedding fallisce, si resta sul punteggio fuzzy gia' calcolato
    }
  }

  if (best && finalScore >= thresholds.automaticMergeThreshold) {
    return { decision: 'automatic_merge', entityId: best.entity.id, matchedEntity: best.entity, score: finalScore, reason };
  }
  if (best && finalScore >= thresholds.possibleDuplicateThreshold) {
    return {
      decision: 'possible_duplicate',
      entityId: canonicalId,
      candidateEntityId: best.entity.id,
      score: finalScore,
      reason,
    };
  }
  return { decision: 'new_entity', entityId: canonicalId, score: finalScore };
}
