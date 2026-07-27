/**
 * Vector retriever: stessa soglia/k di POST /api/query (server.js). Nel
 * percorso HTTP live, `/api/query` calcola la query vettoriale UNA sola
 * volta e passa il risultato gia' pronto a `hybridRetrieve` come
 * `seedChunks` (vedi hybridRetriever.js): questa funzione resta quindi
 * l'implementazione di riferimento per chi ha bisogno di un retrieval
 * vettoriale standalone (test diretti, futuri usi da CLI), non un secondo
 * percorso che rischia di divergere da quello canonico.
 */

const DEFAULT_DISTANCE_THRESHOLD = 0.85;
const DEFAULT_K = 12;

/**
 * @param {{queryText:string, namespace?:string, k?:number}} params
 * @param {{embed:Function, collection:object, distanceThreshold?:number}} deps
 * @returns {Promise<{id:string, text:string, metadata:object, distance:number, similarity:number}[]>}
 */
export async function vectorRetrieve({ queryText, namespace, k = DEFAULT_K }, { embed, collection, distanceThreshold = DEFAULT_DISTANCE_THRESHOLD }) {
  const [queryEmbedding] = await embed(queryText);
  const whereClause = namespace && namespace !== 'Generale' ? { topic: { $eq: namespace } } : undefined;

  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: k,
    where: whereClause,
  });

  const docs = results.documents?.[0] ?? [];
  const distances = results.distances?.[0] ?? [];
  const metas = results.metadatas?.[0] ?? [];
  const ids = results.ids?.[0] ?? [];

  return docs
    .map((text, i) => ({
      id: ids[i],
      text,
      metadata: metas[i] ?? {},
      distance: distances[i],
      similarity: 1 - (distances[i] ?? 1),
    }))
    .filter((r) => r.distance <= distanceThreshold)
    .sort((a, b) => b.similarity - a.similarity);
}
