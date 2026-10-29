@echo off
rem Checks the keys in .env with a few tiny real calls (a fraction of a cent).
rem Double-click: checks every key that's set (Meta, Baseten, Glimmer).
rem Or name the checks: "check-keys.cmd meta" / "check-keys.cmd media agents autopilot".
rem Keys are never printed. Results also go to fixtures\live\last-run.log; raw responses
rem (redacted) go to fixtures\live\raw\wire\.
setlocal
cd /d "%~dp0"
title MuseLaunch key check
set COREPACK_ENABLE_DOWNLOAD_PROMPT=0
rem FFmpeg installed by setup-tools.cmd may not be on this window's PATH yet.
call scripts\windows\ffmpeg-path.cmd
set "PNPM=pnpm"
where pnpm >nul 2>nul
if errorlevel 1 set "PNPM=npx --yes pnpm@10.28.0"

set "WHICH=%*"
if "%WHICH%"=="" set "WHICH=keys"

echo Checking setup...
call %PNPM% run doctor
echo.
echo Live check: %WHICH%
call %PNPM% smoke:live %WHICH%
echo.
echo Done. You can close this window.
pause
