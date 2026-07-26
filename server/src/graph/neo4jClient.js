/**
 * Wrapper sottile sul driver Neo4j: connessione lazy, timeout espliciti,
 * health check. Nessun'altra parte dell'applicazione deve importare
 * `neo4j-driver` direttamente: passa sempre da qui o dal graphRepository.
 */
import neo4j from 'neo4j-driver';

export class Neo4jClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.driver = null;
    this.connectionError = null;
  }

  /** Crea il driver se non esiste ancora. Non verifica la connettivita' (lazy). */
  ensureDriver() {
    if (!this.driver) {
      this.driver = neo4j.driver(
        this.cfg.uri,
        neo4j.auth.basic(this.cfg.username, this.cfg.password),
        { connectionTimeout: this.cfg.connectionTimeoutMs }
      );
    }
    return this.driver;
  }

  /** Sessione con database configurato. */
  session(mode = 'WRITE') {
    const driver = this.ensureDriver();
    return driver.session({
      database: this.cfg.database,
      defaultAccessMode: mode === 'READ' ? neo4j.session.READ : neo4j.session.WRITE,
    });
  }

  /**
   * Esegue una query con timeout esplicito. Ritorna { ok, records, error }.
   * Non lancia mai: chi chiama decide come reagire a ok === false
   * (fallback al retrieval vettoriale, log, dead-letter...).
   */
  async run(cypher, params = {}, { mode = 'WRITE' } = {}) {
    let session;
    try {
      session = this.session(mode);
      const timeoutMs = this.cfg.queryTimeoutMs;
      const result = await Promise.race([
        session.run(cypher, params),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Neo4j query timeout dopo ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);
      return { ok: true, records: result.records };
    } catch (err) {
      return { ok: false, error: err };
    } finally {
      if (session) await session.close().catch(() => {});
    }
  }

  /** Health check: connessione valida entro il timeout configurato. */
  async healthCheck() {
    const start = Date.now();
    const result = await this.run('RETURN 1 AS ok', {}, { mode: 'READ' });
    const latencyMs = Date.now() - start;
    if (!result.ok) {
      return { healthy: false, error: result.error?.message ?? 'errore sconosciuto', latencyMs };
    }
    return { healthy: true, latencyMs };
  }

  async close() {
    if (this.driver) {
      await this.driver.close().catch(() => {});
      this.driver = null;
    }
  }
}

let sharedClient = null;

export function getNeo4jClient(cfg) {
  if (!sharedClient) sharedClient = new Neo4jClient(cfg);
  return sharedClient;
}

export function resetSharedNeo4jClient() {
  sharedClient = null;
}
