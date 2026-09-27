# WeatherPower Dev Center

WeatherPower Dev Center is a local-network development dashboard for the supplied WeatherPower Android v1.7.2 / code 130 baseline. It edits and builds only this extracted WeatherPower-Android-DEV workspace.

## Requirements

- Windows PC or macOS computer on the private local network
- Node.js 22.13 or newer
- JDK 17
- Android SDK Platform 36 and Build Tools 35/36
- Codex CLI installed and authenticated for agent tasks

Build Only works without Codex.

## Android 17 Pixel simulator

On the configured macOS workstation, the Dev Center includes an authenticated **Simulator** page for the `WeatherPower_Pixel_9_Android_17` AVD. The Android 17 / API 37 Google APIs x86_64 system image and emulator SDK live inside a flash-drive-backed APFS volume mounted at:

`/Volumes/WeatherPowerSimulator`

The backing file is `WeatherPower Android Simulator.sparsebundle` on the `Camera` flash drive. The system image, writable AVD data, snapshots, locks, and logs all remain physically on that drive. macOS mounts the sparse bundle as APFS because Android Emulator requires filesystem locks that ExFAT cannot provide. The Simulator page can start or stop the Pixel, install the newest database-approved WeatherPower DEV APK, open or restart the app, send Back/Home/Recents, mirror screenshots, translate screen clicks into bounded taps, and show Logcat lines filtered to `co.median.android.pkmqnq.dev`.

Connect the flash drive before starting the Pixel. Simulator control requires the private control session, and the backend exposes only fixed Android operations—never an arbitrary command endpoint.

## Start the dashboard on Windows

Double-click:

start-weatherpower-dev-center.bat

The script installs local Node dependencies when missing, compiles the React dashboard, starts the backend on 0.0.0.0:4172, opens the configured dashboard, and prints the private control token.

## Keep the dashboard running on macOS

Run `./install-weatherpower-dev-center-macos.sh` once. It builds the dashboard and installs the included per-user LaunchAgent. macOS then starts the Dev Center at login and restarts it if the Node process exits. The service pins `/usr/local/bin` ahead of an older shell Node installation and keeps the control token out of service logs.

The service definition is `macos/com.weatherpower.devcenter.plist`. Its local logs are `dev-center-data/service.log` and `dev-center-data/service-error.log`.

Configured PC and phone URL:

http://192.168.1.118:4172

If the detected private IPv4 address differs, the dashboard displays both addresses. Change the preferred address in Settings; do not use localhost in phone links.

## Control access

Build history, sanitized task status, testing feedback, and approved APK downloads are available on the LAN. Agent/build/cancel/settings actions require the private control token printed by the interactive launcher or stored locally in dev-center-data/control-token.txt. The background macOS service deliberately does not print the token into its log.

The token is sent only to the same-origin backend and becomes an HttpOnly local session cookie. It is not compiled into frontend JavaScript and is not returned by an API.

## Create a build

From the dashboard:

- Run Agent + Build: checkpoint, Codex task, tests, lint, real Gradle build, APK registration.
- Run Agent Only: checkpoint and Codex edits without an automatic build.
- Build Only: tests, lint, real Gradle build, and APK registration without Codex.

For Agent tasks, use **Attach images** to include up to four PNG, JPEG, WebP, or GIF files of 8 MB each. The dashboard shows a local preview and passes the stored files to `codex exec --image`. Build Only intentionally does not accept images.

From Windows without the dashboard:

build-weatherpower-dev.bat

Successful APKs:

dev-builds/WeatherPower-DEV-NNN-v1.7.2.apk

Raw Gradle APK:

app/build/outputs/apk/dev/app-dev.apk

## Safety boundaries

- Local private network only; no public tunnel, UPnP, or router configuration.
- No Google Play publishing, source upload, GitHub creation, remote Git, or production signing.
- No arbitrary shell or general filesystem API.
- Image uploads require an unlocked control session, validate both declared type and file signature, and are never exposed by a general download route.
- Only database-approved WeatherPower DEV APK names inside dev-builds can be downloaded.
- Safe logs are redacted before storage and streaming.
- One development task can own the workspace at a time.
- Automatic build repair is limited to two agent attempts.
- Cancel terminates the active agent/Gradle process tree.
- Build retention is recorded but automatic deletion remains disabled until explicitly confirmed.

## Data locations

- Local database: dev-center-data/weatherpower-dev-center.db
- Sanitized task logs: dev-center-data/logs
- Private control token: dev-center-data/control-token.txt
- Agent checkpoints: sibling WeatherPower-Android-DEV-checkpoints directory
- Task image attachments: sibling WeatherPower-Android-DEV-attachments directory
- Successful APKs: dev-builds

None of these paths are served as general static directories.

## Baseline protection

The recovery ZIP remains outside this workspace and was not edited. Its recorded SHA-256 at extraction time is:

37b071bc896989dc93422a02509a46e3442c067b3c47491216bdb16fa3a0815f

No local Git repository was initialized because the supplied baseline contains credential-like literals that must be reviewed before any commit.
