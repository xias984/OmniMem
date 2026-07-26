/**
 * Modello del grafo: label, tipi di relazione ammessi, stati delle decisioni
 * e le query di bootstrap (constraint + indici). Nessuna query qui viene mai
 * generata da un LLM: sono tutte statiche, scritte dal codice applicativo.
 */

export const NODE_LABELS = Object.freeze([
  'Memory',
  'Chunk',
  'Entity',
  'Project',
  'Decision',
  'Task',
  'Tool',
  'File',
  'Session',
  'Source',
]);

export const RELATION_TYPES = Object.freeze([
  'CHUNK_OF',
  'MENTIONS',
  'ABOUT',
  'DERIVED_FROM',
  'CREATED_IN',
  'DECIDED_IN',
  'USES',
  'DEPENDS_ON',
  'BLOCKED_BY',
  'SUPERSEDES',
  'CONTRADICTS',
  'RELATED_TO',
]);

export const DECISION_STATUSES = Object.freeze([
  'active',
  'superseded',
  'rejected',
  'historical',
  'unknown',
]);

export function isValidLabel(label) {
  return NODE_LABELS.includes(label);
}

export function isValidRelationType(type) {
  return RELATION_TYPES.includes(type);
}

/**
 * Restituisce le statement di bootstrap (constraint + indici) da eseguire
 * una volta sola in idempotenza (CREATE ... IF NOT EXISTS).
 */
export function bootstrapStatements() {
  const statements = [];

  for (const label of NODE_LABELS) {
    statements.push(
      `CREATE CONSTRAINT ${constraintName(label)} IF NOT EXISTS FOR (n:${label}) REQUIRE (n.namespace, n.id) IS UNIQUE`
    );
    statements.push(
      `CREATE INDEX ${indexName(label, 'type_name')} IF NOT EXISTS FOR (n:${label}) ON (n.namespace, n.type, n.name)`
    );
  }

  // Indice dedicato per la ricerca decisioni per stato (superseded/active ecc.)
  statements.push(
    `CREATE INDEX decision_status_idx IF NOT EXISTS FOR (n:Decision) ON (n.namespace, n.status)`
  );

  return statements;
}

function constraintName(label) {
  return `${label.toLowerCase()}_namespace_id_unique`;
}

function indexName(label, suffix) {
  return `${label.toLowerCase()}_${suffix}_idx`;
}
