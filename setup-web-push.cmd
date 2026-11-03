@echo off
rem Makes the key pair MuseLaunch uses to send notifications to browsers (they arrive even with
rem MuseLaunch closed) and saves it in .env, without showing the private key. Run it once, then
rem deploy.cmd puts it online (the private key goes to Google Secret Manager).
rem "setup-web-push.cmd --force" makes a new pair (every browser then has to turn notifications on again).
setlocal
cd /d "%~dp0"
title MuseLaunch setup: browser notifications

where node >nul 2>nul
if errorlevel 1 goto nonode

set COREPACK_ENABLE_DOWNLOAD_PROMPT=0
set "PNPM=pnpm"
where pnpm >nul 2>nul
if errorlevel 1 set "PNPM=npx --yes pnpm@10.28.0"

if exist node_modules goto run
echo Installing dependencies (first time only)...
call %PNPM% install
if errorlevel 1 goto failed

:run
call %PNPM% setup:web-push %*
if errorlevel 1 goto failed
echo.
echo Done. You can close this window.
pause
exit /b 0

:nonode
echo Node.js is not installed. In PowerShell run:  winget install OpenJS.NodeJS.LTS
pause
exit /b 1

:failed
echo.
echo The keys weren't saved (see above).
pause
exit /b 1
