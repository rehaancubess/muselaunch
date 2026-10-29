@echo off
rem Puts MuseLaunch online on Google Cloud (project and region from .env: FIREBASE_PROJECT_ID, DEPLOY_REGION).
rem Safe to run again: it updates what's there. The first run takes about 20-30 minutes.
rem Needs the Google Cloud CLI once: double-click setup-tools.cmd first.
rem Every step is also written to .data\logs\deploy.log.
setlocal
cd /d "%~dp0"
title MuseLaunch deploy

call scripts\windows\gcloud-path.cmd
if errorlevel 1 goto nogcloud
where node >nul 2>nul
if errorlevel 1 goto nonode
if not exist .env goto noenv

set "ACCOUNT="
for /f "delims=" %%a in ('gcloud auth list --filter^=status:ACTIVE --format^="value(account)" 2^>nul') do set "ACCOUNT=%%a"
if defined ACCOUNT goto signedin
echo Sign in to Google Cloud in the browser window that opens (the Google account that owns the MuseLaunch project).
call gcloud auth login
set "ACCOUNT="
for /f "delims=" %%a in ('gcloud auth list --filter^=status:ACTIVE --format^="value(account)" 2^>nul') do set "ACCOUNT=%%a"
if not defined ACCOUNT goto nosignin

:signedin
echo Signed in to Google Cloud as %ACCOUNT%
set COREPACK_ENABLE_DOWNLOAD_PROMPT=0
set "PNPM=pnpm"
where pnpm >nul 2>nul
if errorlevel 1 set "PNPM=npx --yes pnpm@10.28.0"

echo.
echo Checking dependencies...
call %PNPM% install
if errorlevel 1 goto failed

echo.
echo Deploying. The first run takes about 20-30 minutes (it builds four containers on Google Cloud).
call %PNPM% deploy:gcp %*
if errorlevel 1 goto failed
echo.
echo Done. The web and API addresses are printed above. Tell Claude so it can finish the sign-in setup.
pause
exit /b 0

:nogcloud
echo The Google Cloud CLI isn't installed yet: double-click setup-tools.cmd first, then deploy.cmd again.
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

:nosignin
echo Google Cloud sign-in didn't finish. Run deploy.cmd again and complete the sign-in in the browser.
pause
exit /b 1

:failed
echo.
echo The deploy stopped with an error (scroll up). The full log is in .data\logs\deploy.log
pause
exit /b 1
