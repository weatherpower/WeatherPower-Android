#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
"$DIR/create-upload-key.sh"
read -n 1 -s -r -p "Press any key to close..."
