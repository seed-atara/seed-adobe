@echo off
REM Installs SEED Frequency Detailer.aex.
REM
REM MediaCore is under Program Files, so this needs an elevated prompt:
REM right-click > Run as administrator, or run it from an admin terminal.
setlocal

set SRC=%~dp0build\SEED Frequency Detailer.aex
set DEST=C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore

if not exist "%SRC%" echo Build it first: npm run detailer:build & exit /b 1
if not exist "%DEST%" echo No MediaCore folder at "%DEST%". & exit /b 1

copy /Y "%SRC%" "%DEST%\SEED Frequency Detailer.aex" >nul
if errorlevel 1 (
  echo.
  echo Could not write to "%DEST%".
  echo Run this from an elevated prompt — MediaCore lives under Program Files.
  exit /b 1
)

echo Installed to "%DEST%".

REM One location only. Installing to After Effects' own Effects folder as well
REM produces "There is a duplicated effect plugin installed on your drive." at
REM every launch — the film look learned that the expensive way.
set AEDEST=C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\Plug-ins\Effects
if exist "%AEDEST%\SEED Frequency Detailer.aex" (
  del /Q "%AEDEST%\SEED Frequency Detailer.aex" >nul 2>&1
  if exist "%AEDEST%\SEED Frequency Detailer.aex" (
    echo.
    echo Could not remove the duplicate at "%AEDEST%".
    echo Delete it by hand, or After Effects will warn at launch.
  ) else (
    echo Removed the duplicate from "%AEDEST%".
  )
)

echo.
echo Restart After Effects, then look under Effect ^> SEED ^> SEED Frequency Detailer.
