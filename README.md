# OmniMem

Un sistema privato e locale per catturare conversazioni da qualsiasi AI web, indicizzarle in un database vettoriale e iniettarle come contesto in qualsiasi altra chat — senza che i tuoi dati lascino mai il PC.

---

## Architettura

```
Browser (Estensione Chrome)
    │
    │  HTTP a localhost:3000
    ▼
Server Node.js  ──►  Ollama (embedding locale)
    │
    ▼
ChromaDB (database vettoriale locale)
    ▲
    │
MCP Server (Claude Code — stdio locale)
```

| Componente | Tecnologia | Porta |
|---|---|---|
| Estensione | Chrome MV3 | — |
| Bridge server | Node.js + Express | 3000 |
| Database vettoriale | ChromaDB | 8000 |
| Embedding | Ollama `nomic-embed-text` | 11434 |
| MCP server | Node.js stdio | — |

---

## Prerequisiti

| Software | Download | Note |
|---|---|---|
| Docker Desktop | [docker.com](https://docker.com) | Necessario per containerizzare i servizi |
| Ollama (Opzionale) | [ollama.com](https://ollama.com) | Se installato sull'host, UKR lo userà per maggiore velocità (GPU) |
| Google Chrome | — | Per l'estensione |

---

## Avvio rapido (Docker)

Il modo più veloce per avviare UKR su Windows, Mac o Linux è usare Docker. Il sistema rileverà automaticamente se hai già Ollama installato sul PC per garantirti il massimo delle prestazioni.

### 1. Avvio dei servizi
Usa lo script corrispondente al tuo sistema operativo nella cartella principale:

**Su Windows:**
Doppio click su `start.bat` (o scrivi `start.bat` nel terminale).

**Su macOS / Linux:**
```bash
chmod +x start.sh
./start.sh
```

### 2. Cosa succede all'avvio?
- **Se Ollama è attivo sul tuo PC:** Lo script lo rileva e configura Docker per usare quello (sfruttando la tua scheda video).
- **Se Ollama NON è attivo:** Docker avvierà un'istanza interna di Ollama (modalità CPU/isolata) e scaricherà automaticamente il modello di embedding necessario.
- **ChromaDB e Bridge Server:** Vengono avviati automaticamente in container separati.

---

## Installazione estensione Chrome

1. Apri Chrome e vai su `chrome://extensions`
2. Attiva **Modalità sviluppatore** (toggle in alto a destra)
3. Clicca **Carica estensione non pacchettizzata**
4. Seleziona la cartella `extension/` di questo progetto
5. L'icona OmniMem apparirà nella barra degli strumenti di Chrome

### 3. Configura il MCP server in Claude Code (opzionale)

Il MCP server permette a Claude Code di accedere alla tua memoria OmniMem e generare briefing strutturati.

```bash
cd mcp && npm install
```

Aggiungi la configurazione al file `.mcp.json` nella root del progetto (condiviso col repo, raccomandato per il team) oppure a `C:\Users\<tuo-utente>\.claude.json` (globale, solo per te):

```json
{
  "mcpServers": {
    "omnimem": {
      "command": "node",
      "args": ["C:/percorso/assoluto/memory-ext-ai/mcp/omnimem-mcp.js"],
      "env": {
        "CHROMA_URL": "http://localhost:8000"
      }
    }
  }
}
```

---

## Utilizzo

### Registrare una conversazione (Rec)

1. Vai su una chat AI supportata (ChatGPT, Gemini, Claude, DeepSeek)
2. Clicca sull'icona OmniMem nella barra Chrome → **Apri pannello OmniMem**
3. Inserisci un **argomento** nel campo testo (es. `Coding Python`, `Salute`, `Fiscale 2024`)
4. Clicca **● Rec**

Il sistema estrae tutti i messaggi visibili nella pagina, li divide in chunk con overlap, li trasforma in vettori tramite Ollama e li salva in ChromaDB con i metadati `platform`, `topic`, `source_url`, `timestamp`.

### Iniettare il contesto RAG (Inject)

1. Su qualsiasi chat AI, scrivi la tua domanda nel campo testo
2. Apri il pannello OmniMem, seleziona lo stesso argomento usato in fase di Rec
3. Clicca **↑ Inject**

Il sistema cerca i chunk più simili alla tua domanda nel database e li prepende nel campo testo:

```
--- CONTESTO DALLA TUA MEMORIA PERSONALE ---
[1] [ChatGPT — Coding Python]
<testo del chunk recuperato>
[2] ...
--- FINE CONTESTO ---

<la tua domanda originale>
```

### Piattaforma non riconosciuta

Se usi una AI non nella lista supportata:

1. Clicca **✎ Target manuale**
2. Il cursore diventa una croce — clicca sul campo testo della chat
3. OmniMem memorizzerà quel campo come target per l'iniezione

### Generare/aggiornare una LLM Wiki con Claude Code

Con il MCP server configurato, chiedi direttamente a Claude Code:

```
Usa il tool omnimem per il topic "Coding Python"
```

Il MCP non genera un singolo briefing: istruisce Claude Code a costruire e mantenere una **LLM Wiki** (pattern [Karpathy](https://karpathy.bearblog.dev/llm-wiki/)) nella directory di lavoro corrente — una collezione interlinkata di pagine markdown che si arricchisce nel tempo invece di essere ri-derivata a ogni query.

**Prima chiamata su un topic** (cursore vuoto):
- Claude Code crea `<topic>_Wiki/` nella CWD
- Inizializza `CLAUDE.md` (schema), `Index.md` (catalogo), `log.md` (cronologico), una pagina di overview, e una pagina markdown per ogni entità/concetto estratto dai chunk, con interlink `[[Nome_Pagina]]`
- Restituisce **tutti** i chunk del topic

**Chiamate successive** (modalità incrementale automatica):
- Il MCP mantiene un **cursore per topic** in `mcp/.omnimem-cursors.json` (timestamp dell'ultimo chunk consegnato)
- Ogni nuova chiamata restituisce **solo i chunk arrivati dopo l'ultima sincronizzazione**
- Claude Code legge la wiki esistente e integra i nuovi chunk in modo additivo: aggiorna le pagine impattate, ne crea di nuove se emergono entità inedite, appende una voce a `log.md`
- Zero token sprecati a rileggere ciò che è già stato sintetizzato

Per forzare il re-import completo (ignorando il cursore), chiama il tool con `full=true`.

Tutta l'elaborazione usa il tuo abbonamento Claude Team — nessuna chiamata a API esterne, nessun OpenAI key.

### Esportare la memoria (raw)

```bash
curl http://localhost:3000/api/export/Coding%20Python -o coding_python.md
```

Genera un file Markdown grezzo con tutti i chunk del topic, ordinati per timestamp.

---

## Piattaforme supportate

| Piattaforma | Estrazione messaggi | Iniezione prompt |
|---|---|---|
| ChatGPT (`chat.openai.com`) | ✓ | ✓ |
| Gemini (`gemini.google.com`) | ✓ | ✓ |
| Claude (`claude.ai`) | ✓ | ✓ |
| DeepSeek (`chat.deepseek.com`) | ✓ | ✓ |
| Qualsiasi altra | — | ✓ (target manuale) |

---

## API Server

| Endpoint | Metodo | Descrizione |
|---|---|---|
| `/health` | GET | Stato del server |
| `/api/record` | POST | Salva messaggi in ChromaDB (asincrono) |
| `/api/progress/:jobId` | GET | Stato di avanzamento di un job |
| `/api/query` | POST | Cerca chunk per similarità |
| `/api/topics` | GET | Lista tutti i topic salvati |
| `/api/export/:topic` | GET | Esporta memoria come Markdown |
| `/api/ingest-codebase` | POST | Indicizza un progetto locale (asincrono) |
| `/api/topics/:topic` | DELETE | Elimina tutti i chunk di un topic |

**POST /api/record — body:**
```json
{
  "messages": [{"role": "user", "text": "..."}, {"role": "assistant", "text": "..."}],
  "topic": "Coding Python",
  "metadata": {
    "source_url": "https://chatgpt.com/...",
    "platform": "ChatGPT",
    "timestamp": 1700000000000
  }
}
```

**POST /api/query — body:**
```json
{
  "query": "come si fa un decorator in Python?",
  "topic": "Coding Python",
  "k": 4
}
```

**POST /api/ingest-codebase — body:**
```json
{
  "path": "C:/progetti/mio-progetto",
  "topic": "MioProgetto",
  "extensions": ["js", "ts", "md"]
}
```

---

## Struttura del progetto

```
memory-ext-ai/
├── extension/
│   ├── manifest.json       # Configurazione estensione Chrome MV3
│   ├── content_script.js   # Logica estrazione e iniezione
│   ├── popup.html          # UI popup toolbar
│   └── popup.js            # Toggle pannello
├── mcp/
│   ├── omnimem-mcp.js      # MCP server stdio per Claude Code
│   └── package.json
├── server/
│   ├── server.js           # Express + ChromaDB + Ollama
│   ├── Dockerfile
│   └── package.json
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## Cosa aspettarsi

**Prima volta che clicchi Rec:**
- Il primo embedding richiede 2-4 secondi (il modello si carica in memoria)
- Le volte successive sono istantanee

**Qualità del RAG:**
- Funziona meglio con argomenti specifici: `React Hooks` è più preciso di `Coding`
- Usa lo stesso identico argomento sia in Rec che in Inject per ottenere i risultati migliori
- Il sistema filtra automaticamente i chunk con similarità troppo bassa

**Limiti attuali:**
- L'estrazione funziona solo sui messaggi visibili nella pagina: fai scroll verso l'alto prima di cliccare Rec su conversazioni lunghe
- Su Gemini il selettore potrebbe variare dopo aggiornamenti dell'interfaccia — in quel caso usa la modalità Target manuale

---

## Privacy

Tutti i dati rimangono sul tuo PC:
- Gli embedding vengono calcolati da Ollama in locale (nessuna chiamata a API esterne)
- ChromaDB salva i dati in un volume Docker locale
- Il server Node non fa nessuna richiesta verso internet
- Il MCP server usa il tuo abbonamento Claude Team (claude.ai) — nessuna API key separata
