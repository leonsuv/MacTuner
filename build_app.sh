#!/bin/zsh
# Builds MacTuner.app into build/ (universal: arm64 + x86_64).
# Optional self-test: MACTUNER_XDF=<xdf> MACTUNER_BIN=<bin> ./build_app.sh
# The macOS 27 SDK of the Command Line Tools lacks the SwiftUI macro plugin (only Xcode ships it),
# so the newest SDK without that requirement is used when Xcode is not installed.
set -euo pipefail
cd "$(dirname "$0")"

if [[ -z "${SDKROOT:-}" ]] && ! xcode-select -p | grep -q Xcode.app; then
  for v in 26.5 26; do
    sdk=/Library/Developer/CommandLineTools/SDKs/MacOSX$v.sdk
    if [[ -d $sdk ]]; then export SDKROOT=$sdk; break; fi
  done
fi

swift build -c release --arch arm64 --arch x86_64
BIN_DIR=$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)

XDF=${MACTUNER_XDF:-}
BIN=${MACTUNER_BIN:-}
if [[ -f $XDF && -f $BIN ]]; then
  "$BIN_DIR/MacTuner" --check "$XDF" "$BIN" | head -2
  tmp=$(mktemp -t mactuner); "$BIN_DIR/MacTuner" --edit-test "$XDF" "$BIN" "$tmp" | tail -1; rm -f "$tmp"
else
  echo "Selbsttest übersprungen (MACTUNER_XDF / MACTUNER_BIN setzen)"
fi

APP=build/MacTuner.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/MacTuner" "$APP/Contents/MacOS/"
cp Info.plist "$APP/Contents/"
[[ -f AppIcon.icns ]] && cp AppIcon.icns "$APP/Contents/Resources/"
cp -R Localization/*.lproj "$APP/Contents/Resources/"
codesign --force --sign - "$APP"
echo "fertig: $(pwd)/$APP"
