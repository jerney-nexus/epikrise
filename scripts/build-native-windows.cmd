@echo off
setlocal

set "windows_arch=%~1"
set "build_mode=%~2"
if not defined build_mode set "build_mode=diagnostic"

if /I "%windows_arch%"=="x64" (
  set "windows_arch=x64"
) else if /I "%windows_arch%"=="arm64" (
  set "windows_arch=arm64"
) else (
  echo Usage: %~nx0 ^<x64^|arm64^> [diagnostic^|release] 1>&2
  exit /b 2
)

set "vswhere=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%vswhere%" goto vswhere_found
echo Visual Studio locator was not found: "%vswhere%" 1>&2
exit /b 1
:vswhere_found

set "VSINSTALLDIR="
set "vswhere_output=%TEMP%\epikrise-vswhere-%RANDOM%.txt"
"%vswhere%" -latest -products * -property installationPath > "%vswhere_output%"
if not errorlevel 1 goto vswhere_query_succeeded
del /q "%vswhere_output%" >nul 2>&1
echo Visual Studio installation could not be located by vswhere. 1>&2
exit /b 1
:vswhere_query_succeeded
set /p "VSINSTALLDIR="<"%vswhere_output%"
del /q "%vswhere_output%" >nul 2>&1
if not defined VSINSTALLDIR (
  echo Visual Studio installation was not found. 1>&2
  exit /b 1
)

set "vcvarsall=%VSINSTALLDIR%\VC\Auxiliary\Build\vcvarsall.bat"
if exist "%vcvarsall%" goto vcvarsall_found
echo Visual Studio environment setup was not found: "%vcvarsall%" 1>&2
exit /b 1
:vcvarsall_found

call "%vcvarsall%" %windows_arch%
if errorlevel 1 exit /b %errorlevel%

if /I not "%VSCMD_ARG_HOST_ARCH%"=="%windows_arch%" (
  echo MSVC host architecture %VSCMD_ARG_HOST_ARCH% does not match %windows_arch%. 1>&2
  exit /b 1
)
if /I not "%VSCMD_ARG_TGT_ARCH%"=="%windows_arch%" (
  echo MSVC target architecture %VSCMD_ARG_TGT_ARCH% does not match %windows_arch%. 1>&2
  exit /b 1
)

set "msvc_tools_bin=%VCToolsInstallDir%bin\Host%VSCMD_ARG_HOST_ARCH%\%VSCMD_ARG_TGT_ARCH%"
if exist "%msvc_tools_bin%\cl.exe" goto msvc_tools_found
echo Visual Studio compiler was not found: "%msvc_tools_bin%\cl.exe" 1>&2
exit /b 1
:msvc_tools_found
set "EPIKRISE_MSVC_TOOLS_BIN=%msvc_tools_bin%"

call bash scripts/build-native-windows.sh "%windows_arch%" "%build_mode%"
exit /b %errorlevel%
