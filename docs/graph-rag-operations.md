# OmniMem — GraphRAG: operatività

Comandi concreti per avviare, popolare, monitorare e disattivare il
sottosistema GraphRAG. Per l'architettura vedi
[`graph-rag-architecture.md`](graph-rag-architecture.md).

## 1. Avvio di Neo4j

```bash
# Copia e configura le variabili (se non già fatto)
cp .env.example .env
# Imposta almeno: NEO4J_PASSWORD=<una-password-tua>

# Avvia Neo4j (profilo opt-in, non parte con un semplice `docker compose up`)
docker compose --profile with-graphrag up -d neo4j

# Verifica lo stato
docker compose ps neo4j
curl -u neo4j:<password> http://localhost:7474   # Neo4j Browser, opzionale
```

Bootstrap dello schema (constraint di unicità `(namespace, id)` per ogni
label, indici su `(namespace, type, name)`):

```bash
cd server
NEO4J_URI=bolt://localhost:7687 NEO4J_PASSWORD=<password> npm run graph:bootstrap
```

Health check via HTTP (server già avviato):

```bash
curl http://localhost:3000/api/graph/health
```

## 2. Abilitare l'indicizzazione grafo (dual write)

Nel tuo `.env` (o nell'ambiente del server):

```
OMNIMEM_GRAPH_INDEXING_ENABLED=true
NEO4J_URI=bolt://localhost:7687   # bolt://neo4j:7687 dentro docker compose
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=<password>
```

Da questo momento ogni `POST /api/record` (Rec dall'estensione, Android,
ingestion di codice) continua a salvare su ChromaDB **esattamente come
prima**, e in parallelo accoda un job di indicizzazione grafo. Il grafo si
popola progressivamente; il retrieval continua a usare solo ChromaDB finché
`OMNIMEM_GRAPHRAG_ENABLED` resta `false` ("dual indexing" nella terminologia
del task).

Estrattore strutturato: di default usa Ollama in locale
(`OMNIMEM_EXTRACTOR_PROVIDER=ollama`, `OMNIMEM_EXTRACTOR_MODEL=llama3.1` di
default — sostituisci con un modello effettivamente disponibile sulla tua
istanza Ollama). Con `OMNIMEM_EXTRACTOR_PROVIDER=none` il grafo si popola
solo con la struttura portante (Memory/Chunk/CHUNK_OF), senza
entità/relazioni/decisioni.

## 3. Backfill dei contenuti già in ChromaDB

```bash
cd server

# Tutto (tutti i namespace/topic)
npm run graph:backfill

# Solo un namespace/progetto
npm run graph:backfill -- --namespace=Hearthfall

# Simulazione, nessuna scrittura su Neo4j
npm run graph:backfill -- --dry-run

# Limita il numero di chunk processati in questa esecuzione
npm run graph:backfill -- --limit=100

# Filtro temporale (timestamp epoch ms o data ISO)
npm run graph:backfill -- --since=2026-01-01 --until=2026-06-01

# Forza una nuova versione dell'estrattore (utile dopo aver cambiato modello/prompt)
npm run graph:backfill -- --extractor-version=v2 --batch-size=100
```

Il backfill è **idempotente** (stessi id stabili → nessun duplicato) e
**riprendibile**: il progresso (offset per namespace) è salvato in
`server/data/graph-backfill-checkpoint.json` **solo quando un'intera pagina
(batch) è stata processata con successo**. Se una singola memory in quella
pagina fallisce (Neo4j giù, estrazione fallita...), oppure `--limit` taglia
l'esecuzione a metà pagina, il checkpoint resta fermo all'inizio della
pagina: alla prossima esecuzione l'intera pagina viene ripresa da capo,
comprese le memory già indicizzate con successo (innocuo, grazie
all'idempotenza) — cosi' nessuna memory viene mai saltata per sempre a
causa di un errore transitorio. Se il processo viene interrotto (Ctrl+C,
crash, riavvio) a meta' pagina, rilanciando lo stesso comando si riprende
dall'ultimo checkpoint salvato, non da zero.

Equivalente via HTTP (utile per orchestrazione esterna):

```bash
curl -X POST http://localhost:3000/api/graph/backfill \
  -H 'Content-Type: application/json' \
  -d '{"namespace": "Hearthfall", "dryRun": false, "limit": 500}'
```

## 4. Shadow mode

```
OMNIMEM_GRAPH_SHADOW_MODE=true
OMNIMEM_GRAPH_INDEXING_ENABLED=true   # perché il grafo abbia dati da confrontare
```

Con questo flag, `POST /api/query` continua a rispondere con il risultato
vettoriale esistente (nessun cambiamento visibile al client), ma esegue
**anche** il retrieval ibrido ad ogni chiamata, e logga sul server (stdout)
una riga per confronto:

```
[shadow-mode] categoria=decision strategia=graph+vector vector_chunks=4 hybrid_chunks=6 used_graph=true fallback=false
```

Le durate e i conteggi aggregati sono anche disponibili in
`GET /api/graph/metrics` (`vector_retrieval_duration`,
`graph_retrieval_duration`, `hybrid_retrieval_duration`,
`graph_expansion_nodes`, `graph_expansion_edges`, `retrieved_chunks`...).
Usa la shadow mode per validare qualità/latenza del grafo prima di passare
alla modalità ibrida attiva.

## 5. Passare alla modalità ibrida attiva

```
OMNIMEM_GRAPHRAG_ENABLED=true
```

Da questo momento `POST /api/query` usa il router per scegliere la
strategia ed eventualmente combina vettoriale+grafo, con fallback
automatico al solo vettoriale se Neo4j non risponde. La risposta include
due campi additivi (`graph`, `context`) oltre al campo `chunks` esistente
(mantenuto per compatibilità con l'estensione Chrome/Android/MCP attuali,
che continuano a funzionare senza modifiche).

## 6. Rollback

Il rollback è sempre **una sola variabile d'ambiente**, senza migrazioni da
disfare:

```
OMNIMEM_GRAPHRAG_ENABLED=false
```

riporta `/api/query` al comportamento vettoriale puro immediatamente (stesso
identico codice del ramo "GraphRAG disabilitato"). Se vuoi anche fermare la
scrittura nel grafo:

```
OMNIMEM_GRAPH_INDEXING_ENABLED=false
```

Il grafo Neo4j esistente non viene toccato da questi rollback: puoi
riattivare i flag in qualsiasi momento senza perdere i dati già indicizzati
(l'indicizzazione è idempotente, quindi anche un nuovo backfill non crea
duplicati).

Per rimuovere completamente Neo4j dall'ambiente locale:

```bash
docker compose --profile with-graphrag down -v   # -v cancella anche i volumi neo4j_data/neo4j_logs
```

## 7. Troubleshooting

| Sintomo | Causa probabile | Azione |
|---|---|---|
| `GET /api/graph/health` → `neo4j.healthy: false` | Neo4j non avviato o credenziali errate | `docker compose --profile with-graphrag up -d neo4j`, verifica `NEO4J_PASSWORD` |
| `/api/query` risponde ma `graph.fallback_to_vector: true` | Neo4j irraggiungibile o query in timeout | Controlla i log del server (`[hybrid-retriever] graph retrieval fallito...`), aumenta `NEO4J_QUERY_TIMEOUT_MS` se il grafo è molto grande |
| Il backfill non avanza / si blocca | ChromaDB con moltissimi chunk e `--batch-size` alto | Riduci `--batch-size`, controlla i log `[graph-backfill]` per il chunk che sta fallendo |
| Entità duplicate nonostante l'entity resolution | Soglie troppo alte o nomi molto diversi (non alias noti) | Abbassa `OMNIMEM_ER_POSSIBLE_DUPLICATE_THRESHOLD`/`OMNIMEM_ER_AUTO_MERGE_THRESHOLD`, oppure aggiungi l'alias mancante alla prossima estrazione |
| Job grafo in dead-letter | Estrazione fallita ripetutamente (LLM non raggiungibile, output sempre malformato) | Leggi `server/data/graph-dead-letter.jsonl`, correggi il provider/modello, rilancia il backfill sul namespace interessato |
| `npm run graph:bootstrap` fallisce | Neo4j non ancora pronto (healthcheck non superato) | Attendi qualche secondo dopo `docker compose up`, riprova |

## 8. Limiti noti

- Nessun merge automatico distruttivo: i `possible_duplicate` restano nodi
  separati finché non c'è una revisione (manuale o un futuro flusso
  dedicato).
- Global graph retrieval (community detection) non implementato in questo
  rilascio: `global_summary` usa solo il vettoriale.
- Provenienza incompleta per chunk raggiunti solo via espansione grafo (vedi
  `graph-rag-architecture.md`, sezione Context builder).
- L'estrattore Ollama richiede un modello capace di seguire istruzioni JSON
  in modo affidabile; con modelli piccoli il tasso di scarto (output
  malformato) può essere significativo — è comunque sicuro, perché ogni
  output non valido viene scartato interamente (nessun salvataggio
  parziale) e loggato.
