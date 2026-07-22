@echo off
setlocal
set "REPO_ROOT=%~dp0..\.."
set "CONTROLLER=%~dp0presentationctl.py"

if exist "%REPO_ROOT%\.venv\Scripts\python.exe" (
  "%REPO_ROOT%\.venv\Scripts\python.exe" "%CONTROLLER%" stop %*
) else (
  where py >nul 2>nul
  if not errorlevel 1 (
    py -3 "%CONTROLLER%" stop %*
  ) else (
    python "%CONTROLLER%" stop %*
  )
)

set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
