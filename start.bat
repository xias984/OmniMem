@echo off
setlocal

echo [UKR] Verifica Ollama locale...
curl -s -f --connect-timeout 5 --max-time 10 http://localhost:11434/api/tags > nul 2>&1

if %errorlevel% == 0 goto :local_ollama
goto :docker_ollama

:local_ollama
echo [INFO] Ollama locale rilevato su localhost:11434.
echo [INFO] Uso l'istanza locale per sfruttare la GPU dell'host.
set OLLAMA_BASE=http://host.docker.internal:11434
docker-compose up -d
goto :done

:docker_ollama
echo [INFO] Ollama locale non trovato.
echo [INFO] Avvio Ollama in Docker (modalita CPU/isolata)...
set OLLAMA_BASE=http://ollama:11434
docker-compose --profile with-ollama up -d
goto :done

:done
echo.
echo [UKR] Sistema in fase di avvio...
echo [UKR] Bridge Server disponibile su: http://localhost:3000
echo [UKR] ChromaDB disponibile su: http://localhost:8000
echo.
pause
endlocal
