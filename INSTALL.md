# Installazione e avvio di OmniMem

Guida rapida per installare e avviare tutti i componenti del progetto: server locale, estensione Chrome e (opzionale) companion Android. Per dettagli su utilizzo, API ed architettura vedi il [README](README.md) principale.

---

## 1. Prerequisiti

| Software | Necessario per | Download |
|---|---|---|
| Docker Desktop | Server + ChromaDB | [docker.com](https://docker.com) |
| Google Chrome | Estensione | — |
| Ollama (opzionale) | Embedding più veloce (GPU) se già installato sull'host | [ollama.com](https://ollama.com) |
| Node.js 18+ (opzionale) | Solo se vuoi il MCP server per Claude Code | [nodejs.org](https://nodejs.org) |
| Android Studio (opzionale) | Solo se vuoi il companion Android | [developer.android.com/studio](https://developer.android.com/studio) |

---

## 2. Clona il repository

```bash
git clone https://github.com/xias984/OmniMem.git
cd OmniMem
```

---

## 3. Avvia il server (Docker)

**Windows:** doppio click su `start.bat` (o eseguilo da terminale).

**macOS / Linux:**
```bash
chmod +x start.sh
./start.sh
```

Lo script rileva automaticamente se Ollama è già in esecuzione sull'host (e in tal caso lo usa, con GPU) oppure avvia un'istanza Ollama dentro Docker, scaricando da solo il modello di embedding necessario. Al termine avrai in esecuzione:

- Bridge server su `http://localhost:3000`
- ChromaDB su `http://localhost:8000`
- Ollama su `http://localhost:11434`

Verifica che sia tutto attivo aprendo **http://localhost:3000** nel browser: dovresti vedere la dashboard di OmniMem.

> Per fermare tutto: `docker compose down` (o chiudi semplicemente i container da Docker Desktop).

---

## 4. Installa l'estensione Chrome

1. Apri `chrome://extensions`
2. Attiva **Modalità sviluppatore** (in alto a destra)
3. Clicca **Carica estensione non pacchettizzata**
4. Seleziona la cartella `extension/` di questo repository
5. L'icona OmniMem compare nella barra degli strumenti — cliccala per aprire/chiudere il pannello sulle pagine

L'estensione punta di default a `http://localhost:3000`. Se hai impostato `API_TOKEN` nel server (vedi sotto), apri il popup dell'estensione e inserisci lo stesso token nel campo "Token API".

---

## 5. (Opzionale) Proteggi il server con un token

Di default il server non richiede autenticazione: va bene se resta raggiungibile solo da `localhost`. Se pensi di esporlo in rete (es. per usarlo dal telefono, vedi punto 6), impostagli un token prima:

1. Copia `.env.example` in `.env`
2. Decommenta e valorizza `API_TOKEN=un-token-a-tua-scelta`
3. Riavvia i container (`docker compose up -d --build` o rilancia `start.sh`/`start.bat`)
4. Inserisci lo stesso token nel popup dell'estensione Chrome (punto 4) e/o nell'app Android (punto 6)

---

## 6. (Opzionale) Companion Android

Il companion Android estende OmniMem al telefono tramite un Accessibility Service + bottone flottante (Rec/Inject su qualsiasi app). Il telefono deve poter raggiungere il server: se non sono sulla stessa rete locale, installa [Tailscale](https://tailscale.com) su entrambi i dispositivi.

1. Apri la cartella `android/` in Android Studio (il Gradle Wrapper è già incluso, non serve generarlo)
2. Compila e installa un build di debug sul telefono (`./gradlew installDebug` oppure Run da Android Studio)
3. Apri l'app **OmniMem Companion**, imposta:
   - **URL server** — `http://<ip-tailscale-o-lan-del-pc>:3000`
   - **Token API** — se impostato al punto 5
   - **Topic di default**
4. Tocca **"Abilita servizio di accessibilità"** e **"Consenti overlay su altre app"** — entrambi i permessi si concedono manualmente nelle impostazioni di sistema
5. Su qualsiasi app apparirà un bottone flottante con le azioni **Rec** e **Inject**

Dettagli, limiti noti e troubleshooting: [`android/README.md`](android/README.md).

---

## 7. (Opzionale) MCP server per Claude Code

Permette a Claude Code di leggere la tua memoria OmniMem e generare/mantenere una LLM Wiki.

```bash
cd mcp && npm install
```

Poi registra il server in `.mcp.json` (nella root del progetto) o nel tuo `.claude.json` globale — vedi la sezione dedicata nel [README](README.md#3-configura-il-mcp-server-in-claude-code-opzionale) per l'esempio di configurazione completo.

---

## Verifica finale

- `http://localhost:3000` → dashboard raggiungibile
- `http://localhost:3000/health` → `{"ok":true,...}`
- Estensione Chrome → l'icona apre il pannello su una pagina qualsiasi
- (Se installato) app Android → il bottone flottante compare e riesce a fare Rec/Inject su una chat di prova

Per l'uso quotidiano (Rec, Inject, dashboard, API, LLM Wiki) vedi il [README](README.md).
