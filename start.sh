#!/bin/bash

# Controlla se Ollama è attivo sulla porta standard (11434)
echo "[UKR] Verifica Ollama locale..."

if curl -s -f http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "[INFO] Ollama locale rilevato su localhost:11434."
    echo "[INFO] Uso l'istanza locale per sfruttare la GPU dell'host."
    export OLLAMA_BASE="http://host.docker.internal:11434"
    docker-compose up -d
else
    echo "[INFO] Ollama locale non trovato."
    echo "[INFO] Avvio Ollama in Docker (modalità CPU/isolata)..."
    export OLLAMA_BASE="http://ollama:11434"
    docker-compose --profile with-ollama up -d
fi

echo ""
echo "[UKR] Sistema in fase di avvio..."
echo "[UKR] Bridge Server diponibile su: http://localhost:3000"
echo "[UKR] ChromaDB disponibile su: http://localhost:8000"
echo ""
