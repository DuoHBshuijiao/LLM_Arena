@echo off
cd /d "%~dp0"
call npm install
if errorlevel 1 exit /b 1
start "LLM Arena dev" cmd /k "npm run dev"
timeout /t 8 /nobreak >nul
start http://localhost:9300/
