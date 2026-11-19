#!/bin/zsh
# Signs MacTuner.app with Developer ID + Hardened Runtime, notarizes with Apple notarytool,
# staples the ticket, and creates a distributable universal ZIP archive.
#
# Required env vars:
#   SIGN_IDENTITY   e.g. "Developer ID Application: Your Name (TEAMID)"
#   NOTARY_PROFILE  keychain profile created via `xcrun notarytool store-credentials`
set -euo pipefail
cd "$(dirname "$0")/.."

: "${SIGN_IDENTITY:?Set SIGN_IDENTITY (Developer ID Application certificate)}"
: "${NOTARY_PROFILE:?Set NOTARY_PROFILE (notarytool keychain profile)}"

./build_app.sh

APP="build/MacTuner.app"
VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" Info.plist)
ZIP="build/MacTuner-${VERSION}.zip"

echo "Signing ${APP} with hardened runtime..."
codesign --force --deep --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "Archiving ${ZIP}..."
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

echo "Submitting to Apple notarytool..."
xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait

echo "Stapling notarization ticket..."
xcrun stapler staple "$APP"

rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
echo "Done: ${ZIP} (SHA-256: $(shasum -a 256 "$ZIP" | awk '{print $1}'))"
