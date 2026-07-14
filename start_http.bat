@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "MORPHLY_PYTHON=%~dp0.venv\Scripts\python.exe"
if not exist "%MORPHLY_PYTHON%" (
    echo [Morphly] Python runtime is missing: %MORPHLY_PYTHON% 1>&2
    echo [Morphly] Expected a local virtual environment at .venv\Scripts\python.exe. 1>&2
    exit /b 3
)

if not exist "%~dp0Morphly-Voice-Dashboard\dist-static\index.html" (
    echo [Morphly] Dashboard build is missing. 1>&2
    echo [Morphly] Expected Morphly-Voice-Dashboard\dist-static\index.html. 1>&2
    exit /b 4
)

if not defined MORPHLY_PUBLIC_HOST set "MORPHLY_PUBLIC_HOST=127.0.0.1"
if not defined MORPHLY_PUBLIC_PORT set "MORPHLY_PUBLIC_PORT=18000"
if not defined MORPHLY_ENGINE_HOST set "MORPHLY_ENGINE_HOST=127.0.0.1"
if not defined MORPHLY_ENGINE_PORT set "MORPHLY_ENGINE_PORT=18001"
if not defined MORPHLY_DEFAULT_ENGINE set "MORPHLY_DEFAULT_ENGINE=rvc"
if not defined MORPHLY_ENGINE_STARTUP_TIMEOUT set "MORPHLY_ENGINE_STARTUP_TIMEOUT=360"

echo [Morphly] Opening http://localhost:%MORPHLY_PUBLIC_PORT%
echo [Morphly] Keep this window open while using Morphly Voice.

"%MORPHLY_PYTHON%" "%~dp0morphly_supervisor.py" ^
    --public-host "%MORPHLY_PUBLIC_HOST%" ^
    --public-port %MORPHLY_PUBLIC_PORT% ^
    --engine-host "%MORPHLY_ENGINE_HOST%" ^
    --engine-port %MORPHLY_ENGINE_PORT% ^
    --startup-timeout %MORPHLY_ENGINE_STARTUP_TIMEOUT% ^
    --dashboard-root "%~dp0Morphly-Voice-Dashboard\dist-static" ^
    --default-mode "%MORPHLY_DEFAULT_ENGINE%"

set "MORPHLY_EXIT_CODE=%ERRORLEVEL%"
exit /b %MORPHLY_EXIT_CODE%
