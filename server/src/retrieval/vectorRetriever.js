/**
 * Vector retriever: stessa logica gia' usata da POST /api/query, estratta
 * qui per essere riusata sia dal path esistente sia dal retriever ibrido.
 * Comportamento invariato: stesso filtro di distanza coseno, stesso `where`
 * per topic/namespace.
 */

const DEFAULT_DISTANCE_THRESHOLD = 0.75;

/**
 * @param {{queryText:string, namespace?:string, k?:number}} params
 * @param {{embed:Function, collection:object, distanceThreshold?:number}} deps
 * @returns {Promise<{id:string, text:string, metadata:object, distance:number, similarity:number}[]>}
 */
export async function vectorRetrieve({ queryText, namespace, k = 4 }, { embed, collection, distanceThreshold = DEFAULT_DISTANCE_THRESHOLD }) {
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
