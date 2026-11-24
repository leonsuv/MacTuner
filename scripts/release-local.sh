#!/usr/bin/env bash
set -euo pipefail

# Local multiplatform build, signing & GitHub Release uploader (NO GitHub Actions CI required)
# Usage: ./scripts/release-local.sh v4.0.0

TAG="${1:-v4.0.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STUDIO="$ROOT/web/apps/studio"
KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/mactuner.key}"

echo "▶ 1/4 Running core tests, strict TypeScript check & Web production build..."
cd "$ROOT/web"
npm run test
npm run typecheck
npm run build

echo "▶ 2/4 Packaging static Web bundle..."
cd "$STUDIO"
rm -f "$ROOT/dist/MacTuner-Web-${TAG}.zip"
mkdir -p "$ROOT/dist"
(cd dist && zip -qr "$ROOT/dist/MacTuner-Web-${TAG}.zip" .)
echo "  ✓ $ROOT/dist/MacTuner-Web-${TAG}.zip"

if command -v cargo >/dev/null 2>&1; then
  echo "▶ 3/4 Building signed Tauri v2 desktop app (local host OS)..."
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
  npm run tauri:build
  echo "  ✓ Desktop bundles & updater artifacts written to $STUDIO/src-tauri/target/release/bundle/"
else
  echo "⚠ Rust (cargo) is not installed locally — skipping native Tauri desktop build."
  echo "  Install Rust once with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
fi

echo "▶ 4/4 Ready to publish with:"
echo "  gh release create $TAG $ROOT/dist/MacTuner-Web-${TAG}.zip --title \"MacTuner $TAG\" --generate-notes"
