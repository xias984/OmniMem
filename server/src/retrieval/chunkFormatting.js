/**
 * Raggruppamento/formattazione dei chunk per la risposta di /api/query.
 * Estratto in un modulo dedicato (invece di restare inline in server.js)
 * cosi' lo stesso contratto di raggruppamento/ordine/provenienza si applica
 * identico sia al percorso vettoriale puro sia a quello ibrido: abilitare
 * GraphRAG non deve silenziosamente perdere il raggruppamento per
 * conversazione ne' la formattazione con data/fonte gia' in uso oggi.
 *
 * @param {{doc:string, meta:object, sortValue:number}[]} items `sortValue`:
 *        piu' basso = migliore (distanza coseno per il solo vettoriale,
 *        `1 - score` per l'ibrido, cosi' la convenzione resta la stessa).
 * @returns {string[]}
 */
export function groupAndFormatChunks(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.meta?.source_url ?? 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const groupArrays = [...groups.values()].map((groupItems) => {
    groupItems.sort((a, b) => (a.meta?.timestamp ?? 0) - (b.meta?.timestamp ?? 0));
    const avgSortValue = groupItems.reduce((s, it) => s + it.sortValue, 0) / groupItems.length;
    return { items: groupItems, avgSortValue };
  });
  groupArrays.sort((a, b) => a.avgSortValue - b.avgSortValue);

  const out = [];
  for (const { items: groupItems } of groupArrays) {
    for (const { doc, meta } of groupItems) {
      const platform = meta?.platform ?? '?';
      const date = meta?.timestamp ? new Date(meta.timestamp).toISOString().slice(0, 10) : '?';
      const src = meta?.file_path ?? meta?.source_url ?? '';
      const srcLabel = src ? ` — ${src}` : '';
      out.push(`[${platform} — ${date}${srcLabel}]\n${doc}`);
    }
  }
  return out;
}
