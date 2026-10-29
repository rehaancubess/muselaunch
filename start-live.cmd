@echo off
rem MuseLaunch on this PC with REAL AI: uses the keys in .env (Meta, Baseten, Glimmer, OpenAI).
rem Data is kept in memory (it resets when you close the windows); real model calls cost real
rem credits, capped by the spend ceilings in .env. For the keyless test version use start-demo.cmd.
setlocal
cd /d "%~dp0"
title MuseLaunch (live)

netstat -ano | findstr /r /c:":8080 .*LISTENING" >nul
if not errorlevel 1 goto busy
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul
if not errorlevel 1 goto busy

where node >nul 2>nul
if errorlevel 1 goto nonode
if not exist .env goto noenv

set COREPACK_ENABLE_DOWNLOAD_PROMPT=0
set "PNPM=pnpm"
where pnpm >nul 2>nul
if errorlevel 1 set "PNPM=npx --yes pnpm@10.28.0"

echo Checking dependencies...
call %PNPM% install
if errorlevel 1 goto installfail

if exist apps\web\.env.local goto start
> apps\web\.env.local echo NEXT_PUBLIC_API_URL=http://localhost:8080
>> apps\web\.env.local echo NEXT_PUBLIC_AUTH_MODE=dev

:start
rem Local single-machine settings. These override .env (dotenv never overrides what is already set).
set NODE_ENV=development
set APP_ENV=local
set DB_DRIVER=memory
set JOB_DISPATCH=inline
set STORAGE_DRIVER=local
set AUTH_MODE=dev
set AUTH_DEV_TOKENS=1
set PUBLIC_WEB_URL=http://localhost:3000
set API_PUBLIC_URL=http://localhost:8080

echo.
echo Your setup:
call %PNPM% run doctor
start "MuseLaunch API - LIVE" cmd /k %PNPM% --filter @muselaunch/api dev
start "MuseLaunch web" cmd /k %PNPM% --filter @muselaunch/web dev
echo.
echo MuseLaunch (live) is starting. Open http://localhost:3000 in about a minute.
echo Close the two server windows to stop it.
timeout /t 10 >nul
exit /b 0

:busy
echo Something is already running on port 3000 or 8080, probably start-demo.cmd.
echo Close those server windows first, then run this again.
pause
exit /b 1

:nonode
echo Node.js is not installed. In PowerShell run:  winget install OpenJS.NodeJS.LTS
pause
exit /b 1

:noenv
echo There is no .env file yet. Copy .env.example to .env and add your keys, then run this again.
pause
exit /b 1

:installfail
echo Installing dependencies failed. Scroll up for the error.
pause
exit /b 1
