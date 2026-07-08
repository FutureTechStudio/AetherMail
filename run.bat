@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo             AetherMail - Setup ^& Run
echo ===================================================
echo.

:: 1. Check if Python is installed
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python is not installed or not added to PATH.
    echo Please install Python 3.10+ and try again.
    pause
    exit /b 1
)

:: 2. Setup Virtual Environment
if not exist .venv (
    echo Creating virtual environment (.venv)...
    python -m venv .venv
    if !errorlevel! neq 0 (
        echo [ERROR] Failed to create virtual environment.
        pause
        exit /b 1
    )
)

:: 3. Activate Virtual Environment
echo Activating virtual environment...
call .venv\Scripts\activate.bat

:: 4. Install Dependencies
echo Installing/upgrading dependencies (requirements.txt)...
python -m pip install --upgrade pip
pip install -r requirements.txt
if !errorlevel! neq 0 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
)

:: 5. Check Gmail Credentials
if not exist credentials.json (
    echo.
    echo ---------------------------------------------------
    echo [WARNING] Missing credentials.json file!
    echo.
    echo To link your Gmail account, you must:
    echo 1. Go to Google Cloud Console (https://console.cloud.google.com)
    echo 2. Enable Gmail API.
    echo 3. Configure OAuth Consent Screen.
    echo 4. Create OAuth Client ID credentials (Web Application / Desktop App).
    echo 5. Download the JSON credentials file and rename it to 'credentials.json' in this folder.
    echo ---------------------------------------------------
    echo.
)

:: 6. Start the App
echo Starting Flask App...
echo.
python app.py

pause
