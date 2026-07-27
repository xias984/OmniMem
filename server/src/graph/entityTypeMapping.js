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

/**
 * Tutte le label "nameable" che possono comparire come entita' citate in una
 * query (Entity generica + le label tipizzate sopra). Usata dal query-time
 * entity resolution (graphRetriever) e dall'espansione seedata da entita',
 * cosi' un'entita' indicizzata come :Project o :Tool resta trovabile: prima
 * cercavano solo :Entity, perdendo silenziosamente ogni label tipizzata.
 */
export const QUERY_RESOLVABLE_LABELS = Object.freeze(['Entity', ...Object.values(TYPE_TO_LABEL)]);
