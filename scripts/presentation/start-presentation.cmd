@echo off
setlocal
call "%~dp0presentation-launcher.cmd" %*
exit /b %ERRORLEVEL%
