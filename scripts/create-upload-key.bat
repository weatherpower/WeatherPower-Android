@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."

echo WeatherPower Android upload key creator
echo.
echo This creates weatherpower-upload-key.jks and keystore.properties in this folder.
echo Save the passwords somewhere safe. Google Play updates may need this upload key.
echo.

set "KEYTOOL="
where keytool >nul 2>nul
if not errorlevel 1 set "KEYTOOL=keytool"

if "%KEYTOOL%"=="" if defined JAVA_HOME if exist "%JAVA_HOME%\bin\keytool.exe" set "KEYTOOL=%JAVA_HOME%\bin\keytool.exe"
if "%KEYTOOL%"=="" if defined JDK_HOME if exist "%JDK_HOME%\bin\keytool.exe" set "KEYTOOL=%JDK_HOME%\bin\keytool.exe"
if "%KEYTOOL%"=="" if exist "%ProgramFiles%\Android\Android Studio\jbr\bin\keytool.exe" set "KEYTOOL=%ProgramFiles%\Android\Android Studio\jbr\bin\keytool.exe"
if "%KEYTOOL%"=="" if exist "%ProgramFiles%\Android\Android Studio\jre\bin\keytool.exe" set "KEYTOOL=%ProgramFiles%\Android\Android Studio\jre\bin\keytool.exe"
if "%KEYTOOL%"=="" if exist "%ProgramFiles(x86)%\Android\Android Studio\jbr\bin\keytool.exe" set "KEYTOOL=%ProgramFiles(x86)%\Android\Android Studio\jbr\bin\keytool.exe"
if "%KEYTOOL%"=="" if exist "%LOCALAPPDATA%\Programs\Android Studio\jbr\bin\keytool.exe" set "KEYTOOL=%LOCALAPPDATA%\Programs\Android Studio\jbr\bin\keytool.exe"

if "%KEYTOOL%"=="" (
  for /d %%D in ("%LOCALAPPDATA%\JetBrains\Toolbox\apps\AndroidStudio\ch-*\*") do (
    if exist "%%~fD\jbr\bin\keytool.exe" set "KEYTOOL=%%~fD\jbr\bin\keytool.exe"
    if exist "%%~fD\jre\bin\keytool.exe" set "KEYTOOL=%%~fD\jre\bin\keytool.exe"
  )
)

if "%KEYTOOL%"=="" (
  echo ERROR: keytool was not found.
  echo.
  echo Fix option 1:
  echo   Install Android Studio, then reopen Command Prompt and run this again.
  echo.
  echo Fix option 2:
  echo   Check this folder manually:
  echo   C:\Program Files\Android\Android Studio\jbr\bin
  echo.
  echo Fix option 3:
  echo   Install a JDK and make sure JAVA_HOME points to it.
  echo.
  pause
  exit /b 1
)

echo Using keytool:
echo %KEYTOOL%
echo.

if exist weatherpower-upload-key.jks (
  echo weatherpower-upload-key.jks already exists.
  echo Delete it first if you really want to create a new upload key.
  pause
  exit /b 1
)

set /p STORE_PASS=Enter keystore password: 
set /p KEY_PASS=Enter key password: 

if "%STORE_PASS%"=="" (
  echo ERROR: keystore password cannot be blank.
  pause
  exit /b 1
)
if "%KEY_PASS%"=="" (
  echo ERROR: key password cannot be blank.
  pause
  exit /b 1
)

echo.
echo Creating upload key...
"%KEYTOOL%" -genkeypair -v ^
  -keystore weatherpower-upload-key.jks ^
  -alias weatherpower ^
  -keyalg RSA ^
  -keysize 2048 ^
  -validity 10000 ^
  -storepass "%STORE_PASS%" ^
  -keypass "%KEY_PASS%" ^
  -dname "CN=WeatherPower, OU=WeatherPower, O=WeatherPower, L=Idabel, ST=Oklahoma, C=US"

if errorlevel 1 (
  echo.
  echo ERROR: keytool failed. The upload key was not created.
  pause
  exit /b 1
)

echo storeFile=weatherpower-upload-key.jks> keystore.properties
echo storePassword=%STORE_PASS%>> keystore.properties
echo keyAlias=weatherpower>> keystore.properties
echo keyPassword=%KEY_PASS%>> keystore.properties

echo.
echo Done. Created:
echo - weatherpower-upload-key.jks
echo - keystore.properties
echo.
echo Next run: scripts\build-release-aab.bat
echo.
pause
