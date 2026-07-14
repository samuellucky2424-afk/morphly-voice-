@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "MORPHLY_ENGINE_MODE=%~1"
if not defined MORPHLY_ENGINE_MODE set "MORPHLY_ENGINE_MODE=rvc"

set "MORPHLY_ENGINE_PORT=%~2"
if not defined MORPHLY_ENGINE_PORT set "MORPHLY_ENGINE_PORT=18001"

set "MORPHLY_ENGINE_HOST=%~3"
if not defined MORPHLY_ENGINE_HOST set "MORPHLY_ENGINE_HOST=127.0.0.1"
if not defined MORPHLY_PUBLIC_PORT set "MORPHLY_PUBLIC_PORT=18000"

if /I "%MORPHLY_ENGINE_MODE%"=="rvc" goto start_rvc
if /I "%MORPHLY_ENGINE_MODE%"=="beatrice" goto start_beatrice

echo [Morphly] Unknown engine mode: %MORPHLY_ENGINE_MODE% 1>&2
exit /b 2

:start_rvc
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
    exit /b 3
)
if not exist "%~dp0server\MMVCServerSIO.py" (
    echo [Morphly] RVC server is missing: %~dp0server\MMVCServerSIO.py 1>&2
    exit /b 3
)

echo [Morphly] Starting RVC on %MORPHLY_ENGINE_HOST%:%MORPHLY_ENGINE_PORT%
pushd "%~dp0server"
"%MORPHLY_PYTHON%" -m uvicorn MMVCServerSIO:app_socketio ^
    --host "%MORPHLY_ENGINE_HOST%" ^
    --port %MORPHLY_ENGINE_PORT% ^
    --log-level error ^
    --no-access-log
set "MORPHLY_EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %MORPHLY_EXIT_CODE%

:start_beatrice
set "MORPHLY_BEATRICE_ROOT=%~dp0engines\beatrice-v2"
set "MORPHLY_BEATRICE_EXE=%MORPHLY_BEATRICE_ROOT%\main.exe"
if not exist "%MORPHLY_BEATRICE_EXE%" (
    echo [Morphly] Beatrice runtime is missing: %MORPHLY_BEATRICE_EXE% 1>&2
    exit /b 3
)

echo [Morphly] Starting Beatrice V2 on %MORPHLY_ENGINE_HOST%:%MORPHLY_ENGINE_PORT%
pushd "%MORPHLY_BEATRICE_ROOT%"
"%MORPHLY_BEATRICE_EXE%" start ^
    --host "%MORPHLY_ENGINE_HOST%" ^
    -p %MORPHLY_ENGINE_PORT% ^
    --https=False ^
    --launch_client=False
set "MORPHLY_EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %MORPHLY_EXIT_CODE%
