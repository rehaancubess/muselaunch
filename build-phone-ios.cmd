@echo off
rem Builds the MuseLaunch phone app for iPhone on Expo's servers (EAS Build) and sends it to
rem TestFlight (App Store Connect) with EAS Submit. Works from Windows: no Mac needed.
rem First time: it asks you to log in to Expo, then to your Apple Developer account so Expo can
rem make the certificate, provisioning profile and push notification key (answer Yes to each).
rem Steps and what to expect: mobile\README.md.
setlocal
cd /d "%~dp0mobile"
title MuseLaunch phone app - iPhone build for TestFlight

where node >nul 2>nul
if errorlevel 1 goto nonode

if exist node_modules goto installed
echo Installing the phone app's packages - first time only, a few minutes...
call npm install
if errorlevel 1 goto failed
:installed

call node scripts\prepare-build.mjs ios
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
echo ===================================================================
echo  Next, Expo asks for your APPLE DEVELOPER login (Apple ID, password,
echo  then the 6-digit code on your iPhone or Mac). Answer Yes when it
echo  offers to create the certificate, the provisioning profile and the
echo  push notifications key. The build takes about 15-25 minutes.
echo ===================================================================
echo.
call npx --yes eas-cli@latest build --platform ios --profile production
if errorlevel 1 goto failed

echo.
echo Sending this build to TestFlight. Log in to Apple again if asked. If it asks to
echo create the app in App Store Connect, answer Yes.
echo.
call npx --yes eas-cli@latest submit --platform ios --profile production --latest
if errorlevel 1 goto failed

echo.
echo ===================================================================
echo  Sent. Apple processes the build for about 10-30 minutes, then it
echo  shows in App Store Connect, TestFlight. Add yourself as a tester
echo  there (Internal Testing), install the TestFlight app on your iPhone
echo  and install MuseLaunch from it. Then link it from the web:
echo  Settings, Phone app, Link your phone.
echo ===================================================================
goto end

:nonode
echo Node.js is missing. Install it in PowerShell: winget install OpenJS.NodeJS.LTS
echo Then close this window and double-click build-phone-ios.cmd again.
goto end

:failed
echo.
echo The build stopped. Read the message above; mobile\README.md has the fixes for common ones.

:end
endlocal
pause
