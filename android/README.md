# OmniMem Companion (Android)

Scaffold iniziale del client mobile per OmniMem: un Accessibility Service +
overlay flottante che riusa gli endpoint esistenti (`/api/query`,
`/api/record`) del bridge server, senza modifiche server-side oltre al token
di auth già introdotto in `server/server.js`.

## Cosa fa

- Al posto del content script Chrome (che legge/scrive il DOM della pagina),
  usa un **Accessibility Service** per leggere/scrivere nell'albero
  `AccessibilityNodeInfo` di qualunque app in foreground.
- Un bottone flottante (overlay, visibile su tutte le app) si espande in un
  mini-pannello con due azioni:
  - **Rec** — cattura tutto il testo visibile a schermo e lo invia a
    `/api/record` con `platform` = nome del package dell'app sorgente.
  - **Inject** — legge il campo di testo attivo, interroga `/api/query` con
    quel testo come query, e prepende il contesto trovato nello stesso campo
    (via `ACTION_SET_TEXT`, con fallback clipboard/`ACTION_PASTE`), imitando
    `setPrompt()` nell'estensione Chrome.
- `SettingsActivity` (schermata di avvio) configura: URL server (l'hostname
  Tailscale del PC), token API, topic di default con autocomplete popolato
  da `/api/topics`; e apre le impostazioni di sistema per abilitare il
  servizio di accessibilità e il permesso overlay.

## Setup

1. Apri `android/` in Android Studio (genera da sé il Gradle wrapper).
2. Installa Tailscale sul PC dove gira il server e sul telefono; prendi
   l'hostname/IP Tailscale del PC (es. `http://100.x.x.x:3000`).
3. Se hai impostato `API_TOKEN` in `.env` sul server, usa lo stesso valore
   qui in "Token API".
4. Compila e installa l'app, apri OmniMem Companion, salva URL/token/topic,
   poi tocca "Abilita servizio di accessibilità" e "Consenti overlay su
   altre app" — entrambi richiedono conferma manuale nelle impostazioni di
   sistema, non sono concedibili via codice.

## Limiti noti / differenze rispetto all'estensione Chrome

- **Traffico cleartext (HTTP) abilitato globalmente** (`usesCleartextTraffic`
  nel manifest): necessario perché l'URL server è configurabile liberamente
  (Tailscale/LAN in HTTP semplice) e da Android 9 il traffico cleartext è
  bloccato di default quando il `targetSdk` è ≥28. Se in futuro il server
  gira dietro HTTPS (es. Tailscale Serve/Funnel), si può restringere con una
  Network Security Config invece del flag globale.
- **Rec cattura solo la schermata visibile**, non l'intera cronologia: a
  differenza di `scrollToLoadAll()` nell'estensione, l'Accessibility Service
  vede solo ciò che è renderizzato in quel momento. Serve scrollare
  manualmente e premere Rec più volte per catturare una chat lunga.
- **L'estrazione per messaggio è euristica, non affidabile al 100%**:
  `NodeExtractor.extractMessages()` cerca un contenitore con più figli dello
  stesso tipo con testo significativo (i "bubble" di una chat) e indovina il
  ruolo (`user`/`assistant`) dall'allineamento orizzontale del bubble
  rispetto al contenitore — una convenzione comune ma non universale tra le
  app. Se l'euristica non trova un contenitore plausibile, ripiega su un
  singolo messaggio `screen` con tutto il testo visibile.
- **`ACTION_SET_TEXT` non funziona su tutti i widget** — per questo
  `NodeInjector` ha un fallback via appunti + `ACTION_SET_SELECTION` +
  `ACTION_PASTE` (cursore spostato a inizio campo, poi incolla solo il
  blocco di contesto, senza duplicare il draft). Gli appunti originali
  vengono ripristinati dopo qualche secondo.
- **Non pensato per il Play Store**: `BIND_ACCESSIBILITY_SERVICE` e
  `SYSTEM_ALERT_WINDOW` richiedono review/prominent disclosure pesanti per
  un uso così ampio; distribuzione consigliata via APK sideload, coerente
  con la natura locale/personale del progetto.
- **iOS non è coperto** da questo modulo — richiederebbe una Custom Keyboard
  Extension separata (vedi discussione architetturale).

## Non verificato in questo ambiente

Il codice segue le API standard Android (AccessibilityService, WindowManager
overlay, OkHttp) ed è stato validato per sintassi XML/Kotlin, ma **non è
stato compilato**: questo container non ha l'Android SDK installato. Prima
di installarlo su un dispositivo, apri il progetto in Android Studio,
lascia risolvere le dipendenze e compila un build di debug.

## Prossimi passi suggeriti

- Servizio in foreground con notifica persistente, se si vuole rendere più
  visibile/affidabile la presenza dell'Accessibility Service su Android
  recenti (non implementato: gli Accessibility Service restano vivi di
  norma senza bisogno di una foreground notification, ma su alcuni OEM
  aggressivi nel kill dei processi in background può aiutare).
- Tuning dell'euristica di `findMessageContainer()` (soglie `MIN_TEXT_LEN`,
  `MIN_SIBLINGS`) se in pratica produce troppi falsi positivi/negativi su
  app reali — richiede test su dispositivo, non verificabile da qui.
- Persistenza locale delle ultime azioni Rec/Inject (solo per feedback
  utente, i dati restano comunque tutti sul server) se il toast risulta
  insufficiente come conferma.
