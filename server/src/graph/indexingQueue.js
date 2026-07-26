/**
 * Coda di indicizzazione grafo in-memoria (stesso pattern gia' usato dal
 * server per i job di embedding: una Map, niente broker esterno — non
 * giustificabile per un sistema single-node locale). Esegue il dual write
 * in background, con retry limitati e dead-letter su file per i fallimenti
 * definitivi. Il fallimento non deve MAI propagarsi al chiamante originale
 * (che ha gia' salvato su ChromaDB).
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GraphIndexingQueue {
  /**
   * @param {{runJob: Function, maxRetries: number, retryDelayMs: number, deadLetterPath: string, metrics?: object, logger?: object, sleep?: Function}} opts
   */
  constructor({ runJob, maxRetries = 3, retryDelayMs = 1000, deadLetterPath, metrics, logger = console, sleep = defaultSleep }) {
    this.runJob = runJob;
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
    this.deadLetterPath = deadLetterPath;
    this.metrics = metrics ?? { increment() {} };
    this.logger = logger;
    this.sleep = sleep;
    this.pending = Promise.resolve();
    this.deadLetterCount = 0;
  }

  /** Accoda un job. Non blocca: ritorna subito, l'esecuzione avviene in background. */
  enqueue(job) {
    this.pending = this.pending.then(() => this.processWithRetry(job)).catch(() => {});
    return this.pending;
  }

  async processWithRetry(job) {
    let attempt = 0;
    let lastError = null;
    while (attempt <= this.maxRetries) {
      try {
        const result = await this.runJob(job);
        if (result?.ok) {
          this.metrics.increment('graph_indexing_duration', 1);
          return result;
        }
        lastError = result?.error ?? new Error('job grafo fallito senza dettagli');
      } catch (err) {
        lastError = err;
      }
      attempt += 1;
      if (attempt <= this.maxRetries) {
        // eslint-disable-next-line no-await-in-loop
        await this.sleep(this.retryDelayMs * attempt);
      }
    }

    this.metrics.increment('graph_failures', 1);
    this.logger.error(
      `[graph-indexing-queue] job fallito definitivamente dopo ${this.maxRetries + 1} tentativi: ${lastError?.message}`
    );
    await this.deadLetter(job, lastError);
    return { ok: false, error: lastError };
  }

  async deadLetter(job, error) {
    this.deadLetterCount += 1;
    if (!this.deadLetterPath) return;
    try {
      await mkdir(dirname(this.deadLetterPath), { recursive: true });
      const line = JSON.stringify({
        at: new Date().toISOString(),
        namespace: job?.namespace,
        memory: job?.memory,
        chunkIds: (job?.chunks ?? []).map((c) => c.id),
        error: error?.message ?? String(error),
      });
      await appendFile(this.deadLetterPath, `${line}\n`, 'utf8');
    } catch (err) {
      this.logger.error(`[graph-indexing-queue] impossibile scrivere la dead-letter: ${err.message}`);
    }
  }

  /** Attende che tutti i job accodati finora siano stati processati (utile nei test). */
  async drain() {
    await this.pending;
  }
}
