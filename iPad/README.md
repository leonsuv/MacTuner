# MacTuner for iPad

`MacTunerPadApp.swift` is the iPadOS companion app for reviewing maps, inspecting diffs, and making quick edits on the road via Files / iCloud Drive.

## Building in Xcode

1. Create an iOS/iPadOS App target (`iPadOS 17+`) in Xcode.
2. Add `iPad/MacTunerPadApp.swift` plus the shared platform-independent engine files from `Sources/MacTuner/`:
   - `XDF.swift`
   - `Expr.swift`
   - `Changes.swift`
   - `TableOps.swift`
   - `UnitConverter.swift`
   - `ChecksumEngine.swift`
   - `MapDiagnostics.swift`
   - `XDFWriter.swift`
3. Build and run on iPad or iPad Simulator.
