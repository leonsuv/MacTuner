<p align="center">
  <img src="docs/icon.png" width="112" alt="MacTuner — Open-Source ECU &amp; TCU Tuning Workbench">
</p>

<h1 align="center">MacTuner — ECU &amp; TCU Tuning Workbench</h1>

<p align="center">
  <strong>Open-source native alternative to TunerPro &amp; WinOLS for macOS (Apple Silicon &amp; Intel), Windows, Linux &amp; Web.</strong><br>
  Apple Pro Obsidian ECU &amp; TCU calibration workbench: Jewel-Tile Thermal Heatmap, Interactive 3D Surface, 60-FPS Split Hex-Diff, Structural Map Detection, TriCore/PowerPC/C166 Disassembler XREFs, 11 Checksums &amp; Virtual Dyno.
</p>

<p align="center">
  <a href="../../releases/latest"><img src="https://img.shields.io/github/v/release/leonsuv/MacTuner?label=Download&color=007AFF" alt="Download MacTuner"></a>
  <a href="https://mactuner.azendix.de/web/"><img src="https://img.shields.io/badge/Web%20App-Launch%20Free-2dd4bf" alt="Launch MacTuner Web App"></a>
  <img src="https://img.shields.io/badge/Platforms-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-lightgrey" alt="macOS Windows Linux Web">
  <img src="https://img.shields.io/badge/Languages-25-purple" alt="25 Languages">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License">
</p>

<p align="center">
  <a href="https://mactuner.azendix.de"><strong>Website</strong></a> ·
  <a href="https://mactuner.azendix.de/web/"><strong>Live Web App</strong></a> ·
  <a href="#gallery">Gallery</a> ·
  <a href="#features">Features</a> ·
  <a href="#install">Install</a> ·
  <a href="#supported-formats">Supported Formats</a> ·
  <a href="#building">Building</a>
</p>

![MacTuner 4: Jewel-Tile Thermal Heatmap, Interactive 3D Surface, Catmull-Rom 2D Curves and Multi-Cell ECU Calibration](docs/v4.0-map-editor.png)

**MacTuner** is a fast, local-first **ECU &amp; TCU map editor** for **macOS 14+ (Apple Silicon M1–M4 &amp; Intel), Windows, Linux, and the browser** — no Wine, no Parallels VM, no cloud uploads, and no hardware dongle. Built with **TypeScript, React, Canvas, and Tauri v2**, every binary edit is non-destructive, undoable, and strictly byte-exact.

Looking for a specific workflow on macOS? See the guides on **[TunerPro Alternative for macOS](https://mactuner.azendix.de/tunerpro-alternative-mac/)**, **[WinOLS Alternative for macOS](https://mactuner.azendix.de/winols-alternative-mac/)**, and **[XDF &amp; BIN Editor for macOS](https://mactuner.azendix.de/xdf-editor-mac/)**.

---

## Gallery

| **Split Hex-Diff, Map Detection &amp; 2D Waveform** | **Visual Memory Map &amp; Shared-Axis Pool** |
|---|---|
| ![MacTuner Split Hex-Diff with structural map detection and 2D Waveform](docs/v4.0-hex-diff.png) | ![MacTuner Visual Memory Map with proportional flash partition bar and sector breakdown](docs/v4.0-memory-map.png) |
| **Flash Preflight, Checksums, Diagnostics &amp; Snapshots** | **20 Hz Datalogger, XY Scatter &amp; Virtual Dyno** |
| ![MacTuner Flash Preflight with live ECU checksum repair and export presets](docs/v4.0-flash-preflight.png) | ![MacTuner 20 Hz WOT Dyno Pull Telemetry and SAE J1349 Virtual Dyno](docs/v4.0-virtual-dyno.png) |

---

## Features

- **Map Editor &amp; 3D Calibration:** Jewel-Tile thermal heatmap, top-down Lambertian 3D surface with comparison wireframe, smooth Catmull-Rom 2D curves, 3-way crosshair sync, multi-cell editing (`+%`, Smooth, Interpolate, Fill, `f(x)` formulas), curve-preserving Axis Rescaling, and 200-step persistent Undo/Redo.
- **Split Hex-Diff &amp; Reverse Engineering:** 60-FPS virtualized Split &amp; Single Hex-Diff, right-side 2D Heatmap Bars, Live Mini-Heatmap HUD, 2D Waveform, structural map detection (*Header Proof*), word-aligned byte shifting, and **TriCore / PowerPC / C166 Disassembler + Code XREFs**.
- **ECU/TCU Checksums, DTCs &amp; Preflight:** 11 built-in checksum plugins (**Bosch ME7, MED17/EDC17, MG1/MD1, BMW MEVD17.2, Siemens SIMOS, Continental SIMOS 18/19, SID208/305/310, Temic DQ250, DQ381/DQ500, DL501, CRC-32**), OEM DTC table switcher, Pre-Save Diff Review (`⌃⌘S`), Snapshots, and flash-tool export presets (KESS, KTAG, PCMFlash, Flex, CMDFlash, MPPS).
- **Datalogging &amp; Virtual Road Dyno:** 20 Hz datalogger, CSV (VCDS, ME7Logger, MHD, BM3, Cobb) / `.adx` / `.ads` import, XY scatter, 4-cell bilinear heatmap tracing, Math Channels, and SAE J1349 Virtual Dyno (HP / Nm).
- **Definitions &amp; Reports:** Built-in XDF editor, Shared-Axis Pool, Diagnostics &amp; Lint, Command Palette (`⌘K`), and standalone offline interactive HTML tune reports.
- **25 Languages &amp; Local-First:** Automatic OS/browser language detection + top-right Language Chooser across all 25 languages, signed Tauri v2 auto-updater, and a 100% client-side **[Web App](https://mactuner.azendix.de/web/)** with zero telemetry and zero uploads.

---

## Install

- **Web App (zero install):** Open **[mactuner.azendix.de/web](https://mactuner.azendix.de/web/)** — runs 100% locally in your browser.
- **macOS (Universal Apple Silicon &amp; Intel):** Download `MacTuner-4.1.2.zip` from [**Releases**](../../releases/latest) and move `MacTuner.app` to `/Applications`, or install via Homebrew (`Casks/mactuner.rb`):
  ```sh
  brew upgrade --cask mactuner
  ```
  If macOS Gatekeeper blocks the first launch:
  ```sh
  xattr -dr com.apple.quarantine /Applications/MacTuner.app
  ```

> [!WARNING]
> **Always verify checksums with your flashing tool before flashing.** Wrong calibration values or checksums can damage the engine or transmission. Use at your own risk.

---

## Supported Formats

| Category | Supported Formats |
|---|---|
| **Definitions** | TunerPro XDF 1.60 XML (incl. `<TABLEINFO>`), legacy XDF v1.11, ASAP2 `.a2l` / DAMOS, WinOLS v2–v5 `.ols` / `.kp` / `.csv`, RomRaider `.xml` |
| **Binaries** | Raw `.bin` / `.ori` / `.mod`, Intel HEX (`.hex` / `.ihex`), Motorola S-Record (`.s19` / `.s28` / `.s37` / `.srec`) |
| **Data Types** | 8 / 16 / 32-bit signed &amp; unsigned, Little &amp; Big Endian, column-major, 32-bit IEEE-754 Float, embedded &amp; label axes, `f(x)` equations |
| **Datalogs** | CSV (VCDS, ME7Logger, MHD, BM3, Cobb), TunerPro `.adx` / `.ads` |
| **Reports &amp; Projects** | `.mtproj` projects, standalone interactive HTML tune reports, PDF reports, snapshots |

---

## Building

```sh
cd web
npm ci
npm run build        # Static Web SPA → web/apps/studio/dist/
```

---

## License

[MIT](LICENSE). Not affiliated with TunerPro or WinOLS. No XDF or binary files are included.
