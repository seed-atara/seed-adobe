@echo off
REM Builds SEED Frequency Detailer.aex against the After Effects SDK.
REM
REM The SDK is a licensed download and is not in this repository. Point at it:
REM   set AE_SDK=C:\path\to\...AfterEffectsSDK
setlocal enabledelayedexpansion

if "%AE_SDK%"=="" (
  set AE_SDK=%~dp0..\..\reference\afx_sdk\win\AfterEffectsSDK_25.6_61_win\ae25.6_61.64bit.AfterEffectsSDK
)
if not exist "%AE_SDK%\Examples\Headers\AE_Effect.h" (
  echo No After Effects SDK at "%AE_SDK%".
  echo Download it from https://adobe.io/after-effects and set AE_SDK.
  exit /b 1
)

for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set VSPATH=%%i
if "%VSPATH%"=="" echo No MSVC C++ toolset found. & exit /b 1
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1

set OUT=%~dp0build
if not exist "%OUT%" mkdir "%OUT%"

set INC=/I"%AE_SDK%\Examples\Headers" /I"%AE_SDK%\Examples\Headers\SP" /I"%AE_SDK%\Examples\Util" /I"%AE_SDK%\Examples\Resources"

REM ---------------------------------------------------------------- PiPL
REM
REM Without this resource After Effects never sees the plugin at all: it
REM compiles, links, exports both entry points, and simply does not appear in
REM the Effect menu. AE scans binaries for the PiPL to find out what they are
REM before it calls into them, so the runtime entry point is not a substitute.
set PIPL=%~dp0src\ae\SeedFrequencyDetailerPiPL

cl /nologo /I "%AE_SDK%\Examples\Headers" /EP "%PIPL%.r" > "%OUT%\pipl.rr" || exit /b 1
"%AE_SDK%\Examples\Resources\PiPLtool" "%OUT%\pipl.rr" "%OUT%\pipl.rrc" || exit /b 1
cl /nologo /D "MSWindows" /EP "%OUT%\pipl.rrc" > "%OUT%\pipl.rc" || exit /b 1
rc /nologo /fo "%OUT%\pipl.res" "%OUT%\pipl.rc" || exit /b 1

REM look.cpp comes along for GaussianBlur, the sRGB conversions and the
REM threading helpers: one blur shared between the two effects rather than two
REM that are meant to match.
cl /nologo /std:c++17 /O2 /EHsc /MT /DWIN32 /D_WINDOWS /DMSWindows=1 ^
   %INC% ^
   /LD /Fe:"%OUT%\SEED Frequency Detailer.aex" /Fo:"%OUT%\\" ^
   "%~dp0src\ae\SeedFrequencyDetailer.cpp" ^
   "%~dp0src\core\detail.cpp" ^
   "%~dp0..\seed-film-look\src\core\look.cpp" ^
   "%AE_SDK%\Examples\Util\Smart_Utils.cpp" ^
   "%OUT%\pipl.res" ^
   /link /OUT:"%OUT%\SEED Frequency Detailer.aex"
if errorlevel 1 exit /b 1

echo.
echo Built "%OUT%\SEED Frequency Detailer.aex"
echo Copy it to:
echo   C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore\
