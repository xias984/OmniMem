# OmniMem — Architettura Hybrid GraphRAG

Questo documento descrive l'architettura implementata: modello dati, flusso di
ingestion, retrieval ibrido, configurazione. Per il piano e le decisioni
progettuali vedi [`graph-rag-implementation-plan.md`](graph-rag-implementation-plan.md);
per l'operatività (avvio, backfill, rollback) vedi
[`graph-rag-operations.md`](graph-rag-operations.md).

## 1. Vista d'insieme

```
Ingestion
  Source normalizer (extension/Android/CLI) ─┐
  Chunker (chunkMessages/chunkCode, invariati) │
  Embedding service (Ollama, invariato)        ├──► ChromaDB (vector index, invariato)
  Structured knowledge extractor (nuovo)       │
  Indexing queue (nuovo, dual write)  ─────────┘──► Neo4j (graph index, nuovo)

Retrieval
  Query router (nuovo, deterministico)
    ├─ vector   → Vector retriever (ChromaDB, invariato)
    └─ +graph   → Graph retriever (Neo4j, max 2 hop) ──► Hybrid retriever (scoring)
                                                              │
                                                              ▼
                                                      Context builder (provenienza,
                                                      validità temporale, contraddizioni,
                                                      token budget)
```

Principio guida: **ChromaDB risponde "cosa assomiglia semanticamente alla
domanda", Neo4j risponde "come è collegato e cos'è ancora valido"**. Il
retriever ibrido combina i due, il reranker (lo scoring) sceglie cosa entra
nel contesto finale.

## 2. Modello dati Neo4j

### Nodi

`Memory`, `Chunk`, `Entity`, `Project`, `Decision`, `Task`, `Tool`, `File`,
`Session`, `Source`. Proprietà comuni (quando applicabile): `id`,
`namespace`, `type`, `name`, `summary`, `created_at`, `updated_at`,
`valid_from`, `valid_until`, `status`, `confidence`, `metadata` (JSON
serializzato — Neo4j non supporta mappe annidate come proprietà scalari),
`aliases` (array, solo su nodi risolvibili come entità).

`namespace` è sempre presente e coincide, per compatibilità con il sistema
esistente, con il `topic` già usato per isolare progetti/contesti in
ChromaDB (vedi `metadata.namespace ?? topic` in `server.js`).

### Relazioni

`CHUNK_OF`, `MENTIONS`, `ABOUT`, `DERIVED_FROM`, `CREATED_IN`, `DECIDED_IN`,
`USES`, `DEPENDS_ON`, `BLOCKED_BY`, `SUPERSEDES`, `CONTRADICTS`,
`RELATED_TO`. Ogni relazione porta `confidence`, `source_chunk_ids`
(evidenza, mai vuota — vedi sotto), `extractor_version`, `created_at`,
`metadata`.

**Una relazione priva di `source_chunk_ids` viene rifiutata da
`GraphRepository.upsertRelation`** (vedi `server/src/graph/graphRepository.js`):
non esiste, nel grafo, una relazione "estratta" senza evidenza. Le relazioni
strutturali (`CHUNK_OF`) usano il chunk stesso come propria evidenza.

### Identificatori stabili (idempotenza)

`server/src/ids.js`:

- `normalizeName`: minuscolo, diacritici rimossi, trattini/underscore →
  spazio, punteggiatura rimossa, spazi collassati.
- `canonicalKey(namespace, type, name)` = `namespace::type::normalized_name`.
- `entityId/decisionId/memoryId/chunkId/relationId`: hash SHA-1 (16 hex)
  della chiave canonica, con prefisso leggibile (`entity_`, `decision_`...).

Indicizzare due volte lo stesso contenuto produce sempre gli stessi id →
`MERGE` su Neo4j non crea duplicati (vedi test di idempotenza in
`server/test/dualWrite.test.js` e `server/test/backfill.test.js`).

## 3. Ingestion e dual write

Il percorso esistente (`processRecord`/`processIngestCodebase` in
`server.js`) è invariato: chunking, embedding, upsert su ChromaDB. Subito
dopo l'upsert vettoriale, se `OMNIMEM_GRAPH_INDEXING_ENABLED=true`, viene
accodato un job asincrono (`GraphIndexingQueue`, in-memory, stesso pattern
già usato per i job di embedding) che:

1. Upserta `Memory` + `Chunk` + `CHUNK_OF` (sempre, indipendentemente
   dall'estrazione — struttura portante del grafo).
2. Chiama lo **structured knowledge extractor** (`server/src/graph/extractor/`)
   sui chunk della memory, ottenendo entità/relazioni/decisioni **validate
   tramite schema Zod** (`extractor/schema.js`). Nessuna query Cypher è mai
   generata dal modello: produce solo JSON, il codice applicativo costruisce
   le query.
3. Risolve ogni entità tramite l'**entity resolver**
   (`server/src/graph/entityResolver.js`): match esatto su chiave canonica →
   alias → fuzzy (Levenshtein normalizzato) → semantico (embedding, solo
   nella fascia ambigua) → classificazione `exact_match` / `automatic_merge`
   / `possible_duplicate` / `new_entity`. Mai merge distruttivo: anche in
   automatic_merge si aggiornano solo alias e `metadata.merge_history`.
4. Upserta relazioni e decisioni (con `SUPERSEDES` quando dichiarato,
   creando uno stub storico se la decisione superata non era ancora nel
   grafo, e marcando `active → superseded` quella esistente).

Il fallimento di una qualsiasi fase 2-4 **non tocca** la struttura scritta
al passo 1, e soprattutto non tocca in alcun modo il salvataggio vettoriale
già avvenuto. In caso di fallimento definitivo (dopo i retry configurati),
il job finisce in una dead-letter JSONL locale (`server/data/graph-dead-letter.jsonl`).

## 4. Retrieval ibrido

### Router (`server/src/retrieval/router.js`)

Classificazione **deterministica** (regex/keyword, italiano+inglese), niente
chiamata LLM obbligatoria per ogni query. Categorie: `semantic`,
`relational`, `causal`, `temporal`, `decision`, `dependency`,
`contradiction`, `global_summary`. Strategia per categoria come da
specifica (`semantic→vector`, `relational/causal→vector+graph`,
`temporal/decision/dependency/contradiction→graph+vector`,
`global_summary→vector`, in attesa della community detection futura).

### Vector retriever

Stessa identica logica di `/api/query` oggi (embedding Ollama, query
ChromaDB, filtro distanza coseno ≤ 0.75), estratta in
`server/src/retrieval/vectorRetriever.js` per essere riusata.

### Graph retriever (`server/src/retrieval/graphRetriever.js`)

1. Usa i chunk seed del vector retriever.
2. Risolve le entità **citate nella query** con un matching alias/esatto su
   n-gram (1-3 parole, stopword escluse, tetto configurabile di candidati) —
   compromesso deliberato per evitare una chiamata LLM obbligatoria ad ogni
   query (documentato nel piano).
3. Espande il grafo da chunk-seed ed entità-seed, **massimo 2 hop**
   (configurabile, MAI variable-length illimitato: `GraphRepository`
   implementa l'espansione come due query esplicite hop-per-hop, ciascuna
   con `LIMIT`, non un singolo pattern Cypher `[*1..N]`).
4. Raccoglie i chunk aggiuntivi trovati come evidence, le decisioni e le
   contraddizioni incontrate nel sottografo.

### Hybrid retriever + scoring (`hybridRetriever.js`, `scoring.js`)

Fonde vector+graph, deduplica per id di chunk, applica lo scoring
configurabile:

```
score = vector_similarity * w1 + graph_proximity * w2 + relation_confidence * w3
      + recency * w4 + namespace_relevance * w5
      - penalità applicabili (fuori namespace, evidenza mancante,
        decisione superata, entità ambigua, bassa confidence,
        distanza elevata nel grafo, contenuto duplicato)
```

Pesi e penalità **sempre da configurazione** (`server/src/config.js`, env
`OMNIMEM_SCORE_*` / `OMNIMEM_PENALTY_*`), mai hardcoded nella logica.

**Fallback sicuro**: se il grafo non è abilitato o la query al grafo fallisce
(Neo4j giù, timeout...), si ritorna al solo vettoriale, con `fallbackToVector: true`
tracciato nel risultato e nella metrica `fallback_to_vector`.

## 5. Context builder (`server/src/context/contextBuilder.js`)

Sezioni distinte: `currentFacts`, `activeDecisions`, `historicalDecisions`,
`relatedEntities`, `dependencies`, `contradictions`, `evidence`, `sources`.
Regole:

- Le decisioni superate non appaiono mai tra le attive; quando è nota la
  decisione che le ha sostituite (`SUPERSEDES` nel sottografo espanso), viene
  citata esplicitamente.
- Le contraddizioni sono elencate senza essere risolte automaticamente per
  data/recency: la risoluzione (se possibile) è compito del modello a valle,
  con tutti gli elementi (data, fonte, confidence, stato decisione) a
  disposizione.
- Ogni fatto riporta provenienza (`chunk_id`, `source_url`, `platform`,
  `timestamp`).
- Nessun chunk è mai incluso due volte, anche se raggiunto da percorsi
  diversi del grafo (deduplicazione per id).
- Token budget rispettato con riempimento greedy in ordine di priorità
  (decisioni attive → storiche → contraddizioni → fatti → entità →
  dipendenze); quando il budget si esaurisce, `truncatedByBudget: true`.

**Limite noto**: la provenienza di un chunk trovato *solo* tramite
espansione grafo (non anche dal vettoriale) oggi riporta id e timestamp ma
non sempre `source_url`/`platform`, perché il nodo `Chunk` non porta con sé
i metadati della `Memory` collegata senza un hop esplicito aggiuntivo.
Estensione futura naturale (vedi sezione "Estensioni future").

## 6. Feature flag

| Flag | Default | Effetto |
|---|---|---|
| `OMNIMEM_GRAPHRAG_ENABLED` | `false` | Master switch: retriever ibrido attivo su `/api/query` (con fallback) |
| `OMNIMEM_GRAPH_INDEXING_ENABLED` | `false` | Dual write attivo (il grafo si popola) indipendentemente dall'uso in retrieval |
| `OMNIMEM_GRAPH_SHADOW_MODE` | `false` | Esegue anche l'ibrido per confronto/log, la risposta resta quella vettoriale |

Con tutti e tre `false` (default), **nessuna riga del percorso
`/api/query`/`/api/record` esistente cambia comportamento**: vedi il diff in
`server.js`, puramente additivo.

## 7. Sicurezza e isolamento

Ogni query Neo4j filtra sempre per `namespace` (mai un `MATCH` senza
`{namespace: $namespace}`), sia nelle letture singole sia nell'espansione
del grafo. Il filtro non è delegato al solo context builder: è applicato
anche lato ChromaDB (`where: { topic }`) e lato Neo4j, in ogni funzione del
`GraphRepository`. Test dedicato in
`server/test/integration/neo4j.integration.test.js`.

## 8. Osservabilità

`server/src/observability/metrics.js`: contatori e durate in-process, mai
contenuto testuale. Copre tutte le metriche richieste: `vector_retrieval_duration`,
`graph_retrieval_duration`, `hybrid_retrieval_duration`,
`graph_indexing_duration`, `entities_extracted`, `relations_extracted`,
`entity_merges`, `possible_duplicates`, `graph_failures`,
`fallback_to_vector`, `retrieved_chunks`, `graph_expansion_nodes`,
`graph_expansion_edges`. Esposte via `GET /api/graph/metrics`.

## 9. Estensioni future (non implementate, interfacce predisposte)

- **Global graph retrieval / community detection**: nessuna infrastruttura
  compatibile preesisteva nel repo, quindi non implementata in questo
  rilascio. Predisposta l'interfaccia concettuale (`CommunityBuilder`,
  `CommunitySummaryRepository`, `GlobalGraphRetriever`) come prossimo passo
  naturale una volta che il volume di dati nel grafo lo giustifichi.
- Arricchire la provenienza dei chunk graph-only con un hop esplicito verso
  `Memory` durante l'espansione.
- Merge automatico assistito (revisione umana dei `possible_duplicate`) via
  dashboard.
