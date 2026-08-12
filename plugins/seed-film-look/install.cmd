@echo off
REM Installs SEED Film Look.aex for After Effects and Premiere.
REM
REM MediaCore is under Program Files, so this needs an elevated prompt:
REM right-click > Run as administrator, or run it from an admin terminal.
setlocal

set SRC=%~dp0build\SEED Film Look.aex
set DEST=C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore

if not exist "%SRC%" echo Build it first: npm run plugin:build & exit /b 1
if not exist "%DEST%" echo No MediaCore folder at "%DEST%". & exit /b 1

copy /Y "%SRC%" "%DEST%\SEED Film Look.aex" >nul
if errorlevel 1 (
  echo.
  echo Could not write to "%DEST%".
  echo Run this from an elevated prompt — MediaCore lives under Program Files.
  exit /b 1
)

echo Installed to "%DEST%".
echo Restart After Effects, then look under Effect ^> SEED ^> SEED Film Look.
