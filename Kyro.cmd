@echo off
rem Abre Kyro Photo Selector. Si se le pasa una carpeta, la usa como origen de las fotos.
title Kyro Photo Selector
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Kyro necesita Node.js. Descargalo de https://nodejs.org ^(version LTS^) e instalalo.
  echo.
  pause
  exit /b 1
)
node server.js %*
if errorlevel 1 pause
