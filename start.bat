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

REM Check WorkBuddy Node.js first (preferred)
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\node.exe" (
    set "NODE_PATH=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2"
    set "NODE_FOUND=1"
    goto :node_found
)

REM Check common Node.js locations
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
    REM Try to find node in PATH
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
REM Add node to PATH for bash
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

REM ============================================================
REM Check if ports are in use; if so, kill old processes first
REM ============================================================
set "APP_PORT=3737"
set "CTRL_PORT=13737"

echo [INFO] Checking ports before start...
call :free_port %APP_PORT%
call :free_port %CTRL_PORT%
echo.

REM ============================================================
REM 调度：Windows 下用 PowerShell 完全分离地拉起 daemon
REM （Start-Process 创建的进程不属于本 CMD 窗口的进程组，关闭窗口不会被杀）
REM 其余子命令（stop/restart/status/logs/log）仍交给 start.sh
REM ============================================================
cd /d "%~dp0"
set "ARG1=%~1"

if "%ARG1%"=="start" goto :do_start
if "%ARG1%"=="" goto :do_start

REM 其它子命令 → 交给 start.sh
echo [INFO] Running: start.sh %*
echo.
"%BASH_CMD%" -c "./start.sh %*"
if errorlevel 1 (
    echo.
    echo [ERROR] Command failed
    pause
    exit /b 1
)
exit /b 0

:do_start
echo [INFO] Working directory: %CD%

REM 端口清理已在上方完成（:free_port 3737 / 13737）
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

echo [INFO] Waiting for daemon to be ready (polling control /health)...
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
    echo [INFO] ✅ Daemon started.
    echo [INFO]    URL:     http://localhost:3737
    echo [INFO]    Control: http://localhost:13737
    echo [INFO]    daemon 在后台独立运行，关闭本窗口不会影响它
) else (
    echo.
    echo [ERROR] Failed to start Agent WebUI
    echo [INFO] Last 20 lines of daemon log:
    powershell -NoProfile -Command "Get-Content '%DAEMON_LOG%' -Tail 20"
    pause
    exit /b 1
)
exit /b 0

REM ============================================================
REM Subroutine: free_port <port>
REM Finds any process LISTENING on the given port and kills it
REM ============================================================
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
