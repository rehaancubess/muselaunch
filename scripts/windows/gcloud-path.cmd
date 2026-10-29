@echo off
rem Puts the Google Cloud CLI on PATH for the calling window when it's installed but the window
rem started before the install (Windows only refreshes PATH for new windows). Call it, don't run it.
where gcloud >nul 2>nul
if not errorlevel 1 exit /b 0
for %%d in ("%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin" "%ProgramFiles(x86)%\Google\Cloud SDK\google-cloud-sdk\bin" "%ProgramFiles%\Google\Cloud SDK\google-cloud-sdk\bin") do if exist "%%~d\gcloud.cmd" set "PATH=%%~d;%PATH%"
where gcloud >nul 2>nul
