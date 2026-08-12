@echo off
REM Builds and runs the C++ core parity test. Needs only MSVC — no Adobe SDK.
setlocal
for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set VSPATH=%%i
if "%VSPATH%"=="" echo No MSVC C++ toolset found. & exit /b 1
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1

set OUT=%~dp0build
if not exist "%OUT%" mkdir "%OUT%"

cl /nologo /std:c++17 /O2 /EHsc /W4 /Fe:"%OUT%\parity.exe" /Fo:"%OUT%\\" ^
   "%~dp0test\parity.cpp" "%~dp0src\core\look.cpp"
if errorlevel 1 exit /b 1

"%OUT%\parity.exe" "%~dp0test\vectors.json"
