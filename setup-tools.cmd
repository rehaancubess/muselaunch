@echo off
rem One-time install of the tools MuseLaunch needs on this PC, using winget:
rem   FFmpeg               - video processing and rendering
rem   Google Cloud CLI     - putting MuseLaunch online (deploy.cmd)
rem Windows may ask "Do you want to allow this app to make changes?": click Yes.
rem Results also go to .data\logs\setup-tools.log.
setlocal
cd /d "%~dp0"
title MuseLaunch setup: tools
if not exist .data\logs mkdir .data\logs
set "LOG=.data\logs\setup-tools.log"
echo setup-tools started %date% %time%> "%LOG%"

where winget >nul 2>nul
if errorlevel 1 goto nowinget

call scripts\windows\ffmpeg-path.cmd
if not errorlevel 1 goto ffmpegok
echo Installing FFmpeg...
winget install --id Gyan.FFmpeg -e --silent --accept-source-agreements --accept-package-agreements
>> "%LOG%" echo ffmpeg winget exit code %errorlevel%
call scripts\windows\ffmpeg-path.cmd
if errorlevel 1 goto ffmpegmissing
:ffmpegok
echo FFmpeg: ready
echo ffmpeg: ready>> "%LOG%"
goto gcloud
:ffmpegmissing
echo FFmpeg: install did not finish (see above)
echo ffmpeg: MISSING after install>> "%LOG%"

:gcloud
call scripts\windows\gcloud-path.cmd
if not errorlevel 1 goto gcloudok
echo.
echo Installing the Google Cloud CLI (a few minutes)...
winget install --id Google.CloudSDK -e --silent --accept-source-agreements --accept-package-agreements
>> "%LOG%" echo gcloud winget exit code %errorlevel%
call scripts\windows\gcloud-path.cmd
if errorlevel 1 goto gcloudmissing
:gcloudok
echo Google Cloud CLI: ready
echo gcloud: ready>> "%LOG%"
goto done
:gcloudmissing
echo Google Cloud CLI: install did not finish (see above)
echo gcloud: MISSING after install>> "%LOG%"

:done
echo setup-tools finished %date% %time%>> "%LOG%"
echo.
echo Done. You can close this window.
pause
exit /b 0

:nowinget
echo winget isn't available on this PC. Install "App Installer" from the Microsoft Store, then run this again.
echo winget: MISSING>> "%LOG%"
pause
exit /b 1
