@echo off
REM Wrapper com auto-heal (09-08). NAO redireciona log: o disputa do >> entre
REM instancias travava o loop ("file being used by another process").
REM `ping` no lugar de `timeout` porque timeout /t exige console interativo.
cd /d "%~dp0"
:loop
node "%~dp0scheduler.js"
REM 42 = ja existe outra instancia viva (single-instance.js): este wrapper sai.
if "%errorlevel%"=="42" exit /b 0
ping -n 6 127.0.0.1 >nul
goto loop
