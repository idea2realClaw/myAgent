@echo off
chcp 65001 >nul
echo ============================================================
echo          Agent WebUI - Windows Launcher
echo ============================================================
echo.

REM Activate Python virtual environment
set "VENV_PATH=%~dp0venv"
if exist "%VENV_PATH%\Scripts\activate.bat" (
    echo [INFO] Activating Python venv: %VENV_PATH%
    call "%VENV_PATH%\Scripts\activate.bat"
    echo [INFO] Python venv activated
    python --version
) else (
    echo [WARN] Python venv not found at: %VENV_PATH%
)

echo.

REM Find Node.js and add to PATH
set "NODE_FOUND=0"
set "NODE_PATH="

if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\node.exe" (
    set "NODE_PATH=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2"
    set "NODE_FOUND=1"
    goto :node_found
)

if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    set "NODE_PATH=%LOCALAPPDATA%\Programs\nodejs"
    set "NODE_FOUND=1"
) else if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_PATH=%ProgramFiles%\nodejs"
    set "NODE_FOUND=1"
) else if exist "%APPDATA%\nvm\default\node.exe" (
    set "NODE_PATH=%APPDATA%\nvm\default"
    set "NODE_FOUND=1"
) else (
    where node >nul 2>&1
    if not errorlevel 1 (
        for /f "tokens=*" %%i in ('where node') do set "NODE_PATH=%%~dpi"
        set "NODE_FOUND=1"
    )
)

:node_found
if "%NODE_FOUND%"=="0" (
    echo [ERROR] Node.js not found. Please install from https://nodejs.org
    pause
    exit /b 1
)

echo [INFO] Node.js found at: %NODE_PATH%
set "PATH=%NODE_PATH%;%PATH%"

REM Try to find bash (Git Bash)
set "BASH_CMD="
if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH_CMD=%ProgramFiles%\Git\bin\bash.exe"
if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "BASH_CMD=%ProgramFiles(x86)%\Git\bin\bash.exe"
where bash >nul 2>&1 && set "BASH_CMD=bash"

if not defined BASH_CMD (
    echo [ERROR] Bash not found. Please install Git for Windows.
    echo Download from: https://git-scm.com/download/win
    pause
    exit /b 1
)

echo [INFO] Using bash: %BASH_CMD%
echo.

REM Check if ports are in use; if so, kill old processes first
set "APP_PORT=3737"
set "CTRL_PORT=13737"

echo [INFO] Checking ports before start...
call :free_port %APP_PORT%
call :free_port %CTRL_PORT%
echo.

REM Windows start: launch daemon detached via PowerShell Start-Process
REM (process is NOT in this CMD window group, survives window close)
REM Other subcommands (stop/restart/status/logs) are handled by start.sh
cd /d "%~dp0"
set "ARG1=%~1"

if "%ARG1%"=="start" goto :do_start
if "%ARG1%"=="" goto :do_start

REM Other subcommands -> start.sh
echo [INFO] Running: start.sh %*
echo.
"%BASH_CMD%" -c "./start.sh %*"
if errorlevel 1 (
    echo.
    echo [ERROR] Command failed
    pause
    exit /b 1
)
echo.
echo [INFO] Press any key to close this window...
pause
exit /b 0

:do_start
echo [INFO] Working directory: %CD%

set "DAEMON_JS=%CD%\backend\daemon.js"
set "DAEMON_LOG=%CD%\logs\daemon-stdout.log"
set "DAEMON_ERR=%CD%\logs\daemon-stderr.log"

echo [INFO] Launching daemon (detached, independent of this window)...
powershell -NoProfile -Command "Start-Process -FilePath '%NODE_PATH%\node.exe' -ArgumentList '%DAEMON_JS%' -WorkingDirectory '%CD%' -WindowStyle Hidden -RedirectStandardOutput '%DAEMON_LOG%' -RedirectStandardError '%DAEMON_ERR%'"
if errorlevel 1 (
    echo [ERROR] Failed to launch daemon process
    pause
    exit /b 1
)

echo [INFO] Waiting for daemon to be ready (polling 3737 /api/health)...
set "READY=0"
where curl >nul 2>&1
if errorlevel 1 (
    echo [WARN] curl not found, waiting 8s then assuming ready...
    timeout /t 8 /nobreak >nul
    set "READY=1"
    goto :started
)
for /L %%i in (1,1,25) do (
    for /f "delims=" %%h in ('curl -s -o nul -m 2 -w "%%{http_code}" "http://127.0.0.1:3737/api/health"') do (
        if "%%h"=="200" (
            set "READY=1"
            goto :started
        )
    )
    timeout /t 1 /nobreak >nul
)

:started
if "%READY%"=="1" (
    echo.
    echo [INFO] Daemon started.
    echo [INFO]    URL:     http://localhost:3737
    echo [INFO]    Control: http://localhost:13737
    echo [INFO]    Daemon runs in background; closing this window will NOT stop it.
) else (
    echo.
    echo [ERROR] Failed to start Agent WebUI
    echo [INFO] Last 20 lines of daemon log:
    powershell -NoProfile -Command "Get-Content '%DAEMON_LOG%' -Tail 20"
    pause
    exit /b 1
)
echo.
echo [INFO] Press any key to close this window...
pause
exit /b 0

REM Subroutine: free_port <port>
REM Finds any process LISTENING on the given port and kills it
:free_port
set "PORT=%~1"
set "PORT_FOUND=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    echo [WARN] Port %PORT% is in use by PID %%p, terminating old process...
    taskkill /F /PID %%p >nul 2>&1
    set "PORT_FOUND=1"
)
if "%PORT_FOUND%"=="1" (
    echo [INFO] Old process on port %PORT% terminated
    timeout /t 1 /nobreak >nul
) else (
    echo [INFO] Port %PORT% is free
)
exit /b 0
