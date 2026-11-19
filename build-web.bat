@echo off
setlocal
set "NODE_EXE=%~dp0runtime\node.exe"
if exist "%NODE_EXE%" goto build
where.exe node.exe >nul 2>&1
if not errorlevel 1 (
    set "NODE_EXE=node.exe"
    goto build
)
set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%NODE_EXE%" goto build
echo Node.js was not found. Install Node.js 22 or newer.
pause
exit /b 1

:build
"%NODE_EXE%" "%~dp0scripts\build-netlify.cjs"
set "BUILD_EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %BUILD_EXIT_CODE%
