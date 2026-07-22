@echo off
setlocal
set "REPO_ROOT=%~dp0..\.."
set "CONTROLLER=%~dp0presentationctl.py"

if exist "%REPO_ROOT%\.venv\Scripts\python.exe" (
  "%REPO_ROOT%\.venv\Scripts\python.exe" "%CONTROLLER%" status %*
) else (
  where py >nul 2>nul
  if not errorlevel 1 (
    py -3 "%CONTROLLER%" status %*
  ) else (
    python "%CONTROLLER%" status %*
  )
)

set "EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %EXIT_CODE%
