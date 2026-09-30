@echo off
rem Quita "Elegir fotos con Kyro" del clic derecho y el acceso directo del escritorio.
reg delete "HKCU\Software\Classes\Directory\shell\Kyro" /f >nul 2>nul
reg delete "HKCU\Software\Classes\Directory\Background\shell\Kyro" /f >nul 2>nul
powershell -NoProfile -Command "Remove-Item ([Environment]::GetFolderPath('Desktop') + '\Kyro.lnk') -ErrorAction SilentlyContinue"
echo   Kyro se quito del menu y del escritorio.
pause
