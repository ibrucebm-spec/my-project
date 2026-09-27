@echo off
chcp 65001 >nul
cd /d "%~dp0"
title XAU AI Desk
where node >nul 2>nul
if errorlevel 1 (
  echo Nie znaleziono Node.js. Zainstaluj go ze strony https://nodejs.org ^(wersja LTS^) i uruchom ten plik ponownie.
  pause
  exit /b 1
)
if not exist node_modules\@anthropic-ai\sdk (
  echo Instaluję biblioteki ^(jednorazowo, potrzebny internet^)...
  call npm install --omit=dev --no-audit --no-fund
)
node scripts\setup-env.js
start "" http://localhost:3000
node server\index.js
echo.
echo Serwer zatrzymany.
pause
