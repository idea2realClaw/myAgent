@echo off
title MyAgent
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

REM Check if port is in use; if so, kill old process first (single process, no extra control port)
set "APP_PORT=3737"

echo [INFO] Checking port before start...
call :free_port %APP_PORT%
echo.

REM Windows start: launch the single server process in FOREGROUND (logs stream here).
REM The process self-monitors and self-restarts (no separate daemon, no extra control port).
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

set "SERVER_JS=%CD%\backend\server.js"

echo [INFO] Launching MyAgent (single process, self-monitoring, no daemon/extra port)...
echo [INFO]    URL:     http://localhost:3737
echo [INFO]    Logs:    backend logs print below (also at logs\agent-webui-server.log)
echo [INFO]    Press Ctrl+C to stop the agent (closing this window stops it too).
echo.

"%NODE_PATH%\node.exe" "%SERVER_JS%"
set "EXITCODE=%errorlevel%"

echo.
echo [INFO] MyAgent exited with code %EXITCODE%.
echo [INFO] Press any key to close this window...
pause
exit /b %EXITCODE%

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
