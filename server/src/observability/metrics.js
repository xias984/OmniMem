/**
 * Metriche strutturate in-process (nessun contenuto sensibile: solo
 * contatori, durate e conteggi). Volutamente minimale — nessuna nuova
 * dipendenza (Prometheus client, statsd...) non giustificata per un
 * sistema locale single-node: chi vorra' esportarle su un backend esterno
 * puo' leggere `snapshot()` e spingerla dove preferisce.
 */
export class MetricsCollector {
  constructor(logger = console) {
    this.logger = logger;
    this.counters = new Map();
    this.durations = new Map(); // name -> {count, totalMs, maxMs}
  }

  increment(name, value = 1) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  recordDuration(name, ms) {
    const entry = this.durations.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    entry.count += 1;
    entry.totalMs += ms;
    entry.maxMs = Math.max(entry.maxMs, ms);
    this.durations.set(name, entry);
  }

  /** Cronometra una funzione async e registra la durata sotto `name`. */
  async time(name, fn) {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.recordDuration(name, Date.now() - start);
    }
  }

  snapshot() {
    return {
      counters: Object.fromEntries(this.counters),
      durations: Object.fromEntries(
        [...this.durations.entries()].map(([k, v]) => [
          k,
          { count: v.count, avgMs: v.count ? Math.round((v.totalMs / v.count) * 100) / 100 : 0, maxMs: v.maxMs },
        ])
      ),
    };
  }

  logSnapshot(prefix = '[metrics]') {
    this.logger.log?.(`${prefix} ${JSON.stringify(this.snapshot())}`);
  }
}
