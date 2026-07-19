@echo off
setlocal EnableExtensions

cd /d "%~dp0"

rem Desktop shortcuts enter here. Hand the long-running server to the hidden
rem launcher so users see the dashboard instead of a Command Prompt window.
if /I not "%~1"=="--background" (
    if exist "%~dp0launch_morphly.vbs" (
        start "" wscript.exe "%~dp0launch_morphly.vbs"
        exit /b 0
    )
)

if not defined MORPHLY_PYTHON (
    if exist "%~dp0runtime\python\python.exe" (
        set "MORPHLY_PYTHON=%~dp0runtime\python\python.exe"
        set "PYTHONHOME=%~dp0runtime\python"
        set "PYTHONNOUSERSITE=1"
        set "PYTHONDONTWRITEBYTECODE=1"
    ) else (
        set "MORPHLY_PYTHON=%~dp0.venv\Scripts\python.exe"
    )
)
if not exist "%MORPHLY_PYTHON%" (
    echo [Morphly] Python runtime is missing: %MORPHLY_PYTHON% 1>&2
    echo [Morphly] Expected runtime\python\python.exe or .venv\Scripts\python.exe. 1>&2
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
if not defined MORPHLY_ENGINE_STARTUP_TIMEOUT set "MORPHLY_ENGINE_STARTUP_TIMEOUT=50"
if not defined MORPHLY_FIREBASE_PROJECT_ID set "MORPHLY_FIREBASE_PROJECT_ID=vdc-c3a79"

echo [Morphly] Opening http://localhost:%MORPHLY_PUBLIC_PORT%
echo [Morphly] Keep this window open while using Morphly Voice.

"%MORPHLY_PYTHON%" "%~dp0morphly_supervisor.py" ^
    --public-host "%MORPHLY_PUBLIC_HOST%" ^
    --public-port %MORPHLY_PUBLIC_PORT% ^
    --engine-host "%MORPHLY_ENGINE_HOST%" ^
    --engine-port %MORPHLY_ENGINE_PORT% ^
    --startup-timeout %MORPHLY_ENGINE_STARTUP_TIMEOUT% ^
    --dashboard-root "%~dp0Morphly-Voice-Dashboard\dist-static" ^
    --default-mode "%MORPHLY_DEFAULT_ENGINE%" ^
    --firebase-project-id "%MORPHLY_FIREBASE_PROJECT_ID%"

set "MORPHLY_EXIT_CODE=%ERRORLEVEL%"
exit /b %MORPHLY_EXIT_CODE%
