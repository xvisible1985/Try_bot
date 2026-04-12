@echo off
echo [TG-BOT] Deploy from GitHub...

REM 1. Pull latest code
echo [1/3] Pulling from GitHub...
git pull origin main
if %errorlevel% neq 0 (
    echo ERROR: git pull failed
    pause
    exit /b 1
)

REM 2. Install dependencies
echo [2/3] Installing dependencies...
npm ci --production
if %errorlevel% neq 0 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)

REM 3. Restart bot
echo [3/3] Restarting bot...
taskkill //F //IM node.exe 2>nul
timeout /t 2 /nobreak >nul
start "" node bot.js

echo.
echo [TG-BOT] Deploy complete!
pause
