#!/usr/bin/env bash
set -euo pipefail
# Ultra-fast (~2s) CLI TDD runner for MacTuner core engines — compiles only the
# non-UI engine files + TestSuite directly with swiftc, skipping SwiftUI views.

SDK="${SDKROOT:-/Library/Developer/CommandLineTools/SDKs/MacOSX26.sdk}"
OUT="/tmp/mactuner-tdd-runner"
MAIN_SWIFT="/tmp/mactuner-tdd-main.swift"

cat > "$MAIN_SWIFT" <<'SWIFT'
import Foundation
@main
struct TDDRunner {
    static func main() {
        exit(TestSuite.run())
    }
}
SWIFT

echo "⚡ Compiling MacTuner Core TDD runner..."
t0=$(date +%s)
SDKROOT="$SDK" swiftc -Onone \
  -DMACTUNER_CORE_TDD \
  -parse-as-library \
  -o "$OUT" \
  Sources/MacTuner/Expr.swift \
  Sources/MacTuner/XDF.swift \
  Sources/MacTuner/BinCodec.swift \
  Sources/MacTuner/XDFWriter.swift \
  Sources/MacTuner/Changes.swift \
  Sources/MacTuner/TableOps.swift \
  Sources/MacTuner/UnitConverter.swift \
  Sources/MacTuner/ECUIdentifier.swift \
  Sources/MacTuner/ChecksumEngine.swift \
  Sources/MacTuner/DisassemblerEngine.swift \
  Sources/MacTuner/MapFinder.swift \
  Sources/MacTuner/DefinitionImporter.swift \
  Sources/MacTuner/ReferenceLibrary.swift \
  Sources/MacTuner/RecipeEngine.swift \
  Sources/MacTuner/LiveOBDTransport.swift \
  Sources/MacTuner/TestSuite.swift \
  "$MAIN_SWIFT"
t1=$(date +%s)
echo "✅ Compiled in $((t1 - t0))s — running tests..."
"$OUT"
