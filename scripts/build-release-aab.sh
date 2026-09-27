#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f keystore.properties ]; then
  echo "Missing keystore.properties. Run ./scripts/create-upload-key.sh first, then add your passwords."
  exit 1
fi

if grep -q "CHANGE_ME" keystore.properties; then
  echo "keystore.properties still has CHANGE_ME placeholders. Replace them with your real passwords first."
  exit 1
fi

./gradlew clean bundleRelease

echo "Signed release bundle: app/build/outputs/bundle/release/app-release.aab"
