@echo off
title League of Legends Profile Viewer
echo Iniciando backend y frontend...

start "Backend - Node.js" cmd /k "cd /d "%~dp0backend" && node server.js"
timeout /t 2 /nobreak >nul
start "Frontend - Angular" cmd /k "cd /d "%~dp0frontend" && npx ng serve --port 4200"

echo.
echo Servicios iniciados:
echo   Backend:  http://localhost:3000
echo   Frontend: http://localhost:4200
echo.
pause
