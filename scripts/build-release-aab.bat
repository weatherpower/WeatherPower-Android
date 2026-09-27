@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."

echo WeatherPower Android release bundle builder
echo.

if not exist keystore.properties (
  echo ERROR: keystore.properties was not found.
  echo Run scripts\create-upload-key.bat first, or create a signed bundle through Android Studio.
  pause
  exit /b 1
)

if not exist weatherpower-upload-key.jks (
  echo ERROR: weatherpower-upload-key.jks was not found.
  echo Make sure your keystore file is in the WPAndroid folder.
  pause
  exit /b 1
)

echo Building signed release AAB...
call gradlew.bat bundleRelease

if errorlevel 1 (
  echo.
  echo ERROR: Gradle build failed.
  echo Open the project in Android Studio, let Gradle sync, then try again.
  pause
  exit /b 1
)

echo.
echo Done. Upload this file to Google Play Console:
echo app\build\outputs\bundle\release\app-release.aab
echo.
pause
