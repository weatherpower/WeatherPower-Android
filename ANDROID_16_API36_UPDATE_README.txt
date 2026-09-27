WeatherPower Mobile — Android 16 / API 36 update
====================================================

Base project
------------
This project is the June 25, 2026 WeatherPower Mobile v1.7.2 build
(WP-v1.7.2-code129-android-widget-hardfix.zip), updated for Google Play's
Android 16 target requirement.

Release identity
----------------
Application ID: co.median.android.pkmqnq
Version name:   1.7.2
Version code:   130
Minimum SDK:    23
Compile SDK:    36
Target SDK:     36

Build tool updates
------------------
Android Gradle Plugin: 8.9.1
Gradle wrapper:         8.11.1
Java:                   17 (Android Studio's bundled JDK is recommended)

Android 16 compatibility work
-----------------------------
- Targets and compiles against API level 36.
- Handles mandatory edge-to-edge system bars with safe WebView insets.
- Migrates WebView back navigation to Android's predictive-back callback on
  Android 13 and newer while preserving the legacy path on older devices.
- Keeps the June 25 embedded site, widgets, package name, and public version
  name unchanged.
- Increases versionCode from 129 to 130 so Google Play can accept a new bundle.

How to make the Play Store bundle
---------------------------------
1. Open this folder in Android Studio Meerkat 2024.3.1 Patch 1 or newer.
2. Let Gradle sync and install Android SDK Platform 36 / Build Tools 36.x when
   prompted.
3. Put your existing Play upload keystore in this project and create
   keystore.properties from keystore.properties.example. You must use the same
   upload key used for the existing Play Store app.
4. Build > Generate Signed Bundle / APK > Android App Bundle, or run:
      scripts\build-release-aab.bat
5. Upload app\build\outputs\bundle\release\app-release.aab to an internal
   test track first, then promote it to production after testing.

Important
---------
If Play Console says version code 130 has already been used, increase
versionCode in app/build.gradle to the next unused number before building.
Do not replace or lose the existing Play upload keystore.
