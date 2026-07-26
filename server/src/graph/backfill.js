/**
 * Backfill: indicizza nel grafo i contenuti gia' presenti in ChromaDB.
 * Requisiti (dal task): esecuzione batch, checkpoint/ripresa, dry-run,
 * limite configurabile, filtro namespace, filtro temporale, logging di
 * progresso, idempotenza (garantita dal dual write sottostante).
 *
 * Il fetch dei chunk e la persistenza del checkpoint sono iniettati come
 * dipendenze: ne semplifica il test (nessuna ChromaDB reale necessaria) e
 * separa la logica di orchestrazione dall'accesso ai dati.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { indexMemoryIntoGraph } from './dualWrite.js';

function groupKey(topic, sourceUrl, captureId) {
  return `${topic ?? ''}::${sourceUrl ?? ''}::${captureId ?? ''}`;
}

export async function loadCheckpointFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveCheckpointFile(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * @param {{namespace?:string, dryRun?:boolean, limit?:number, since?:number, until?:number, batchSize?:number, extractorVersion?:string}} options
 * @param {{fetchChunksPage: Function, graphRepo: object, extractor: object, embed?: Function, thresholds: object,
 *          loadCheckpoint?: Function, saveCheckpoint?: Function, checkpointPath: string, logger?: object}} deps
 */
export async function runBackfill(options = {}, deps) {
  const {
    namespace = null,
    dryRun = false,
    limit = Infinity,
    since = null,
    until = null,
    batchSize = 50,
    extractorVersion = 'v1',
  } = options;
  const {
    fetchChunksPage,
    graphRepo,
    extractor,
    embed,
    thresholds,
    loadCheckpoint = loadCheckpointFile,
    saveCheckpoint = saveCheckpointFile,
    checkpointPath,
    logger = console,
  } = deps;

  const checkpointKey = namespace ?? '__all__';
  const checkpoints = await loadCheckpoint(checkpointPath);
  let offset = checkpoints[checkpointKey]?.offset ?? 0;

  const summary = {
    processedChunks: 0,
    processedMemories: 0,
    skippedOutsideFilter: 0,
    errors: 0,
    dryRun,
    startedAtOffset: offset,
  };

  logger.log?.(
    `[graph-backfill] avvio: namespace=${namespace ?? 'tutti'} dryRun=${dryRun} limit=${limit === Infinity ? 'nessuno' : limit} offset iniziale=${offset}`
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (summary.processedChunks >= limit) break;

    // eslint-disable-next-line no-await-in-loop
    const page = await fetchChunksPage({ namespace, offset, limit: batchSize });
    if (!page || page.items.length === 0) break;

    const groups = new Map();
    for (const item of page.items) {
      const ts = item.metadata?.timestamp ?? 0;
      if (since && ts < since) { summary.skippedOutsideFilter += 1; continue; }
      if (until && ts > until) { summary.skippedOutsideFilter += 1; continue; }

      const topic = item.metadata?.topic ?? 'Generale';
      const sourceUrl = item.metadata?.source_url ?? '';
      const captureId = item.metadata?.capture_id ?? null;
      const key = groupKey(topic, sourceUrl, captureId);
      if (!groups.has(key)) {
        groups.set(key, {
          namespace: item.metadata?.namespace ?? topic,
          memory: { sourceUrl, captureId, platform: item.metadata?.platform, topic },
          chunks: [],
        });
      }
      groups.get(key).chunks.push({ id: item.id, text: item.document, timestamp: ts });
    }

    for (const group of groups.values()) {
      if (summary.processedChunks >= limit) break;
      summary.processedMemories += 1;
      summary.processedChunks += group.chunks.length;

      if (dryRun) {
        logger.log?.(`[graph-backfill] (dry-run) indicizzerebbe memory namespace=${group.namespace} chunk=${group.chunks.length}`);
        // eslint-disable-next-line no-continue
        continue;
      }

      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await indexMemoryIntoGraph(group, { graphRepo, extractor, embed, thresholds, extractorVersion });
        if (!result.ok) summary.errors += 1;
        logger.log?.(
          `[graph-backfill] namespace=${group.namespace} chunk=${group.chunks.length} ok=${result.ok} progresso totale=${summary.processedChunks}`
        );
      } catch (err) {
        summary.errors += 1;
        logger.error?.(`[graph-backfill] errore su memory namespace=${group.namespace}: ${err.message}`);
      }
    }

    offset += page.items.length;
    if (!dryRun) {
      // eslint-disable-next-line no-await-in-loop
      await saveCheckpoint(checkpointPath, { ...checkpoints, [checkpointKey]: { offset, updatedAt: new Date().toISOString() } });
    }
    if (!page.hasMore) break;
  }

  summary.endedAtOffset = offset;
  logger.log?.(
    `[graph-backfill] completato: memorie=${summary.processedMemories} chunk=${summary.processedChunks} errori=${summary.errors} (dryRun=${dryRun})`
  );
  return summary;
}
