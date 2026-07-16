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

REM 3. Restart bot via PM2 (touches only this process, not other apps on the server)
echo [3/3] Restarting bot via PM2...
pm2 restart tg-bot --update-env
if %errorlevel% neq 0 (
    echo tg-bot not registered yet, starting it...
    pm2 start bot.js --name tg-bot
)
pm2 save

echo.
echo [TG-BOT] Deploy complete!
pause
