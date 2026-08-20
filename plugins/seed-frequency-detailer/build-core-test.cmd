@echo off
REM Builds and runs the C++ core test. Needs only MSVC — no Adobe SDK, because
REM the core deliberately has no Adobe headers in it.
setlocal
for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set VSPATH=%%i
if "%VSPATH%"=="" echo No MSVC C++ toolset found. & exit /b 1
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1

set OUT=%~dp0build
if not exist "%OUT%" mkdir "%OUT%"

REM look.cpp comes along for GaussianBlur and the sRGB conversions: one blur
REM shared between the two effects rather than two that are meant to match.
cl /nologo /std:c++17 /O2 /EHsc /W4 /Fe:"%OUT%\detailtest.exe" /Fo:"%OUT%\\" ^
   "%~dp0test\detailtest.cpp" "%~dp0src\core\detail.cpp" ^
   "%~dp0..\seed-film-look\src\core\look.cpp"
if errorlevel 1 exit /b 1

"%OUT%\detailtest.exe"
