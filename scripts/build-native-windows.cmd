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
if /I "%windows_arch%"=="arm64" goto vs_arm64_component
set "vs_component=Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
goto vs_component_ready
:vs_arm64_component
set "vs_component=Microsoft.VisualStudio.Component.VC.Tools.ARM64"
:vs_component_ready
"%vswhere%" -latest -products * -requires %vs_component% -property installationPath > "%vswhere_output%"
if not errorlevel 1 goto vswhere_query_succeeded
del /q "%vswhere_output%" >nul 2>&1
echo Visual Studio with the required %windows_arch% C++ tools could not be located by vswhere. 1>&2
exit /b 1
:vswhere_query_succeeded
set /p "VSINSTALLDIR="<"%vswhere_output%"
del /q "%vswhere_output%" >nul 2>&1
if not defined VSINSTALLDIR (
  echo Visual Studio with the required %windows_arch% C++ tools was not found. 1>&2
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

set "vs_cmake_bin=%VSINSTALLDIR%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin"
if not exist "%vs_cmake_bin%\cmake.exe" goto vs_cmake_not_found
set "PATH=%vs_cmake_bin%;%PATH%"
goto vs_cmake_ready
:vs_cmake_not_found
where.exe cmake.exe >nul 2>&1
if not errorlevel 1 goto vs_cmake_ready
echo CMake was not found in Visual Studio's bundled tools or PATH. Install the C++ CMake tools component. 1>&2
exit /b 1
:vs_cmake_ready

set "EPIKRISE_MSVC_CL_EXE="
set "msvc_cl_file=%TEMP%\epikrise-msvc-cl-%RANDOM%.txt"
where.exe /r "%VSINSTALLDIR%\VC\Tools\MSVC" cl.exe 2>nul | findstr /i /c:"\Host%VSCMD_ARG_HOST_ARCH%\%VSCMD_ARG_TGT_ARCH%\cl.exe" > "%msvc_cl_file%"
if errorlevel 1 goto msvc_cl_missing
set /p "EPIKRISE_MSVC_CL_EXE="<"%msvc_cl_file%"
if defined EPIKRISE_MSVC_CL_EXE goto msvc_cl_found
:msvc_cl_missing
del /q "%msvc_cl_file%" >nul 2>&1
echo Visual Studio compiler could not be located after vcvarsall. 1>&2
exit /b 1
:msvc_cl_found
del /q "%msvc_cl_file%" >nul 2>&1

set "EPIKRISE_MSVC_LINK_EXE="
set "msvc_link_file=%TEMP%\epikrise-msvc-link-%RANDOM%.txt"
where.exe /r "%VSINSTALLDIR%\VC\Tools\MSVC" link.exe 2>nul | findstr /i /c:"\Host%VSCMD_ARG_HOST_ARCH%\%VSCMD_ARG_TGT_ARCH%\link.exe" > "%msvc_link_file%"
if errorlevel 1 goto msvc_link_missing
set /p "EPIKRISE_MSVC_LINK_EXE="<"%msvc_link_file%"
if defined EPIKRISE_MSVC_LINK_EXE goto msvc_link_found
:msvc_link_missing
del /q "%msvc_link_file%" >nul 2>&1
echo Visual Studio linker could not be located for host %VSCMD_ARG_HOST_ARCH% and target %VSCMD_ARG_TGT_ARCH%. 1>&2
exit /b 1
:msvc_link_found
del /q "%msvc_link_file%" >nul 2>&1

for %%I in ("%EPIKRISE_MSVC_CL_EXE%") do set "msvc_compiler_dir=%%~dpI"
for %%I in ("%msvc_compiler_dir%..\..\..") do set "msvc_toolset_dir=%%~fI"
for %%I in ("%msvc_toolset_dir%") do set "VCToolsVersion=%%~nxI"
for %%I in ("%EPIKRISE_MSVC_LINK_EXE%") do set "msvc_link_dir=%%~dpI"
set "VCINSTALLDIR=%VSINSTALLDIR%\VC\"
set "VCToolsInstallDir=%msvc_toolset_dir%\"
set "PATH=%msvc_link_dir%;%msvc_compiler_dir%;%PATH%"
set "INCLUDE=%msvc_toolset_dir%\include;%INCLUDE%"
set "LIB=%msvc_toolset_dir%\lib\%windows_arch%;%LIB%"
if /I "%windows_arch%"=="arm64" set "CARGO_TARGET_AARCH64_PC_WINDOWS_MSVC_LINKER=%EPIKRISE_MSVC_LINK_EXE%"
if /I "%windows_arch%"=="x64" set "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER=%EPIKRISE_MSVC_LINK_EXE%"

if /I not "%windows_arch%"=="arm64" goto clang_ready
set "EPIKRISE_CLANG_EXE="
set "clang_file=%TEMP%\epikrise-clang-%RANDOM%.txt"
where.exe clang.exe > "%clang_file%" 2>nul
if errorlevel 1 goto clang_search_visual_studio
set /p "EPIKRISE_CLANG_EXE="<"%clang_file%"
if defined EPIKRISE_CLANG_EXE goto clang_found
:clang_search_visual_studio
if not exist "%VSINSTALLDIR%\VC\Tools\Llvm" goto clang_missing
where.exe /r "%VSINSTALLDIR%\VC\Tools\Llvm" clang.exe > "%clang_file%" 2>nul
if errorlevel 1 goto clang_missing
set /p "EPIKRISE_CLANG_EXE="<"%clang_file%"
if defined EPIKRISE_CLANG_EXE goto clang_found
:clang_missing
del /q "%clang_file%" >nul 2>&1
echo Clang is required to build ring for Windows ARM64. Install C++ Clang tools for Windows in Visual Studio Installer. 1>&2
exit /b 1
:clang_found
del /q "%clang_file%" >nul 2>&1
for %%I in ("%EPIKRISE_CLANG_EXE%") do set "clang_bin=%%~dpI"
set "PATH=%clang_bin%;%PATH%"
:clang_ready

if defined MSYS2_ENV_CONV_EXCL goto msys_env_conv_excl_existing
set "MSYS2_ENV_CONV_EXCL=INCLUDE=;LIB=;LIBPATH="
goto msys_env_conv_excl_ready
:msys_env_conv_excl_existing
set "MSYS2_ENV_CONV_EXCL=%MSYS2_ENV_CONV_EXCL%;INCLUDE=;LIB=;LIBPATH="
:msys_env_conv_excl_ready

call bash scripts/build-native-windows.sh "%windows_arch%" "%build_mode%"
exit /b %errorlevel%
