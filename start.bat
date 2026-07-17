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

REM Change to script directory first, then run start.sh
cd /d "%~dp0"
echo [INFO] Working directory: %CD%
echo [INFO] Running: start.sh %*
echo.

REM Run start.sh with arguments (start.sh handles Node.js detection internally)
"%BASH_CMD%" -c "./start.sh %*"

if errorlevel 1 (
    echo.
    echo [ERROR] Failed to start Agent WebUI
    pause
    exit /b 1
)

exit /b 0
