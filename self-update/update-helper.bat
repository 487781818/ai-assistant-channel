@echo off
rem ---------------------------------------------------------------
rem Self-update helper (template, pure ASCII on purpose).
rem
rem How it is used:
rem   1. The assistant pushes the new package as app.asar.new next
rem      to the running app.asar, plus this script, via the channel.
rem   2. The assistant starts this script DETACHED (Start-Process),
rem      so it survives the app being killed.
rem   3. This script waits, kills the app, swaps the package,
rem      relaunches the app, then deletes itself.
rem
rem Replace D:\YourApp with your app's install directory.
rem ---------------------------------------------------------------
setlocal
timeout /t 3 /nobreak >nul
taskkill /IM YourApp.exe /F >nul 2>&1
taskkill /IM YourAppBridge.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul
move /Y "D:\YourApp\resources\app.asar.new" "D:\YourApp\resources\app.asar" >nul
timeout /t 1 /nobreak >nul
start "" "D:\YourApp\YourApp.exe"
del "%~f0"
