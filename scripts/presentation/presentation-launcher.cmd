@echo off
setlocal
set "REPO_ROOT=%~dp0..\.."
set "LAUNCHER=%~dp0presentation_launcher.py"

if exist "%REPO_ROOT%\.venv\Scripts\pythonw.exe" (
  start "" "%REPO_ROOT%\.venv\Scripts\pythonw.exe" "%LAUNCHER%" %*
  exit /b 0
)

where pyw >nul 2>nul
if not errorlevel 1 (
  start "" pyw -3 "%LAUNCHER%" %*
  exit /b 0
)

start "" python "%LAUNCHER%" %*
exit /b %ERRORLEVEL%
