<p align="center">
  <img src="docs/icon.png" width="128" alt="MacTuner">
</p>

<h1 align="center">MacTuner</h1>

<p align="center">
  A native macOS editor for TunerPro XDF definitions: open the definition, then edit maps and values in the binary.
</p>

<p align="center">
  <a href="../../releases/latest"><img src="https://img.shields.io/github/v/release/leonsuv/MacTuner?label=Download" alt="Download"></a>
  <img src="https://img.shields.io/badge/macOS-14%2B-blue" alt="macOS 14+">
  <img src="https://img.shields.io/badge/Apple%20Silicon%20%2B%20Intel-universal-lightgrey" alt="Universal">
  <img src="https://img.shields.io/badge/Swift-SwiftUI-orange" alt="SwiftUI">
  <img src="https://img.shields.io/badge/languages-25-purple" alt="25 languages">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
</p>

![Map with heatmap, changed cells and chart](docs/table.png)

TunerPro only runs on Windows. MacTuner is a native SwiftUI app that runs without Wine, a VM or any dependencies.
It reads the same XDF files. When it saves the binary, only the bytes of the values you edited change.

## Features

- **Maps as heatmaps.** Axes are read from the binary or shown as labels. Long 1×N tables wrap into rows, and 2D maps can be transposed.
- **Charts.** Every row is drawn as a line, with the comparison drawn dashed underneath.
- **Comparison with a second binary**, such as the stock file. Without one, the app compares against the state when the file was opened. Changed cells get an orange dot, and the list can be filtered to *Changed only*.
- **Spreadsheet-style editing:**
  - Select a range, type a number and press ↩ to set it.
  - **+ / −** changes the selection by the step size. You can also change it by a percentage or reset it to the original.
  - Undo and redo.
- **Constants** with a large value display, raw value, step size and valid range.
- **Search** across titles and descriptions. Categories come from the XDF.
- Remembers the XDF, the binary and the selection between launches. Files can also be dropped onto the window.

| Constant | Long table (1 × 152) |
|---|---|
| ![Constant](docs/constant.png) | ![Long table](docs/long-table.png) |

## Languages

The interface is available in English, German, French, Spanish, Italian, Portuguese, Dutch, Swedish, Polish, Czech,
Slovenian, Croatian, Serbian, Romanian, Hungarian, Bulgarian, Greek, Turkish, Albanian, Ukrainian, Russian,
Chinese (Simplified and Traditional), Japanese and Korean.

MacTuner follows the system language and falls back to English. To use a different language for MacTuner only, go to
**System Settings → General → Language & Region → Applications**. Map names, descriptions and categories come from
the XDF and stay in the XDF's language.

All UI strings live in [`Localization/translations.py`](Localization/translations.py). After editing it, run
`python3 Localization/translations.py Localization`. This regenerates the `.strings` files and checks that every
language has all keys and matching placeholders.

## Installation

1. Download `MacTuner-x.y.z.zip` from [Releases](../../releases/latest) and unzip it. It contains a universal app for Apple Silicon and Intel.
2. Move `MacTuner.app` to `/Applications`.
3. The app is not notarized, so macOS blocks the first launch. Allow it under **System Settings → Privacy & Security → Open Anyway**, or run:
   ```sh
   xattr -dr com.apple.quarantine /Applications/MacTuner.app
   ```

## Usage

| Shortcut | Action |
|---|---|
| ⌘O / ⇧⌘O / ⌥⌘O | Open XDF / binary / comparison binary |
| ⌘S / ⇧⌘S | Save / Save As |
| ⌘Z / ⇧⌘Z | Undo / Redo |
| Click, ⇧-click, ⌘-click | Select a cell, a range, individual cells |
| Click an axis / the corner, ⌘A | Select a whole row or column / everything |
| Arrow keys (with ⇧) | Move (extend) the selection |
| Type a number + ↩ | Set the value |
| + / − | Change by the step size |

> [!WARNING]
> **MacTuner does not correct checksums.** Let your flashing tool fix the checksum before you flash.
> Wrong values can damage the engine or transmission. Use at your own risk.

## Supported XDF features

MacTuner supports the parts of the TunerPro XDF 1.60 format that typical definitions use:

- `XDFTABLE` with X, Y and Z axes, `XDFCONSTANT`, categories and descriptions.
- Data types: 8, 16 and 32 bit, signed and unsigned, little and big endian, column-major, float.
- Conversion formulas in `X` with `+ - * / ^` and parentheses. When you edit a value, MacTuner inverts the formula, falling back to a numeric bisection if needed.
- Output as a number or as hex. Axes come from the binary or from labels, or default to plain indices.

Flags/bitmasks (`XDFFLAG`), patches, checksum plugins and ADX/datalogging are not supported.

## Building

The Command Line Tools are enough; Xcode is not required.

```sh
./build_app.sh            # → build/MacTuner.app (universal)
```

The macOS 27 SDK that ships with the Command Line Tools lacks the SwiftUI macro plugin. Without Xcode, the script therefore uses the macOS 26 SDK automatically.

### Self-tests

If you have an XDF and a matching binary, the build also runs two tests:

```sh
MACTUNER_XDF=def.xdf MACTUNER_BIN=stock.bin ./build_app.sh
```

- `--check <xdf> <bin>`
  - reads every item;
  - compares constants with the "Original: N (roh)" values in their descriptions;
  - re-encodes every cell and expects exactly the same bytes.
- `--edit-test <xdf> <bin> <out>`
  - edits a few values through the same code the app uses;
  - saves the file;
  - compares it byte by byte with the original. Only the intended bytes may differ.

## License

[MIT](LICENSE). Not affiliated with TunerPro. No XDF or binary files are included.
