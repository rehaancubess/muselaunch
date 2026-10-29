@echo off
rem Sets up self-hosted Muse Glimmer on this PC's GPU (Ollama) and connects MuseLaunch to it.
rem One-time download of about 18-19 GB. After that it runs free and private on your own GPU.
setlocal
cd /d "%~dp0"
title Muse Glimmer setup

where ollama >nul 2>nul
if errorlevel 1 goto noollama

ollama list >nul 2>nul
if not errorlevel 1 goto pull
echo Starting the Ollama server...
start "Ollama server" /min ollama serve
timeout /t 6 >nul

:pull
echo Downloading Muse Glimmer: about 18-19 GB, one time...
ollama pull muse-glimmer
if errorlevel 1 goto pullfail

echo.
echo Creating muse-glimmer-muselaunch with a 32k context window...
ollama create muse-glimmer-muselaunch -f scripts\windows\glimmer.Modelfile
if errorlevel 1 goto createfail

echo.
echo Loading it onto the GPU for a quick test...
ollama run muse-glimmer-muselaunch "Reply with exactly one word: ready"
echo.
ollama ps

echo.
echo Connecting MuseLaunch to it in .env...
set "SETENV=powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\set-env.ps1"
%SETENV% GLIMMER_BASE_URL http://localhost:11434/v1
%SETENV% GLIMMER_API_KEY ollama
%SETENV% GLIMMER_MODEL muse-glimmer-muselaunch

set COREPACK_ENABLE_DOWNLOAD_PROMPT=0
set "PNPM=pnpm"
where pnpm >nul 2>nul
if errorlevel 1 set "PNPM=npx --yes pnpm@10.28.0"
echo.
echo Live check: a real Brand Guardian-style review on your GPU...
call %PNPM% smoke:live glimmer
echo.
echo Done. In "ollama ps" above, PROCESSOR should say 100%% GPU.
pause
exit /b 0

:noollama
echo Ollama isn't installed. Install it from https://ollama.com/download and run this again.
pause
exit /b 1

:pullfail
echo The download failed. Check your internet connection and that 30 GB of disk is free, then run this again.
pause
exit /b 1

:createfail
echo Creating the 32k-context copy failed. Scroll up for the error.
pause
exit /b 1
