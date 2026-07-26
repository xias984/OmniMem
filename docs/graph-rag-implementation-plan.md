# OmniMem → Hybrid GraphRAG — Piano di implementazione

Stato: **in esecuzione** (task tracciati anche nel task-list della sessione).
Autore: analisi + implementazione automatizzata.
Data: 2026-07-26.

## 1. Analisi dell'architettura attuale

### 1.1 Stack reale (non assunto, verificato leggendo il codice)

- **Linguaggio**: Node.js (ESM, `"type": "module"`), nessun TypeScript, nessun bundler.
- **Server**: `server/server.js` — Express 4, un unico file monolitico (~860 righe).
- **Vector DB**: ChromaDB (`chromadb` npm client v1.9.2 nel server, v3.4.3 nel pacchetto MCP), un'unica collection `omnimem`, spazio coseno.
- **Embedding**: Ollama locale (`nomic-embed-text` di default), chiamato via HTTP `POST /api/embeddings`, un testo alla volta.
- **OCR**: `tesseract.js` per screenshot (facoltativo, side-channel dei messaggi).
- **Client**: estensione Chrome MV3 (`extension/`), companion Android (Accessibility Service, `android/`), MCP server stdio (`mcp/omnimem-mcp.js`, SDK `@modelcontextprotocol/sdk`, `zod` per gli schemi input).
- **Infra**: `docker-compose.yml` con servizi `chromadb`, `ollama` (profilo opzionale), `server`. Nessun altro datastore.
- **Test**: **nessuno**. Nessun framework di test installato in nessuno dei tre package.json (server, mcp, root). `npm test` nel pacchetto mcp è uno stub che fallisce sempre.
- **Auth**: header `X-OmniMem-Token` opzionale (`API_TOKEN`).

### 1.2 Flusso end-to-end attuale

```
source (estensione/Android/CLI/OCR)
  → POST /api/record { messages[], topic, metadata }
  → chunkMessages(): split su paragrafi con overlap di caratteri (CHUNK_SIZE=800, OVERLAP=80)
  → embed(): Ollama /api/embeddings, un chunk alla volta
  → makeId(): id deterministico = slug(source_url + capture_id + chunk_index)
  → collection.upsert({ ids, embeddings, documents, metadatas })
  → job store in-memory (Map) per polling di progresso (GET /api/progress/:jobId)
```

Retrieval:

```
POST /api/query { query, topic, k }
  → embed(query)
  → collection.query({ queryEmbeddings, nResults: k, where: { topic } })
  → filtro per distanza coseno <= 0.75
  → ritorna chunk grezzi come stringhe "[platform — topic]\ntesto"
```

Il "context builder" oggi è l'estensione Chrome (`content_script.js`), che prepende i chunk grezzi al prompt dell'utente con un semplice header/footer testuale. Non esiste provenienza strutturata, validità temporale, o gestione di contraddizioni: tutto ciò che viene trovato per similarità viene iniettato.

Ingestion di codice sorgente (`/api/ingest-codebase`) segue lo stesso schema: walk del filesystem, chunk per file con overlap a righe, embedding, upsert. Stessa collection, `platform: 'codebase'`.

Il tool MCP (`omnimem-mcp.js`) non fa retrieval semantico: legge chunk grezzi per `topic` (con cursore incrementale persistito su file) e istruisce Claude Code a costruire una "LLM Wiki" markdown nella working directory — un pattern complementare, non sovrapposto al retrieval RAG.

### 1.3 Componenti da mantenere invariati (nessuna regressione)

- Tutte le rotte HTTP esistenti (`/api/record`, `/api/query`, `/api/topics`, `/api/export/:topic`, `/api/ingest-codebase`, `/api/stats`, `/api/browse`, `/`, `/health`, `DELETE /api/topics/:topic`) e i relativi contratti request/response.
- `chunkMessages`, `chunkCode`, `embed`, `makeId`, la dashboard HTML, l'auth via token.
- Il comportamento di default (`OMNIMEM_GRAPHRAG_ENABLED` assente o `false`) deve essere **bit-per-bit identico** a oggi: stesso identico codice sui percorsi vettoriali.
- MCP server e wiki Karpathy: fuori scope, non toccati.

### 1.4 Punti di estensione necessari

1. **Dopo** l'upsert Chroma in `processRecord`/`processIngestCodebase`: hook di dual-write verso il grafo, asincrono, non bloccante, con try/catch che non deve mai far fallire la risposta HTTP né il salvataggio vettoriale già avvenuto.
2. **Prima** della risposta di `/api/query`: possibilità di instradare la richiesta al retriever ibrido invece che al solo vector retriever, dietro flag. In shadow mode: eseguire entrambi, rispondere con quello vettoriale, loggare il confronto.
3. Nuovo namespace concettuale: **il `topic` esistente è il candidato naturale a `namespace`** (già usato per isolare progetti/contesti in tutte le query Chroma `where: { topic }`). Non introduciamo un concetto parallelo: `namespace = metadata.namespace ?? topic`.
4. Nuovi endpoint additivi (nessuna modifica ai contratti esistenti): `GET /api/graph/health`, `POST /api/graph/backfill` (oltre al comando CLI), `GET /api/graph/shadow-log` (ultimi confronti shadow mode).
5. CLI di backfill separata dal server HTTP (script Node standalone), per poter essere eseguita anche offline / in CI.

### 1.5 Rischi di regressione e mitigazioni

| Rischio | Mitigazione |
|---|---|
| Rallentare `/api/record` per via del grafo | Dual-write è fire-and-forget (job asincrono separato), mai `await`ato nel path di risposta HTTP |
| Neo4j assente in dev/CI rompe l'avvio server | Connessione lazy + `healthCheck()` con timeout; se Neo4j è down, tutte le operazioni grafo no-op con log, mai eccezione propagata |
| Nuove dipendenze npm introducono breaking change su Node 20/22 | `neo4j-driver` (ufficiale) e `zod` (già usato nel pacchetto MCP) sono le uniche due dipendenze nuove, entrambe motivate (driver DB, validazione schema strutturata richiesta esplicitamente dal task) |
| LLM produce Cypher o JSON malformato | L'estrattore non genera mai Cypher: produce solo JSON validato via schema Zod; il codice applicativo costruisce le query. Output non valido → scartato interamente, nessun salvataggio parziale |
| Duplicazione entità per casing/alias | `entityResolver` con chiave canonica normalizzata + soglie di merge configurabili, testato unitariamente |
| Query grafo esplosive | Traversata limitata a profondità massima configurabile (default 2), con `LIMIT` espliciti in ogni query Cypher |
| Fuga dati cross-namespace | Ogni nodo/query Cypher filtra sempre per `namespace`; test dedicato di isolamento |

## 2. Modello dati Neo4j

Nodi (label = tipo): `Memory`, `Chunk`, `Entity`, `Project`, `Decision`, `Task`, `Tool`, `File`, `Session`, `Source`.
Proprietà comuni: `id` (univoco, hash stabile), `namespace`, `type`, `name`/`title`, `summary`, `created_at`, `updated_at`, `valid_from`, `valid_until`, `status`, `confidence`, `metadata` (JSON string — Neo4j non supporta mappe annidate come proprietà).

Relazioni: `CHUNK_OF`, `MENTIONS`, `ABOUT`, `DERIVED_FROM`, `CREATED_IN`, `DECIDED_IN`, `USES`, `DEPENDS_ON`, `BLOCKED_BY`, `SUPERSEDES`, `CONTRADICTS`, `RELATED_TO`.
Proprietà comuni: `confidence`, `source_chunk_ids` (array), `extractor_version`, `created_at`, `metadata`.

Chiave canonica: `namespace + entity_type + normalized_name` → hash SHA-1 troncato come `id`. Vedi `server/src/ids.js`.

Constraint di unicità: `(namespace, id)` per ogni label; indice su `(namespace, type, name)` per Entity/Decision/Task per lookup rapidi.

## 3. Ordine di implementazione

Segue l'ordine richiesto (config → Neo4j/repository → modello/constraint → extractor → entity resolution → dual write → backfill → graph retriever → hybrid retriever → router → reranker/scoring → context builder → shadow mode → metriche → dataset → docs → verifica). Ogni step è un commit verificabile con test propri.

## 4. Compromessi assunti (ambiguità non bloccanti)

1. **Namespace = topic esistente**, non un campo nuovo obbligatorio lato client: evita di rompere l'estensione Chrome/Android che non lo invierebbero mai. `namespace` resta comunque un campo esplicito nel modello dati e nelle query, con fallback su `topic`.
2. **Extractor di default**: usa Ollama locale (stesso host già configurato per gli embedding) con un modello chat generico, richiesta di output JSON. È sostituibile (interfaccia `KnowledgeExtractor`) e disattivabile (`OMNIMEM_GRAPH_INDEXING_ENABLED=false` → nessuna chiamata LLM aggiuntiva). Non è richiesta una nuova API key esterna, coerente con l'etica "privacy-first" del progetto.
3. **Coda di indicizzazione**: in-memory con retry limitati + dead-letter su file JSON locale (`server/data/graph-dead-letter.jsonl`), coerente con il pattern già presente (`jobs = new Map()`), invece di introdurre Redis/BullMQ (dipendenza non giustificabile per un sistema single-node locale).
4. **Community detection globale**: non implementata in questa fase (nessuna infrastruttura compatibile preesistente); vengono predisposte solo le interfacce (`CommunityBuilder`, `CommunitySummaryRepository`, `GlobalGraphRetriever`) che oggi restituiscono risultati vuoti/no-op documentati.
5. **Merge automatico entità**: mai distruttivo. Anche in caso di `automatic_merge` non si cancellano nodi: si collega il duplicato al nodo canonico (`metadata.merged_into`) e si aggregano gli alias, mantenendo storicità.

## 5. Criteri di verifica

Vedi `docs/graph-rag-operations.md` per i comandi di avvio/backfill/rollback e `docs/graph-rag-evaluation.md` per il dataset di valutazione. La sezione finale di questo lavoro riporta l'esito reale di lint/test eseguiti (non dichiarazioni di intenti).
