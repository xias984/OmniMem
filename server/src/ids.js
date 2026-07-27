/**
 * Chiavi canoniche e identificatori stabili per il knowledge graph.
 * Stessa entita'/relazione/decisione indicizzata piu' volte deve produrre
 * sempre lo stesso id: e' la base dell'idempotenza richiesta dal task.
 */
import { createHash } from 'node:crypto';

/**
 * Normalizza un nome per il confronto: minuscolo, senza diacritici,
 * trattini/underscore trattati come spazi, punteggiatura rimossa,
 * spazi multipli collassati.
 */
export function normalizeName(name) {
  if (name === null || name === undefined) return '';
  return String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // rimuove accenti (diacritici combinanti)
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sha1(input) {
  return createHash('sha1').update(input).digest('hex');
}

/**
 * Chiave canonica: namespace + entity_type + normalized_name.
 */
export function canonicalKey(namespace, entityType, name) {
  const ns = (namespace ?? 'default').trim().toLowerCase();
  const type = (entityType ?? 'entity').trim().toLowerCase();
  const normalized = normalizeName(name);
  return `${ns}::${type}::${normalized}`;
}

function stableIdFromKey(prefix, key) {
  return `${prefix}_${sha1(key).slice(0, 16)}`;
}

/** Id stabile per un nodo Entity (o sottotipo Project/Tool/Task/File/Session/Source). */
export function entityId(namespace, entityType, name) {
  return stableIdFromKey(entityType ?? 'entity', canonicalKey(namespace, entityType, name));
}

/** Id stabile per una Decision: chiave = namespace + statement normalizzato. */
export function decisionId(namespace, statement) {
  return stableIdFromKey('decision', canonicalKey(namespace, 'decision', statement));
}

/** Id stabile per il nodo Memory che raggruppa i chunk di una stessa cattura. */
export function memoryId(namespace, sourceUrl, captureId) {
  const key = `${(namespace ?? 'default').toLowerCase()}::memory::${sourceUrl ?? ''}::${captureId ?? ''}`;
  return stableIdFromKey('memory', key);
}

/** Id stabile per un Chunk, coerente con l'id gia' usato per ChromaDB (makeId lato server.js). */
export function chunkId(namespace, chromaId) {
  const key = `${(namespace ?? 'default').toLowerCase()}::chunk::${chromaId}`;
  return stableIdFromKey('chunk', key);
}

/** Id stabile per una relazione (usato per upsert idempotenti su Neo4j). */
export function relationId(fromId, relationType, toId) {
  const key = `${fromId}::${relationType}::${toId}`;
  return stableIdFromKey('rel', key);
}
