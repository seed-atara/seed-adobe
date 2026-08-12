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

REM Also into After Effects' own Plug-ins folder when it is there. MediaCore is
REM the shared location and should be enough, but AE's own folder is where
REM every effect it ships lives, and having both costs nothing but removes a
REM variable when something does not appear.
set AEDEST=C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\Plug-ins\Effects
if exist "%AEDEST%" (
  copy /Y "%SRC%" "%AEDEST%\SEED Film Look.aex" >nul && echo Installed to "%AEDEST%".
)

echo.
echo Restart After Effects, then look under Effect ^> SEED ^> SEED Film Look.
