@echo off
rem Checks the API keys in .env with a few tiny real calls (a fraction of a cent).
rem Keys are never printed. Raw responses (redacted) go to fixtures\live\raw\wire\.
rem Usage: double-click (checks Baseten), or run "check-keys.cmd meta" / "check-keys.cmd media".
setlocal
cd /d "%~dp0"
title MuseLaunch key check
set COREPACK_ENABLE_DOWNLOAD_PROMPT=0
set "PNPM=pnpm"
where pnpm >nul 2>nul
if errorlevel 1 set "PNPM=npx --yes pnpm@10.28.0"

set "WHICH=%~1"
if "%WHICH%"=="" set "WHICH=baseten"

echo Checking setup...
call %PNPM% doctor
echo.
echo Live check: %WHICH%
call %PNPM% smoke:live %WHICH%
echo.
echo Done. You can close this window.
pause
