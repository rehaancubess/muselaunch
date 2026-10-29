@echo off
rem MuseLaunch local demo (fixture mode): no API keys or cloud needed.
rem AI answers come from labelled test fixtures; rendering, storage, jobs and billing are real.
rem Double-click this file. Two server windows open; close them to stop.
setlocal
cd /d "%~dp0"
title MuseLaunch setup

where node >nul 2>nul
if errorlevel 1 goto nonode
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 22 goto oldnode

rem Never stop to ask before corepack downloads pnpm.
set COREPACK_ENABLE_DOWNLOAD_PROMPT=0
set "PNPM=pnpm"
where pnpm >nul 2>nul
if errorlevel 1 call corepack enable >nul 2>nul
where pnpm >nul 2>nul
if errorlevel 1 set "PNPM=npx --yes pnpm@10.28.0"

echo Installing dependencies. The first run takes a few minutes...
call %PNPM% install
if errorlevel 1 goto installfail

rem The keyless demo always uses the local test sign-in.
node scripts\windows\web-env.mjs dev >nul

:start
start "MuseLaunch API - fixture mode" cmd /k %PNPM% dev:fixture
start "MuseLaunch web" cmd /k %PNPM% --filter @muselaunch/web dev
echo.
echo MuseLaunch is starting. Open http://localhost:3000 in about a minute.
echo Close the two server windows to stop it.
timeout /t 8 >nul
exit /b 0

:nonode
echo Node.js is not installed. In PowerShell run:  winget install OpenJS.NodeJS.LTS
echo Then reopen this file.
pause
exit /b 1

:oldnode
echo Node %NODEMAJOR% is installed, but MuseLaunch needs Node 22 or newer.
echo In PowerShell run:  winget upgrade OpenJS.NodeJS.LTS
pause
exit /b 1

:installfail
echo Installing dependencies failed. Scroll up for the error.
pause
exit /b 1
