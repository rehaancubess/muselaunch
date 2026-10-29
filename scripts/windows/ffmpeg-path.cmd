@echo off
rem Puts FFmpeg on PATH for the calling window when winget installed it but the window started
rem before the install. Call it, don't run it.
where ffmpeg >nul 2>nul
if not errorlevel 1 exit /b 0
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe" set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"
where ffmpeg >nul 2>nul
if not errorlevel 1 exit /b 0
for /d %%p in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*") do for /d %%q in ("%%~p\ffmpeg-*") do if exist "%%~q\bin\ffmpeg.exe" set "PATH=%%~q\bin;%PATH%"
where ffmpeg >nul 2>nul
