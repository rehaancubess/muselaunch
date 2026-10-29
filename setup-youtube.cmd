@echo off
rem Creates the YouTube API key for public channel stats (restricted to YouTube Data API v3) and
rem saves it in .env as YOUTUBE_API_KEY, without showing it. Run deploy.cmd or setup-tools.cmd first.
setlocal
cd /d "%~dp0"
title MuseLaunch setup: YouTube key
call scripts\windows\gcloud-path.cmd
if errorlevel 1 goto nogcloud
set "ACCOUNT="
for /f "delims=" %%a in ('gcloud auth list --filter^=status:ACTIVE --format^="value(account)" 2^>nul') do set "ACCOUNT=%%a"
if defined ACCOUNT goto run
echo Sign in to Google Cloud in the browser window that opens.
call gcloud auth login
:run
node scripts\windows\youtube-key.mjs
if errorlevel 1 goto failed
echo.
echo Done. You can close this window.
pause
exit /b 0

:nogcloud
echo The Google Cloud CLI isn't installed yet: double-click setup-tools.cmd first.
pause
exit /b 1

:failed
echo The YouTube key wasn't created (see above).
pause
exit /b 1
