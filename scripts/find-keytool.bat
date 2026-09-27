@echo off
setlocal EnableExtensions
echo Searching for keytool on this Windows computer...
echo.

where keytool 2>nul
if not errorlevel 1 echo Found through PATH above.

if defined JAVA_HOME if exist "%JAVA_HOME%\bin\keytool.exe" echo %JAVA_HOME%\bin\keytool.exe
if defined JDK_HOME if exist "%JDK_HOME%\bin\keytool.exe" echo %JDK_HOME%\bin\keytool.exe
if exist "%ProgramFiles%\Android\Android Studio\jbr\bin\keytool.exe" echo %ProgramFiles%\Android\Android Studio\jbr\bin\keytool.exe
if exist "%ProgramFiles%\Android\Android Studio\jre\bin\keytool.exe" echo %ProgramFiles%\Android\Android Studio\jre\bin\keytool.exe
if exist "%ProgramFiles(x86)%\Android\Android Studio\jbr\bin\keytool.exe" echo %ProgramFiles(x86)%\Android\Android Studio\jbr\bin\keytool.exe
if exist "%LOCALAPPDATA%\Programs\Android Studio\jbr\bin\keytool.exe" echo %LOCALAPPDATA%\Programs\Android Studio\jbr\bin\keytool.exe

for /d %%D in ("%LOCALAPPDATA%\JetBrains\Toolbox\apps\AndroidStudio\ch-*\*") do (
  if exist "%%~fD\jbr\bin\keytool.exe" echo %%~fD\jbr\bin\keytool.exe
  if exist "%%~fD\jre\bin\keytool.exe" echo %%~fD\jre\bin\keytool.exe
)

echo.
echo If nothing printed except this message, install Android Studio or a JDK.
pause
