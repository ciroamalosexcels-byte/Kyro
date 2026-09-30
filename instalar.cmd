@echo off
rem Agrega "Elegir fotos con Kyro" al clic derecho de las carpetas y un acceso directo en el escritorio.
rem No necesita permisos de administrador (se instala solo para tu usuario).
set "APP=%~dp0Kyro.cmd"

reg add "HKCU\Software\Classes\Directory\shell\Kyro" /ve /d "Elegir fotos con Kyro" /f >nul
reg add "HKCU\Software\Classes\Directory\shell\Kyro" /v Icon /d "%SystemRoot%\System32\imageres.dll,-68" /f >nul
reg add "HKCU\Software\Classes\Directory\shell\Kyro\command" /ve /d "\"%APP%\" \"%%1\"" /f >nul

reg add "HKCU\Software\Classes\Directory\Background\shell\Kyro" /ve /d "Elegir fotos con Kyro" /f >nul
reg add "HKCU\Software\Classes\Directory\Background\shell\Kyro" /v Icon /d "%SystemRoot%\System32\imageres.dll,-68" /f >nul
reg add "HKCU\Software\Classes\Directory\Background\shell\Kyro\command" /ve /d "\"%APP%\" \"%%V\"" /f >nul

powershell -NoProfile -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop') + '\Kyro.lnk'); $s.TargetPath = '%APP%'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = '%SystemRoot%\System32\imageres.dll,-68'; $s.Save()"

echo.
echo   Listo.
echo   - Clic derecho sobre una carpeta ^> "Elegir fotos con Kyro"
echo     (en Windows 11 esta en "Mostrar mas opciones").
echo   - Tambien quedo un acceso directo "Kyro" en el escritorio.
echo.
pause
