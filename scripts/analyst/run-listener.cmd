@echo off
REM Wrapper do Socket Mode Listener (push em tempo real do Slack).
REM Auto-heal: se o node morrer, espera 5s e sobe de novo.
cd /d "%~dp0"
:loop
node "%~dp0slack-socket-listener.js" >> "%~dp0_watch\listener.log" 2>&1
timeout /t 5 /nobreak >nul
goto loop
