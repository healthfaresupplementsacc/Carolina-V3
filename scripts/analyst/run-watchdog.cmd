@echo off
REM Wrapper do Slack Watchdog 24/7 — chamado pela Scheduled Task / Startup.
REM Sem argumentos externos: caminhos fixos, sem quoting-hell.
cd /d "%~dp0"
:loop
node "%~dp0slack-watchdog.js" >> "%~dp0_watch\watchdog.log" 2>&1
REM se o node morrer por qualquer motivo, espera 5s e sobe de novo (auto-heal)
timeout /t 5 /nobreak >nul
goto loop
