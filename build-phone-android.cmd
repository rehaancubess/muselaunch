@echo off
rem Builds the MuseLaunch phone app for Android on Expo's servers (EAS Build) and gives you a link
rem to install it: an APK you install on your phone directly (internal distribution, no Play Store).
rem First time: it asks you to log in to Expo, to create the Expo project (Yes) and to make an
rem Android keystore (Yes). Takes about 10-20 minutes. Steps and push setup: mobile\README.md.
setlocal
cd /d "%~dp0mobile"
title MuseLaunch phone app - Android build

where node >nul 2>nul
if errorlevel 1 goto nonode

if exist node_modules goto installed
echo Installing the phone app's packages - first time only, a few minutes...
call npm install
if errorlevel 1 goto failed
:installed

call node scripts\prepare-build.mjs android
if errorlevel 1 goto failed

rem Upload only mobile\ to EAS (not the whole repository); mobile\.easignore says what to leave out.
set EAS_NO_VCS=1
set "EAS_PROJECT_ROOT=%CD%"

call npx --yes eas-cli@latest whoami >nul 2>nul
if not errorlevel 1 goto loggedin
echo.
echo ===================================================================
echo  Log in to Expo now: type your Expo username or email and password.
echo ===================================================================
call npx --yes eas-cli@latest login
if errorlevel 1 goto failed
:loggedin
for /f "delims=" %%a in ('npx --yes eas-cli@latest whoami 2^>nul') do echo Logged in to Expo as %%a

echo.
echo Building the Android app on Expo's servers. This takes about 10-20 minutes.
echo If it asks to create an EAS project or a keystore, answer Yes.
echo.
call npx --yes eas-cli@latest build --platform android --profile preview
if errorlevel 1 goto failed

echo.
echo ===================================================================
echo  Done. Open the build link above on your Android phone (or scan its
echo  QR code), download the APK and install it. If Android asks, allow
echo  your browser to install apps. Then open MuseLaunch and link it from
echo  the web: Settings, Phone app, Link your phone.
echo ===================================================================
goto end

:nonode
echo Node.js is missing. Install it in PowerShell: winget install OpenJS.NodeJS.LTS
echo Then close this window and double-click build-phone-android.cmd again.
goto end

:failed
echo.
echo The build stopped. Read the message above; mobile\README.md has the fixes for common ones.

:end
endlocal
pause
