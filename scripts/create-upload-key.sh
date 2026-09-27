#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v keytool >/dev/null 2>&1; then
  echo "keytool was not found. Install Android Studio or a JDK, then run this again."
  exit 1
fi

if [ -f weatherpower-upload-key.jks ]; then
  echo "weatherpower-upload-key.jks already exists. Not overwriting it."
else
  keytool -genkeypair -v     -keystore weatherpower-upload-key.jks     -alias weatherpower     -keyalg RSA     -keysize 2048     -validity 10000
fi

if [ ! -f keystore.properties ]; then
  cp keystore.properties.example keystore.properties
  echo "Created keystore.properties. Edit it and add the passwords you used."
else
  echo "keystore.properties already exists."
fi

echo "Done. Keep weatherpower-upload-key.jks and keystore.properties private."
