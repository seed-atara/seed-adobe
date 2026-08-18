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

REM After Effects reads MediaCore too, so a second copy in its own Effects
REM folder is not redundancy — it is a duplicate, and After Effects says so at
REM launch: "There is a duplicated effect plugin installed on your drive."
REM
REM Earlier versions of this script installed to both on the theory that it
REM cost nothing. It cost a warning dialog on every launch. MediaCore is the
REM shared location and the only one needed; anything left in the AE-specific
REM folder by those earlier runs is removed here.
set AEDEST=C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\Plug-ins\Effects
if exist "%AEDEST%\SEED Film Look.aex" (
  del /Q "%AEDEST%\SEED Film Look.aex" >nul 2>&1
  if exist "%AEDEST%\SEED Film Look.aex" (
    echo.
    echo Could not remove the duplicate at "%AEDEST%".
    echo Delete it by hand, or After Effects will warn at launch.
  ) else (
    echo Removed the duplicate from "%AEDEST%".
  )
)

echo.
echo Restart After Effects, then look under Effect ^> SEED ^> SEED Film Look.
