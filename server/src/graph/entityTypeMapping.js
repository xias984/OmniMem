/**
 * Mappa i tipi di entita' prodotti dall'estrattore (schema.js) alle label
 * dei nodi del grafo (schema.js in ../). Alcuni tipi hanno una label
 * dedicata (Project, Tool, Task, File, Session, Source); tutti gli altri
 * finiscono nella label generica Entity.
 */
const TYPE_TO_LABEL = Object.freeze({
  project: 'Project',
  tool: 'Tool',
  task: 'Task',
  file: 'File',
  session: 'Session',
  source: 'Source',
});

export function labelForEntityType(entityType) {
  return TYPE_TO_LABEL[entityType] ?? 'Entity';
}
