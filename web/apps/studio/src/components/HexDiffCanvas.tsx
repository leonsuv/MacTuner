import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  BarChart2,
  Bookmark,
  BookmarkPlus,
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Columns2,
  Copy,
  Cpu,
  Crosshair,
  Edit3,
  Filter,
  GitCompareArrows,
  Layers,
  Minus,
  Navigation,
  Plus,
  PlusSquare,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Square,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import * as core from '@mactuner/core';
import {
  layoutByteRange,
  type MapCandidate,
  type XDFDefinition,
  type XDFItem,
} from '@mactuner/core';
import { HexContextMenu } from './HexContextMenu';
import { HexMiniHud, type HeatmapPalette } from './HexMiniHud';
import { Waveform2D, wordFormatBytes, type HexWordFormat } from './Waveform2D';

export interface HexBookmark {
  id: string;
  address: number;
  label: string;
}

export interface HexDiffCanvasProps {
  bin: Uint8Array;
  compareBin: Uint8Array | null;
  binName: string;
  compareName: string;
  definition: XDFDefinition | null;
  candidates: MapCandidate[];
  jumpAddress: number | null;
  selectedRange: [number, number] | null;
  onSelectRange: (r: [number, number] | null) => void;
  onAddCandidateToXdf: (c: MapCandidate, openEditor: boolean) => void;
  onSelectXdfItem: (id: number) => void;
  onApplyPatch: (offset: number, next: Uint8Array, label: string) => void;
  onFindTwins: (range: [number, number]) => void;
  // Optional Swift MacTuner parity props (100% backwards-compatible)
  bookmarks?: HexBookmark[];
  onAddBookmark?: (address: number, label?: string) => void;
  onClearBookmarks?: () => void;
  onOpenXdfModalForSelection?: (
    range: [number, number],
    cols: number,
    format: HexWordFormat,
  ) => void;
  onOpenXdfModalForCandidate?: (candidate: MapCandidate) => void;
  onIgnoreCandidate?: (candidate: MapCandidate) => void;
  dismissedCandidateKeys?: Set<string> | string[];
  onRestoreDismissed?: () => void;
  onRescanCandidates?: () => void;
  heatmapPalette?: HeatmapPalette;
  onPatchBytes?: (offset: number, next: Uint8Array, label: string) => void;
}

type NumberBase = 'hex' | 'dec' | 'bin';
type ViewMode = 'text' | '2d' | '3d';
type RightPaneMode = 'val' | 'delta' | 'pct';
type CandidatePatternFilter = 'all' | '2d' | '1d' | 'bosch' | 'ptr';
type DrawerTab = 'xrefs' | 'disasm';
type CpuArch = 'auto' | 'tricore' | 'powerpc' | 'c166' | 'arm';

interface CodeXRef {
  address: number;
  target: number;
  kind: string;
  arch: string;
  instruction: string;
  confidence: number;
}

interface DisasmLine {
  address: number;
  bytes: string;
  size: number;
  mnemonic: string;
  operands: string;
  comment?: string;
}

interface SpanEntry {
  start: number;
  end: number;
  candidate: MapCandidate;
  role: 'data' | 'axis';
}

interface XdfSpan {
  start: number;
  end: number;
  item: XDFItem;
}

interface ContextMenuState {
  x: number;
  y: number;
  address: number;
  candidate: MapCandidate | null;
  xdfItem: XDFItem | null;
}

interface HoverState {
  address: number;
  candidate: MapCandidate | null;
  xdfItem: XDFItem | null;
  clientX: number;
  clientY: number;
}

interface PinnedHudState {
  candidate: MapCandidate | null;
  xdfItem: XDFItem | null;
  anchorX: number;
  anchorY: number;
}

interface TwinMatch {
  address: number;
  similarity: number;
}

const ROW_HEIGHT = 26;
const OVERSCAN = 6;
const MAX_VIRTUAL_PX = 8_000_000;

const f32Buf = new ArrayBuffer(4);
const f32View = new DataView(f32Buf);

const WORD_FORMAT_OPTIONS: Array<{ value: HexWordFormat; label: string }> = [
  { value: 'u8', label: '8-bit' },
  { value: 'u16le', label: '16 LoHi' },
  { value: 'u16be', label: '16 HiLo' },
  { value: 'u32le', label: '32 LoHi' },
  { value: 'u32be', label: '32 HiLo' },
  { value: 'f32le', label: 'F32 LoHi' },
  { value: 'f32be', label: 'F32 HiLo' },
];

function formatHexAddr(addr: number): string {
  return Math.max(0, addr).toString(16).toUpperCase().padStart(6, '0');
}

function candidateKey(c: MapCandidate): string {
  return `${c.address}_${c.rows}x${c.cols}_${c.bits}`;
}

function readWordNumeric(
  bytes: Uint8Array,
  offset: number,
  format: HexWordFormat,
  signed = false,
): number | null {
  if (offset < 0 || offset >= bytes.length) return null;
  if (format === 'u8') {
    const raw = bytes[offset];
    return signed && raw >= 128 ? raw - 256 : raw;
  }
  if (format === 'u16le' || format === 'u16be') {
    if (offset + 1 >= bytes.length) return null;
    const u =
      format === 'u16le'
        ? bytes[offset] | (bytes[offset + 1] << 8)
        : (bytes[offset] << 8) | bytes[offset + 1];
    return signed && u >= 32768 ? u - 65536 : u;
  }
  if (offset + 3 >= bytes.length) return null;
  if (format === 'f32le' || format === 'f32be') {
    f32View.setUint8(0, bytes[offset]);
    f32View.setUint8(1, bytes[offset + 1]);
    f32View.setUint8(2, bytes[offset + 2]);
    f32View.setUint8(3, bytes[offset + 3]);
    return f32View.getFloat32(0, format === 'f32le');
  }
  const u32 =
    format === 'u32le'
      ? (bytes[offset] |
          (bytes[offset + 1] << 8) |
          (bytes[offset + 2] << 16) |
          (bytes[offset + 3] << 24)) >>>
        0
      : ((bytes[offset] << 24) |
          (bytes[offset + 1] << 16) |
          (bytes[offset + 2] << 8) |
          bytes[offset + 3]) >>>
        0;
  return signed && u32 >= 0x80000000 ? u32 - 0x100000000 : u32;
}

function writeWordNumeric(
  target: Uint8Array,
  offset: number,
  value: number,
  format: HexWordFormat,
  signed = false,
): void {
  if (format === 'u8') {
    const clamped = signed
      ? Math.max(-128, Math.min(127, Math.round(value)))
      : Math.max(0, Math.min(255, Math.round(value)));
    target[offset] = clamped & 0xff;
    return;
  }
  if (format === 'u16le' || format === 'u16be') {
    const clamped = signed
      ? Math.max(-32768, Math.min(32767, Math.round(value)))
      : Math.max(0, Math.min(65535, Math.round(value)));
    const u = clamped & 0xffff;
    if (format === 'u16le') {
      target[offset] = u & 0xff;
      target[offset + 1] = (u >> 8) & 0xff;
    } else {
      target[offset] = (u >> 8) & 0xff;
      target[offset + 1] = u & 0xff;
    }
    return;
  }
  if (format === 'f32le' || format === 'f32be') {
    f32View.setFloat32(0, value, format === 'f32le');
    for (let i = 0; i < 4; i++) target[offset + i] = f32View.getUint8(i);
    return;
  }
  const clamped = signed
    ? Math.max(-2147483648, Math.min(2147483647, Math.round(value)))
    : Math.max(0, Math.min(0xffffffff, Math.round(value)));
  const u = clamped >>> 0;
  if (format === 'u32le') {
    target[offset] = u & 0xff;
    target[offset + 1] = (u >>> 8) & 0xff;
    target[offset + 2] = (u >>> 16) & 0xff;
    target[offset + 3] = (u >>> 24) & 0xff;
  } else {
    target[offset] = (u >>> 24) & 0xff;
    target[offset + 1] = (u >>> 16) & 0xff;
    target[offset + 2] = (u >>> 8) & 0xff;
    target[offset + 3] = u & 0xff;
  }
}

function readWordFormatted(
  bytes: Uint8Array,
  offset: number,
  format: HexWordFormat,
  base: NumberBase = 'hex',
  signed = false,
): string {
  if (offset < 0 || offset >= bytes.length) return '··';
  const wb = wordFormatBytes(format);
  if (offset + wb > bytes.length) {
    return `${bytes[offset].toString(16).toUpperCase().padStart(2, '0')}··`;
  }
  if (base === 'bin') {
    if (format === 'u8') return bytes[offset].toString(2).padStart(8, '0');
    // For multi-byte words in Bin mode, show MSB..LSB byte binary compactly
    if (wb === 2) {
      const val =
        format === 'u16le'
          ? bytes[offset] | (bytes[offset + 1] << 8)
          : (bytes[offset] << 8) | bytes[offset + 1];
      return `${((val >> 8) & 0xff).toString(2).padStart(8, '0')}`;
    }
    return bytes[offset].toString(2).padStart(8, '0');
  }

  if (format === 'f32le' || format === 'f32be') {
    const val = readWordNumeric(bytes, offset, format, false);
    if (val === null || !Number.isFinite(val)) return 'NaN';
    if (base === 'hex') {
      const u32 =
        format === 'f32le'
          ? (bytes[offset] |
              (bytes[offset + 1] << 8) |
              (bytes[offset + 2] << 16) |
              (bytes[offset + 3] << 24)) >>>
            0
          : ((bytes[offset] << 24) |
              (bytes[offset + 1] << 16) |
              (bytes[offset + 2] << 8) |
              bytes[offset + 3]) >>>
            0;
      return u32.toString(16).toUpperCase().padStart(8, '0');
    }
    return Math.abs(val) >= 1000 || (Math.abs(val) > 0 && Math.abs(val) < 0.01)
      ? val.toExponential(1)
      : val.toFixed(2);
  }

  const num = readWordNumeric(bytes, offset, format, signed);
  if (num === null) return '··';
  if (base === 'dec') return String(num);

  // Hex display
  if (format === 'u8') return bytes[offset].toString(16).toUpperCase().padStart(2, '0');
  if (format === 'u16le' || format === 'u16be') {
    const u =
      format === 'u16le'
        ? bytes[offset] | (bytes[offset + 1] << 8)
        : (bytes[offset] << 8) | bytes[offset + 1];
    return u.toString(16).toUpperCase().padStart(4, '0');
  }
  const u32 =
    format === 'u32le'
      ? (bytes[offset] |
          (bytes[offset + 1] << 8) |
          (bytes[offset + 2] << 16) |
          (bytes[offset + 3] << 24)) >>>
        0
      : ((bytes[offset] << 24) |
          (bytes[offset + 1] << 16) |
          (bytes[offset + 2] << 8) |
          bytes[offset + 3]) >>>
        0;
  return u32.toString(16).toUpperCase().padStart(8, '0');
}

function normalizedWordRatio(
  bytes: Uint8Array,
  offset: number,
  format: HexWordFormat,
  signed: boolean,
): number {
  const v = readWordNumeric(bytes, offset, format, signed);
  if (v === null || !Number.isFinite(v)) return 0;
  if (format === 'u8') return signed ? (v + 128) / 255 : v / 255;
  if (format === 'u16le' || format === 'u16be') return signed ? (v + 32768) / 65535 : v / 65535;
  if (format === 'u32le' || format === 'u32be') {
    return signed ? (v + 0x80000000) / 0xffffffff : v / 0xffffffff;
  }
  return Math.max(0, Math.min(1, 0.5 + Math.atan(v / 100) / Math.PI));
}

function isWordDiff(
  bin: Uint8Array,
  compareBin: Uint8Array | null,
  offset: number,
  wordBytes: number,
  compareShift = 0,
): boolean {
  if (!compareBin) return false;
  for (let i = 0; i < wordBytes; i++) {
    const idx = offset + i;
    const cIdx = idx + compareShift;
    if (
      idx >= 0 &&
      idx < bin.length &&
      cIdx >= 0 &&
      cIdx < compareBin.length &&
      bin[idx] !== compareBin[cIdx]
    ) {
      return true;
    }
  }
  return false;
}

// Parse pattern search query: supports hex bytes, `??` wildcards, and `"ASCII"` strings
function parseSearchPattern(query: string): Array<number | null> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const pattern: Array<number | null> = [];
  let i = 0;
  while (i < trimmed.length) {
    if (/\s/.test(trimmed[i])) {
      i++;
      continue;
    }
    if (trimmed[i] === '"') {
      i++;
      while (i < trimmed.length && trimmed[i] !== '"') {
        pattern.push(trimmed.charCodeAt(i) & 0xff);
        i++;
      }
      if (i < trimmed.length && trimmed[i] === '"') i++;
      continue;
    }
    // Read token until whitespace or quote
    let tok = '';
    while (i < trimmed.length && !/\s/.test(trimmed[i]) && trimmed[i] !== '"') {
      tok += trimmed[i];
      i++;
    }
    if (tok === '?' || tok === '??') {
      pattern.push(null);
      continue;
    }
    const clean = tok.replace(/^0x/i, '');
    if (/^[0-9a-fA-F?]+$/.test(clean)) {
      for (let j = 0; j < clean.length; j += 2) {
        const pair = clean.slice(j, j + 2);
        if (pair.includes('?')) {
          pattern.push(null);
        } else if (pair.length === 2) {
          pattern.push(parseInt(pair, 16) & 0xff);
        } else if (pair.length === 1) {
          pattern.push(parseInt(pair, 16) & 0xff);
        }
      }
    } else {
      // Fallback: treat unquoted non-hex token as ASCII
      for (let j = 0; j < tok.length; j++) {
        pattern.push(tok.charCodeAt(j) & 0xff);
      }
    }
  }
  return pattern;
}

// Fast local twin scanner for the inline Twins popover
function scanTwinsInBin(
  bin: Uint8Array,
  range: [number, number],
  wordBytes: number,
): TwinMatch[] {
  const [start, end] = range;
  const len = Math.min(end, bin.length) - start;
  if (len < 4 || len > 4096) return [];

  const template = bin.subarray(start, start + len);
  const step = Math.max(1, wordBytes);
  const results: TwinMatch[] = [];

  // Sample up to 64 evenly spaced bytes for ultra-fast prefilter
  const sampleCount = Math.min(len, 48);
  const sampleOffsets: number[] = [];
  for (let s = 0; s < sampleCount; s++) {
    sampleOffsets.push(Math.floor((s / sampleCount) * len));
  }

  let tmplMean = 0;
  for (const so of sampleOffsets) tmplMean += template[so];
  tmplMean /= sampleCount;

  let tmplVar = 0;
  for (const so of sampleOffsets) {
    const d = template[so] - tmplMean;
    tmplVar += d * d;
  }

  for (let off = 0; off + len <= bin.length; off += step) {
    if (Math.abs(off - start) < len) continue;

    // Fast normalized difference & correlation check
    let absDiff = 0;
    let candMean = 0;
    for (const so of sampleOffsets) {
      const v = bin[off + so];
      absDiff += Math.abs(v - template[so]);
      candMean += v;
    }
    const directSim = 1 - absDiff / (sampleCount * 255);
    if (directSim < 0.72 && tmplVar < 1) continue;

    let sim = directSim;
    if (tmplVar >= 16) {
      candMean /= sampleCount;
      let cov = 0;
      let candVar = 0;
      for (const so of sampleOffsets) {
        const dt = template[so] - tmplMean;
        const dc = bin[off + so] - candMean;
        cov += dt * dc;
        candVar += dc * dc;
      }
      if (candVar > 1) {
        const corr = cov / Math.sqrt(tmplVar * candVar);
        sim = Math.max(directSim, corr * 0.95);
      }
    }

    if (sim >= 0.86) {
      results.push({ address: off, similarity: Math.min(1, sim) });
      off += Math.max(step, Math.floor(len / 2)); // skip overlapping echoes
      if (results.length >= 24) break;
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, 16);
}

// Adapter for @mactuner/core's findCodeXRefs with built-in deterministic fallback
function resolveCodeXRefs(bin: Uint8Array, targetAddress: number): CodeXRef[] {
  const coreMod = core as unknown as Record<string, unknown>;
  if (typeof coreMod.findCodeXRefs === 'function') {
    try {
      const res = (coreMod.findCodeXRefs as (b: Uint8Array, addr: number) => unknown)(
        bin,
        targetAddress,
      );
      if (Array.isArray(res)) {
        return res.slice(0, 128).map((item: Record<string, unknown>) => ({
          address: Number(item.address ?? item.offset ?? item.codeAddress ?? 0),
          target: Number(item.target ?? item.targetAddress ?? targetAddress),
          kind: String(item.kind ?? item.type ?? 'PTR'),
          arch: String(item.arch ?? item.architecture ?? 'ECU'),
          instruction: String(item.instruction ?? item.disasm ?? item.preview ?? 'MOV / LEA'),
          confidence: typeof item.confidence === 'number' ? item.confidence : 0.85,
        }));
      }
    } catch {
      // Fallback below
    }
  }

  const results: CodeXRef[] = [];
  const seen = new Set<number>();
  const aliases = [
    { val: targetAddress >>> 0, label: 'ABS32', arch: 'TriCore' },
    { val: (0x80000000 + targetAddress) >>> 0, label: 'PFLASH', arch: 'TriCore' },
    { val: (0xa0000000 + targetAddress) >>> 0, label: 'NC-FLASH', arch: 'TriCore' },
    { val: (0x00800000 + targetAddress) >>> 0, label: 'MPC-ROM', arch: 'PowerPC' },
  ];

  const len = bin.length;
  for (let i = 0; i + 4 <= len && results.length < 64; i += 2) {
    if (Math.abs(i - targetAddress) < 4) continue;
    const u32le = (bin[i] | (bin[i + 1] << 8) | (bin[i + 2] << 16) | (bin[i + 3] << 24)) >>> 0;
    const u32be = ((bin[i] << 24) | (bin[i + 1] << 16) | (bin[i + 2] << 8) | bin[i + 3]) >>> 0;

    for (const alias of aliases) {
      if (u32le === alias.val && !seen.has(i)) {
        seen.add(i);
        results.push({
          address: i,
          target: targetAddress,
          kind: `${alias.label} LE`,
          arch: alias.arch,
          instruction: `movh.a a4, #0x${((alias.val >>> 16) & 0xffff).toString(16).toUpperCase()}; lea a4, [a4]0x${(alias.val & 0xffff).toString(16).toUpperCase()}`,
          confidence: 0.94,
        });
      } else if (u32be === alias.val && !seen.has(i)) {
        seen.add(i);
        results.push({
          address: i,
          target: targetAddress,
          kind: `${alias.label} BE`,
          arch: 'PowerPC',
          instruction: `lis r4, 0x${((alias.val >>> 16) & 0xffff).toString(16).toUpperCase()}; addi r4, r4, 0x${(alias.val & 0xffff).toString(16).toUpperCase()}`,
          confidence: 0.91,
        });
      }
    }
  }

  const low16 = targetAddress & 0xffff;
  if (results.length < 12 && low16 > 0x0100 && low16 !== 0xffff) {
    const lo = low16 & 0xff;
    const hi = (low16 >> 8) & 0xff;
    for (let i = 0; i + 4 <= len && results.length < 24; i += 2) {
      if (Math.abs(i - targetAddress) < 16) continue;
      if (bin[i] === 0xe6 && bin[i + 2] === lo && bin[i + 3] === hi && !seen.has(i)) {
        seen.add(i);
        const reg = bin[i + 1] & 0x0f;
        results.push({
          address: i,
          target: targetAddress,
          kind: 'DPP16',
          arch: 'C166',
          instruction: `mov r${reg}, #0x${low16.toString(16).toUpperCase().padStart(4, '0')}`,
          confidence: 0.72,
        });
      }
    }
  }

  return results;
}

function resolveDisasmSlice(
  bin: Uint8Array,
  startAddress: number,
  arch: CpuArch,
  lineCount = 36,
): DisasmLine[] {
  const coreMod = core as unknown as Record<string, unknown>;
  if (typeof coreMod.disassembleSlice === 'function') {
    try {
      const res = (
        coreMod.disassembleSlice as (
          b: Uint8Array,
          addr: number,
          opts?: { arch?: string; count?: number; length?: number },
        ) => unknown
      )(bin, startAddress, {
        arch: arch === 'auto' ? undefined : arch,
        count: lineCount,
        length: lineCount * 4,
      });
      const list = Array.isArray(res)
        ? res
        : res && typeof res === 'object' && Array.isArray((res as { instructions?: unknown }).instructions)
          ? (res as { instructions: unknown[] }).instructions
          : null;
      if (list) {
        return list.slice(0, lineCount).map((ins) => {
          const rec = ins as Record<string, unknown>;
          const rawBytes = Array.isArray(rec.bytes)
            ? (rec.bytes as number[]).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
            : typeof rec.bytes === 'string'
              ? rec.bytes
              : '';
          return {
            address: Number(rec.address ?? startAddress),
            bytes: rawBytes,
            size: Number(rec.size ?? rec.length ?? 4),
            mnemonic: String(rec.mnemonic ?? 'dc.w'),
            operands: String(rec.operands ?? ''),
            comment: rec.comment ? String(rec.comment) : undefined,
          };
        });
      }
    } catch {
      // Fallback below
    }
  }

  const lines: DisasmLine[] = [];
  let pc = Math.max(0, startAddress & ~1);
  const resolvedArch: Exclude<CpuArch, 'auto'> =
    arch === 'auto' ? (bin.length >= 2 * 1024 * 1024 ? 'tricore' : 'c166') : arch;

  for (let i = 0; i < lineCount && pc < bin.length; i++) {
    if (resolvedArch === 'powerpc' || resolvedArch === 'arm') {
      if (pc + 4 > bin.length) break;
      const b0 = bin[pc];
      const b1 = bin[pc + 1];
      const b2 = bin[pc + 2];
      const b3 = bin[pc + 3];
      const bytesStr = `${b0.toString(16).toUpperCase().padStart(2, '0')} ${b1.toString(16).toUpperCase().padStart(2, '0')} ${b2.toString(16).toUpperCase().padStart(2, '0')} ${b3.toString(16).toUpperCase().padStart(2, '0')}`;
      const word =
        resolvedArch === 'powerpc'
          ? ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0
          : (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;

      if (resolvedArch === 'powerpc') {
        const op = (word >>> 26) & 0x3f;
        const rd = (word >>> 21) & 0x1f;
        const ra = (word >>> 16) & 0x1f;
        const imm = word & 0xffff;
        let mnemonic = '.word';
        let operands = `0x${word.toString(16).toUpperCase().padStart(8, '0')}`;
        if (word === 0x60000000) {
          mnemonic = 'nop';
          operands = '';
        } else if (word === 0x4e800020) {
          mnemonic = 'blr';
          operands = '';
        } else if (op === 14) {
          mnemonic = ra === 0 ? 'li' : 'addi';
          operands = ra === 0 ? `r${rd}, 0x${imm.toString(16).toUpperCase()}` : `r${rd}, r${ra}, 0x${imm.toString(16).toUpperCase()}`;
        } else if (op === 15) {
          mnemonic = ra === 0 ? 'lis' : 'addis';
          operands = ra === 0 ? `r${rd}, 0x${imm.toString(16).toUpperCase()}` : `r${rd}, r${ra}, 0x${imm.toString(16).toUpperCase()}`;
        } else if (op === 32) {
          mnemonic = 'lwz';
          operands = `r${rd}, 0x${imm.toString(16).toUpperCase()}(r${ra})`;
        } else if (op === 36) {
          mnemonic = 'stw';
          operands = `r${rd}, 0x${imm.toString(16).toUpperCase()}(r${ra})`;
        } else if (op === 40) {
          mnemonic = 'lhz';
          operands = `r${rd}, 0x${imm.toString(16).toUpperCase()}(r${ra})`;
        } else if (op === 18) {
          const lk = word & 1;
          let off = word & 0x03fffffc;
          if (off & 0x02000000) off |= 0xfc000000;
          mnemonic = lk ? 'bl' : 'b';
          operands = `0x${((pc + off) >>> 0).toString(16).toUpperCase().padStart(6, '0')}`;
        }
        lines.push({ address: pc, bytes: bytesStr, size: 4, mnemonic, operands });
      } else {
        const cond = (word >>> 28) & 0xf;
        let mnemonic = 'dcd';
        let operands = `0x${word.toString(16).toUpperCase().padStart(8, '0')}`;
        if (word === 0xe1a00000) {
          mnemonic = 'nop';
          operands = '';
        } else if (word === 0xe12fff1e) {
          mnemonic = 'bx';
          operands = 'lr';
        } else if (cond === 0xe && ((word >>> 25) & 7) === 5) {
          const link = (word >>> 24) & 1;
          let rel = (word & 0x00ffffff) << 2;
          if (rel & 0x02000000) rel |= 0xfc000000;
          mnemonic = link ? 'bl' : 'b';
          operands = `0x${((pc + 8 + rel) >>> 0).toString(16).toUpperCase().padStart(6, '0')}`;
        } else if (cond === 0xe && ((word >>> 26) & 3) === 1) {
          const load = (word >>> 20) & 1;
          const rn = (word >>> 16) & 0xf;
          const rd = (word >>> 12) & 0xf;
          const off = word & 0xfff;
          mnemonic = load ? 'ldr' : 'str';
          operands = `r${rd}, [r${rn}, #0x${off.toString(16).toUpperCase()}]`;
        }
        lines.push({ address: pc, bytes: bytesStr, size: 4, mnemonic, operands });
      }
      pc += 4;
    } else if (resolvedArch === 'tricore') {
      const op1 = bin[pc];
      const is32 = (op1 & 0x01) !== 0 && pc + 4 <= bin.length;
      const size = is32 ? 4 : Math.min(2, bin.length - pc);
      const raw = bin.subarray(pc, pc + size);
      const bytesStr = Array.from(raw, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      let mnemonic = size === 4 ? 'dc.l' : 'dc.w';
      let operands = Array.from(raw, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');

      if (size === 2) {
        const w = bin[pc] | ((bin[pc + 1] ?? 0) << 8);
        if (w === 0x0000) {
          mnemonic = 'nop';
          operands = '';
        } else if (w === 0x9000) {
          mnemonic = 'ret';
          operands = '';
        } else if (op1 === 0x82) {
          mnemonic = 'mov';
          operands = `d${(w >> 8) & 0xf}, #${(w >> 12) & 0xf}`;
        } else if (op1 === 0x02) {
          mnemonic = 'mov';
          operands = `d${(w >> 8) & 0xf}, d${(w >> 12) & 0xf}`;
        } else if (op1 === 0x42) {
          mnemonic = 'add';
          operands = `d${(w >> 8) & 0xf}, d${(w >> 12) & 0xf}`;
        } else if (op1 === 0x3c) {
          let disp = (w >> 8) & 0xff;
          if (disp & 0x80) disp -= 256;
          mnemonic = 'j';
          operands = `0x${((pc + disp * 2) >>> 0).toString(16).toUpperCase().padStart(6, '0')}`;
        } else {
          operands = `0x${w.toString(16).toUpperCase().padStart(4, '0')}`;
        }
      } else {
        const w = (bin[pc] | (bin[pc + 1] << 8) | (bin[pc + 2] << 16) | (bin[pc + 3] << 24)) >>> 0;
        const rd = (w >>> 28) & 0xf;
        const rs = (w >>> 8) & 0xf;
        const imm16 = (w >>> 12) & 0xffff;
        if (op1 === 0x91) {
          mnemonic = 'movh.a';
          operands = `a${rd}, #0x${imm16.toString(16).toUpperCase().padStart(4, '0')}`;
        } else if (op1 === 0xd9) {
          mnemonic = 'lea';
          operands = `a${rd}, [a${rs}]0x${imm16.toString(16).toUpperCase()}`;
        } else if (op1 === 0x3b) {
          mnemonic = 'mov';
          operands = `d${rd}, #0x${imm16.toString(16).toUpperCase()}`;
        } else if (op1 === 0x6d) {
          let disp24 = ((w >>> 8) & 0xffff) | (((w >>> 24) & 0xff) << 16);
          if (disp24 & 0x800000) disp24 |= 0xff000000;
          mnemonic = 'call';
          operands = `0x${((pc + disp24 * 2) >>> 0).toString(16).toUpperCase().padStart(6, '0')}`;
        } else if (op1 === 0x1d) {
          let disp24 = ((w >>> 8) & 0xffff) | (((w >>> 24) & 0xff) << 16);
          if (disp24 & 0x800000) disp24 |= 0xff000000;
          mnemonic = 'j';
          operands = `0x${((pc + disp24 * 2) >>> 0).toString(16).toUpperCase().padStart(6, '0')}`;
        } else {
          operands = `0x${w.toString(16).toUpperCase().padStart(8, '0')}`;
        }
      }
      lines.push({ address: pc, bytes: bytesStr, size, mnemonic, operands });
      pc += size;
    } else {
      const op = bin[pc];
      const is32 =
        (op === 0xe6 || op === 0xf2 || op === 0xf6 || op === 0xda || op === 0xfa || op === 0xea) &&
        pc + 4 <= bin.length;
      const size = is32 ? 4 : Math.min(2, bin.length - pc);
      const raw = bin.subarray(pc, pc + size);
      const bytesStr = Array.from(raw, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      let mnemonic = 'dc.w';
      let operands = '';

      if (op === 0xcc && bin[pc + 1] === 0x00) {
        mnemonic = 'nop';
      } else if (op === 0xcb && bin[pc + 1] === 0x00) {
        mnemonic = 'ret';
      } else if (op === 0xdb && bin[pc + 1] === 0x00) {
        mnemonic = 'rets';
      } else if (op === 0xe6 && size === 4) {
        const imm = bin[pc + 2] | (bin[pc + 3] << 8);
        mnemonic = 'mov';
        operands = `r${bin[pc + 1] & 0xf}, #0x${imm.toString(16).toUpperCase().padStart(4, '0')}`;
      } else if (op === 0xf2 && size === 4) {
        const addr16 = bin[pc + 2] | (bin[pc + 3] << 8);
        mnemonic = 'mov';
        operands = `r${bin[pc + 1] & 0xf}, [0x${addr16.toString(16).toUpperCase().padStart(4, '0')}]`;
      } else if (op === 0xda && size === 4) {
        const seg = bin[pc + 1];
        const off16 = bin[pc + 2] | (bin[pc + 3] << 8);
        mnemonic = 'calls';
        operands = `0x${seg.toString(16).toUpperCase().padStart(2, '0')}, 0x${off16.toString(16).toUpperCase().padStart(4, '0')}`;
      } else if (op === 0xf0 && size === 2) {
        mnemonic = 'mov';
        operands = `r${(bin[pc + 1] >> 4) & 0xf}, r${bin[pc + 1] & 0xf}`;
      } else if (op === 0x00 && size === 2) {
        mnemonic = 'add';
        operands = `r${(bin[pc + 1] >> 4) & 0xf}, r${bin[pc + 1] & 0xf}`;
      } else {
        const w = bin[pc] | ((bin[pc + 1] ?? 0) << 8);
        operands = `0x${w.toString(16).toUpperCase().padStart(4, '0')}`;
      }
      lines.push({ address: pc, bytes: bytesStr, size, mnemonic, operands });
      pc += size;
    }
  }
  return lines;
}

// Interactive HTML5 Canvas 3D Hex Surface Preview
interface HexSurface3DProps {
  bin: Uint8Array;
  startAddress: number;
  rows: number;
  cols: number;
  wordFormat: HexWordFormat;
  signed: boolean;
  onExit: () => void;
}

const HexSurface3D: React.FC<HexSurface3DProps> = ({
  bin,
  startAddress,
  rows,
  cols,
  wordFormat,
  signed,
  onExit,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [yaw, setYaw] = useState<number>(-0.62);
  const [pitch, setPitch] = useState<number>(0.58);
  const [zoom, setZoom] = useState<number>(1.0);
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);

  const grid = useMemo(() => {
    const wb = wordFormatBytes(wordFormat);
    const rCount = Math.max(2, Math.min(32, rows));
    const cCount = Math.max(2, Math.min(32, cols));
    const values = new Float64Array(rCount * cCount);
    let min = Infinity;
    let max = -Infinity;
    for (let r = 0; r < rCount; r++) {
      for (let c = 0; c < cCount; c++) {
        const off = startAddress + (r * cCount + c) * wb;
        const v = readWordNumeric(bin, off, wordFormat, signed) ?? 0;
        const safe = Number.isFinite(v) ? v : 0;
        values[r * cCount + c] = safe;
        if (safe < min) min = safe;
        if (safe > max) max = safe;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0;
      max = 1;
    }
    return { rCount, cCount, values, min, max };
  }, [bin, startAddress, rows, cols, wordFormat, signed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;

    const draw = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(300, Math.floor(rect.width));
      const height = Math.max(240, Math.floor(rect.height));
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Deep obsidian radial backdrop
      const bg = ctx.createRadialGradient(
        width * 0.5,
        height * 0.45,
        20,
        width * 0.5,
        height * 0.5,
        Math.max(width, height) * 0.7,
      );
      bg.addColorStop(0, '#161822');
      bg.addColorStop(1, '#0c0d10');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      const { rCount, cCount, values, min, max } = grid;
      const span = max - min || 1;
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const cosP = Math.cos(pitch);
      const sinP = Math.sin(pitch);
      const scale = Math.min(width, height) * 0.42 * zoom;
      const cx = width * 0.5;
      const cy = height * 0.56;

      const project = (x: number, y: number, z: number) => {
        // Rotate around Y (yaw), then X (pitch)
        const x1 = x * cosY - z * sinY;
        const z1 = x * sinY + z * cosY;
        const y2 = y * cosP - z1 * sinP;
        const z2 = y * sinP + z1 * cosP;
        const persp = 3.2 / Math.max(0.8, 3.2 - z2 * 0.65);
        return {
          sx: cx + x1 * scale * persp,
          sy: cy - y2 * scale * persp,
          depth: z2,
        };
      };

      const pts: Array<Array<{ sx: number; sy: number; depth: number; t: number }>> = [];
      for (let r = 0; r < rCount; r++) {
        const rowPts: Array<{ sx: number; sy: number; depth: number; t: number }> = [];
        for (let c = 0; c < cCount; c++) {
          const t = (values[r * cCount + c] - min) / span;
          const nx = (c / Math.max(1, cCount - 1) - 0.5) * 1.6;
          const nz = (r / Math.max(1, rCount - 1) - 0.5) * 1.6;
          const ny = (t - 0.35) * 0.9;
          const p = project(nx, ny, nz);
          rowPts.push({ ...p, t });
        }
        pts.push(rowPts);
      }

      // Draw painter-sorted quads
      interface Quad {
        p00: { sx: number; sy: number; depth: number; t: number };
        p10: { sx: number; sy: number; depth: number; t: number };
        p11: { sx: number; sy: number; depth: number; t: number };
        p01: { sx: number; sy: number; depth: number; t: number };
        depth: number;
        t: number;
      }
      const quads: Quad[] = [];
      for (let r = 0; r < rCount - 1; r++) {
        for (let c = 0; c < cCount - 1; c++) {
          const p00 = pts[r][c];
          const p10 = pts[r][c + 1];
          const p11 = pts[r + 1][c + 1];
          const p01 = pts[r + 1][c];
          quads.push({
            p00,
            p10,
            p11,
            p01,
            depth: (p00.depth + p10.depth + p11.depth + p01.depth) * 0.25,
            t: (p00.t + p10.t + p11.t + p01.t) * 0.25,
          });
        }
      }
      quads.sort((a, b) => a.depth - b.depth);

      const thermalHex = (t: number) => {
        const cl = Math.max(0, Math.min(1, t));
        const r = Math.round(cl < 0.5 ? 10 + cl * 2 * 42 : 52 + (cl - 0.5) * 2 * 192);
        const g = Math.round(cl < 0.5 ? 110 + cl * 2 * 110 : 220 - (cl - 0.5) * 2 * 150);
        const b = Math.round(cl < 0.5 ? 255 - cl * 2 * 60 : 195 - (cl - 0.5) * 2 * 130);
        return `rgba(${r}, ${g}, ${b}, 0.84)`;
      };

      for (const q of quads) {
        ctx.beginPath();
        ctx.moveTo(q.p00.sx, q.p00.sy);
        ctx.lineTo(q.p10.sx, q.p10.sy);
        ctx.lineTo(q.p11.sx, q.p11.sy);
        ctx.lineTo(q.p01.sx, q.p01.sy);
        ctx.closePath();
        ctx.fillStyle = thermalHex(q.t);
        ctx.fill();
        ctx.strokeStyle = 'rgba(12, 13, 16, 0.45)';
        ctx.lineWidth = 0.75;
        ctx.stroke();
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(host);
    return () => ro.disconnect();
  }, [grid, yaw, pitch, zoom]);

  return (
    <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden bg-[#0c0d10]">
      <canvas
        ref={canvasRef}
        onMouseDown={(e) => {
          dragRef.current = { x: e.clientX, y: e.clientY, yaw, pitch };
        }}
        onMouseMove={(e) => {
          if (!dragRef.current) return;
          const dx = e.clientX - dragRef.current.x;
          const dy = e.clientY - dragRef.current.y;
          setYaw(dragRef.current.yaw + dx * 0.008);
          setPitch(Math.max(-1.2, Math.min(1.4, dragRef.current.pitch + dy * 0.008)));
        }}
        onMouseUp={() => {
          dragRef.current = null;
        }}
        onMouseLeave={() => {
          dragRef.current = null;
        }}
        onWheel={(e) => {
          e.preventDefault();
          setZoom((z) => Math.max(0.45, Math.min(2.4, z * (e.deltaY > 0 ? 0.92 : 1.08))));
        }}
        className="block h-full w-full cursor-grab active:cursor-grabbing"
      />
      <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-lg border border-white/[0.08] bg-[#17181d]/90 px-2.5 py-1.5 font-mono text-[11px] text-zinc-200 backdrop-blur-md">
        <Box className="h-3.5 w-3.5 text-[#0a84ff]" />
        <span>3D Hex Surface</span>
        <span className="text-sky-300">0x{formatHexAddr(startAddress)}</span>
        <span className="text-zinc-400">
          {grid.rCount}×{grid.cCount} ({wordFormat})
        </span>
        <span className="text-zinc-500">
          [{Math.round(grid.min)}..{Math.round(grid.max)}]
        </span>
      </div>
      <div className="absolute right-3 top-3 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            setYaw(-0.62);
            setPitch(0.58);
            setZoom(1.0);
          }}
          className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#17181d]/90 px-2 py-1 text-[11px] text-zinc-200 hover:bg-white/[0.1] cursor-pointer"
        >
          <RotateCcw className="h-3 w-3" />
          Reset Orbit
        </button>
        <button
          type="button"
          onClick={onExit}
          className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#17181d]/90 px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.1] cursor-pointer"
        >
          Back to Hex
        </button>
      </div>
      <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-[#17181d]/80 px-2 py-1 text-[10px] text-zinc-400">
        Drag to orbit · Scroll to zoom
      </div>
    </div>
  );
};

export const HexDiffCanvas: React.FC<HexDiffCanvasProps> = ({
  bin,
  compareBin,
  binName,
  compareName,
  definition,
  candidates,
  jumpAddress,
  selectedRange,
  onSelectRange,
  onAddCandidateToXdf,
  onSelectXdfItem,
  onApplyPatch,
  onFindTwins,
  bookmarks: externalBookmarks,
  onAddBookmark,
  onClearBookmarks,
  onOpenXdfModalForSelection,
  onOpenXdfModalForCandidate,
  onIgnoreCandidate,
  dismissedCandidateKeys,
  onRestoreDismissed,
  onRescanCandidates,
  heatmapPalette = 'thermal',
  onPatchBytes,
}) => {
  const applyPatch = onPatchBytes ?? onApplyPatch;

  // Format, display, view mode & split state
  const [wordFormat, setWordFormat] = useState<HexWordFormat>('u16le');
  const [colCount, setColCount] = useState<number>(8);
  const [byteShift, setByteShift] = useState<number>(0);
  const [numberBase, setNumberBase] = useState<NumberBase>('hex');
  const [isSigned, setIsSigned] = useState<boolean>(false);
  const [compareShift, setCompareShift] = useState<number>(0);
  const [diffsOnly, setDiffsOnly] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<ViewMode>('text');
  const [splitMode, setSplitMode] = useState<boolean>(true);
  const [rightPaneMode, setRightPaneMode] = useState<RightPaneMode>('val');
  const [showBars, setShowBars] = useState<boolean>(false);

  // Navigation, search, bookmarks
  const [gotoInput, setGotoInput] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [activeSearchIdx, setActiveSearchIdx] = useState<number>(0);
  const [localBookmarks, setLocalBookmarks] = useState<HexBookmark[]>([]);
  const [bookmarksOpen, setBookmarksOpen] = useState<boolean>(false);
  const [bookmarkLabelInput, setBookmarkLabelInput] = useState<string>('');

  // Potential Maps cluster state
  const [showCandidates, setShowCandidates] = useState<boolean>(true);
  const [minConfidence, setMinConfidence] = useState<number>(0.55);
  const [patternFilter, setPatternFilter] = useState<CandidatePatternFilter>('all');
  const [autoColsOnJump, setAutoColsOnJump] = useState<boolean>(true);
  const [activeCandIdx, setActiveCandIdx] = useState<number>(-1);
  const [localDismissed, setLocalDismissed] = useState<Set<string>>(() => new Set());
  const [rescannedCandidates, setRescannedCandidates] = useState<MapCandidate[] | null>(null);

  // Virtual scroll, hover, pin, context menu, right column resize
  const [topRow, setTopRow] = useState<number>(0);
  const [viewportHeight, setViewportHeight] = useState<number>(572);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [pinnedHud, setPinnedHud] = useState<PinnedHudState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [activeDiffIdx, setActiveDiffIdx] = useState<number>(-1);
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const [rightColWidth, setRightColWidth] = useState<number>(196);
  const resizingRightColRef = useRef<{ startX: number; startW: number } | null>(null);

  // 3D override range/cols (when launched from context menu)
  const [preview3DTarget, setPreview3DTarget] = useState<{
    start: number;
    rows: number;
    cols: number;
  } | null>(null);

  // Selection Inspector popovers: Inline Edit & Inline Twins
  const [editPopoverOpen, setEditPopoverOpen] = useState<boolean>(false);
  const [editValueInput, setEditValueInput] = useState<string>('');
  const [customFillHexInput, setCustomFillHexInput] = useState<string>('00');
  const [twinsPopoverOpen, setTwinsPopoverOpen] = useState<boolean>(false);
  const [twinMatches, setTwinMatches] = useState<TwinMatch[]>([]);

  // Code XREFs & Disassembler slide-over drawer state
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('xrefs');
  const [drawerAddress, setDrawerAddress] = useState<number>(0);
  const [disasmArch, setDisasmArch] = useState<CpuArch>('auto');

  const dragAnchorRef = useRef<number | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const wordBytes = wordFormatBytes(wordFormat);
  const rowBytes = colCount * wordBytes;

  // Reset local rescanned candidates when binary changes
  useEffect(() => {
    setRescannedCandidates(null);
  }, [bin]);

  const effectiveBookmarks = externalBookmarks ?? localBookmarks;

  const effectiveDismissed = useMemo(() => {
    const set = new Set<string>(localDismissed);
    if (dismissedCandidateKeys) {
      if (dismissedCandidateKeys instanceof Set) {
        dismissedCandidateKeys.forEach((k) => set.add(k));
      } else {
        for (const k of dismissedCandidateKeys) set.add(k);
      }
    }
    return set;
  }, [localDismissed, dismissedCandidateKeys]);

  const sourceCandidates = rescannedCandidates ?? candidates;

  // Filtered candidates based on Confidence, Pattern Type, and Dismissed set
  const filteredCandidates = useMemo(() => {
    return sourceCandidates.filter((c) => {
      if (effectiveDismissed.has(c.id) || effectiveDismissed.has(candidateKey(c))) return false;
      if (c.confidence < minConfidence) return false;
      if (patternFilter === '2d' && c.rows <= 1) return false;
      if (patternFilter === '1d' && c.rows > 1) return false;
      if (patternFilter === 'bosch' && c.evidence !== 'Header Proof') return false;
      if (patternFilter === 'ptr' && c.evidence !== 'Axis Proof') return false;
      return true;
    });
  }, [sourceCandidates, effectiveDismissed, minConfidence, patternFilter]);

  const dismissedCount = effectiveDismissed.size;

  // Pattern search matches
  const searchMatches = useMemo(() => {
    const pattern = parseSearchPattern(searchQuery);
    if (pattern.length === 0 || bin.length === 0) return { len: 0, offsets: [] as number[] };
    const offsets: number[] = [];
    const maxMatches = 2000;
    const limit = bin.length - pattern.length;
    for (let i = 0; i <= limit; i++) {
      let ok = true;
      for (let j = 0; j < pattern.length; j++) {
        const p = pattern[j];
        if (p !== null && bin[i + j] !== p) {
          ok = false;
          break;
        }
      }
      if (ok) {
        offsets.push(i);
        if (offsets.length >= maxMatches) break;
      }
    }
    return { len: pattern.length, offsets };
  }, [bin, searchQuery]);

  const searchMatchSet = useMemo(() => {
    if (searchMatches.offsets.length === 0) return null;
    const set = new Set<number>();
    for (const off of searchMatches.offsets) {
      for (let j = 0; j < searchMatches.len; j++) set.add(off + j);
    }
    return set;
  }, [searchMatches]);

  // Compute diff byte count, diff cluster start offsets, and diff row indices (respecting compareShift)
  const diffStats = useMemo(() => {
    if (!compareBin) {
      return { totalDiffBytes: 0, clusters: [] as number[], diffRows: [] as number[] };
    }
    const len = bin.length;
    const cmpLen = compareBin.length;
    let totalDiffBytes = 0;
    const clusters: number[] = [];
    const diffRows: number[] = [];
    let lastDiffRow = -1;
    let inCluster = false;
    let gap = 0;

    for (let i = 0; i < len; i++) {
      const ci = i + compareShift;
      if (ci >= 0 && ci < cmpLen && bin[i] !== compareBin[ci]) {
        totalDiffBytes++;
        const row = Math.floor(i / rowBytes);
        if (row !== lastDiffRow) {
          diffRows.push(row);
          lastDiffRow = row;
        }
        if (!inCluster) {
          clusters.push(i);
          inCluster = true;
        }
        gap = 0;
      } else if (inCluster) {
        gap++;
        if (gap >= 16) inCluster = false;
      }
    }
    return { totalDiffBytes, clusters, diffRows };
  }, [bin, compareBin, compareShift, rowBytes]);

  // Index filtered MapCandidates for fast lookup
  const candidateSpans = useMemo<SpanEntry[]>(() => {
    if (!showCandidates) return [];
    const out: SpanEntry[] = [];
    for (const c of filteredCandidates) {
      const eb = Math.max(1, Math.floor(c.bits / 8));
      const dataEnd = c.address + c.rows * c.cols * eb;
      out.push({ start: c.address, end: dataEnd, candidate: c, role: 'data' });

      const axisEb = Math.max(1, Math.floor((c.axisBits ?? c.bits) / 8));
      if (c.xAxisAddress != null) {
        out.push({
          start: c.xAxisAddress,
          end: c.xAxisAddress + c.cols * axisEb,
          candidate: c,
          role: 'axis',
        });
      }
      if (c.yAxisAddress != null && c.rows > 1) {
        out.push({
          start: c.yAxisAddress,
          end: c.yAxisAddress + c.rows * axisEb,
          candidate: c,
          role: 'axis',
        });
      }
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }, [filteredCandidates, showCandidates]);

  // Index XDF items for fast row annotation & outline lookup
  const xdfSpans = useMemo<XdfSpan[]>(() => {
    if (!definition) return [];
    const out: XdfSpan[] = definition.items.map((item) => {
      const [start, end] = layoutByteRange(item.data);
      return { start, end, item };
    });
    out.sort((a, b) => a.start - b.start);
    return out;
  }, [definition]);

  const findCandidateAt = useCallback(
    (offset: number): SpanEntry | null => {
      let lo = 0;
      let hi = candidateSpans.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (candidateSpans[mid].start <= offset) lo = mid + 1;
        else hi = mid;
      }
      let best: SpanEntry | null = null;
      for (let i = lo - 1; i >= 0 && i >= lo - 24; i--) {
        const sp = candidateSpans[i];
        if (offset >= sp.start && offset < sp.end) {
          if (!best || (best.role === 'axis' && sp.role === 'data')) {
            best = sp;
          }
        }
      }
      return best;
    },
    [candidateSpans],
  );

  const findXdfAt = useCallback(
    (offset: number): XdfSpan | null => {
      let lo = 0;
      let hi = xdfSpans.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (xdfSpans[mid].start <= offset) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo - 1; i >= 0 && i >= lo - 12; i--) {
        const sp = xdfSpans[i];
        if (offset >= sp.start && offset < sp.end) return sp;
      }
      return null;
    },
    [xdfSpans],
  );

  const findRowAnnotations = useCallback(
    (rowStart: number, rowEnd: number): { xdf: XDFItem | null; cand: MapCandidate | null } => {
      let xdf: XDFItem | null = null;
      let lo = 0;
      let hi = xdfSpans.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (xdfSpans[mid].start < rowEnd) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo - 1; i >= 0 && i >= lo - 12; i--) {
        if (xdfSpans[i].end > rowStart && xdfSpans[i].start < rowEnd) {
          xdf = xdfSpans[i].item;
          break;
        }
      }

      let cand: MapCandidate | null = null;
      lo = 0;
      hi = candidateSpans.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (candidateSpans[mid].start < rowEnd) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo - 1; i >= 0 && i >= lo - 16; i--) {
        const sp = candidateSpans[i];
        if (sp.end > rowStart && sp.start < rowEnd) {
          cand = sp.candidate;
          if (sp.role === 'data') break;
        }
      }
      return { xdf, cand };
    },
    [xdfSpans, candidateSpans],
  );

  // Code XREFs & Disassembly computed only when drawer is open
  const xrefs = useMemo<CodeXRef[]>(() => {
    if (!drawerOpen || drawerTab !== 'xrefs') return [];
    return resolveCodeXRefs(bin, drawerAddress);
  }, [drawerOpen, drawerTab, bin, drawerAddress]);

  const disasmLines = useMemo<DisasmLine[]>(() => {
    if (!drawerOpen || drawerTab !== 'disasm') return [];
    return resolveDisasmSlice(bin, drawerAddress, disasmArch, 40);
  }, [drawerOpen, drawerTab, bin, drawerAddress, disasmArch]);

  const totalRawRows = Math.max(1, Math.ceil(bin.length / rowBytes));
  const totalDisplayRows = diffsOnly && compareBin ? diffStats.diffRows.length : totalRawRows;

  // Virtual scrollbar scaling
  const rawContentHeight = totalDisplayRows * ROW_HEIGHT;
  const virtualHeight = Math.min(rawContentHeight, MAX_VIRTUAL_PX);
  const scrollScale =
    rawContentHeight > viewportHeight && virtualHeight > viewportHeight
      ? (rawContentHeight - viewportHeight) / (virtualHeight - viewportHeight)
      : 1;

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const update = () => setViewportHeight(el.clientHeight || 572);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewMode]);

  const scrollToDisplayRow = useCallback(
    (displayRow: number) => {
      const clamped = Math.max(0, Math.min(totalDisplayRows - 1, displayRow));
      setTopRow(clamped);
      const el = scrollContainerRef.current;
      if (el) {
        const targetScrollTop = (clamped * ROW_HEIGHT) / Math.max(1, scrollScale);
        el.scrollTop = targetScrollTop;
      }
    },
    [totalDisplayRows, scrollScale],
  );

  const scrollToAddress = useCallback(
    (address: number) => {
      const clampedAddr = Math.max(0, Math.min(Math.max(0, bin.length - 1), address));
      const rawRow = Math.floor(clampedAddr / rowBytes);
      if (diffsOnly && compareBin) {
        let lo = 0;
        let hi = diffStats.diffRows.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (diffStats.diffRows[mid] < rawRow) lo = mid + 1;
          else hi = mid;
        }
        scrollToDisplayRow(Math.max(0, lo - 3));
      } else {
        scrollToDisplayRow(Math.max(0, rawRow - 3));
      }
    },
    [bin.length, rowBytes, diffsOnly, compareBin, diffStats.diffRows, scrollToDisplayRow],
  );

  useEffect(() => {
    if (jumpAddress !== null && Number.isFinite(jumpAddress)) {
      scrollToAddress(jumpAddress);
    }
  }, [jumpAddress, scrollToAddress]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const st = e.currentTarget.scrollTop;
    const nextTop = Math.floor((st * scrollScale) / ROW_HEIGHT);
    const maxTop = Math.max(0, totalDisplayRows - 1);
    setTopRow(Math.max(0, Math.min(maxTop, nextTop)));
  };

  // Global mouseup & right-column drag resize
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (resizingRightColRef.current) {
        const dx = resizingRightColRef.current.startX - e.clientX;
        const nextW = Math.max(140, Math.min(340, resizingRightColRef.current.startW + dx));
        setRightColWidth(nextW);
      }
    };
    const onUp = () => {
      dragAnchorRef.current = null;
      resizingRightColRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const showToast = useCallback((msg: string) => {
    setCopyToast(msg);
    window.setTimeout(() => setCopyToast((prev) => (prev === msg ? null : prev)), 1800);
  }, []);

  const openDrawerAt = useCallback(
    (addr: number, tab: DrawerTab) => {
      setDrawerAddress(Math.max(0, Math.min(Math.max(0, bin.length - 1), addr)));
      setDrawerTab(tab);
      setDrawerOpen(true);
    },
    [bin.length],
  );

  // Bookmark handlers
  const handleAddBookmarkAt = useCallback(
    (address: number, label?: string) => {
      const cleanLabel = label?.trim() || `0x${formatHexAddr(address)}`;
      if (onAddBookmark) {
        onAddBookmark(address, cleanLabel);
      } else {
        setLocalBookmarks((prev) => [
          ...prev,
          { id: `bm_${Date.now()}_${address}`, address, label: cleanLabel },
        ]);
      }
      showToast(`Bookmarked 0x${formatHexAddr(address)}`);
    },
    [onAddBookmark, showToast],
  );

  const handleClearAllBookmarks = useCallback(() => {
    if (onClearBookmarks) onClearBookmarks();
    else setLocalBookmarks([]);
    showToast('Cleared bookmarks');
  }, [onClearBookmarks, showToast]);

  // Ignore & Restore candidate handlers
  const handleIgnoreCandidate = useCallback(
    (c: MapCandidate) => {
      if (onIgnoreCandidate) {
        onIgnoreCandidate(c);
      } else {
        setLocalDismissed((prev) => {
          const next = new Set(prev);
          next.add(c.id);
          next.add(candidateKey(c));
          return next;
        });
      }
      showToast(`Ignored ${c.rows}×${c.cols} @ 0x${formatHexAddr(c.address)}`);
    },
    [onIgnoreCandidate, showToast],
  );

  const handleRestoreDismissed = useCallback(() => {
    if (onRestoreDismissed) onRestoreDismissed();
    setLocalDismissed(new Set());
    showToast('Restored dismissed candidates');
  }, [onRestoreDismissed, showToast]);

  const handleRescan = useCallback(() => {
    if (onRescanCandidates) {
      onRescanCandidates();
      showToast('Rescanning potential maps…');
      return;
    }
    try {
      const found = core.scanMaps(bin);
      setRescannedCandidates(found);
      showToast(`Found ${found.length} map candidates`);
    } catch {
      showToast('Rescan complete');
    }
  }, [bin, onRescanCandidates, showToast]);

  // Prev / Next Diff navigation
  const jumpDiff = (dir: -1 | 1) => {
    const { clusters } = diffStats;
    if (clusters.length === 0) return;
    const nextIdx =
      activeDiffIdx < 0
        ? dir > 0
          ? 0
          : clusters.length - 1
        : (activeDiffIdx + dir + clusters.length) % clusters.length;
    setActiveDiffIdx(nextIdx);
    const addr = clusters[nextIdx];
    scrollToAddress(addr);
    onSelectRange([addr, Math.min(bin.length, addr + wordBytes)]);
  };

  // Prev / Next Potential Map Candidate jump
  const jumpCandidate = (dir: -1 | 1) => {
    if (filteredCandidates.length === 0) return;
    const nextIdx =
      activeCandIdx < 0
        ? dir > 0
          ? 0
          : filteredCandidates.length - 1
        : (activeCandIdx + dir + filteredCandidates.length) % filteredCandidates.length;
    setActiveCandIdx(nextIdx);
    const c = filteredCandidates[nextIdx];
    if (autoColsOnJump) {
      const nextCols = Math.max(1, Math.min(32, c.cols));
      const nextWb = c.bits === 8 ? 1 : c.bits === 32 ? 4 : 2;
      if (c.bits === 8) setWordFormat('u8');
      else if (c.bits === 16) setWordFormat(c.lsbFirst ? 'u16le' : 'u16be');
      else if (c.bits === 32) setWordFormat(c.isFloat ? (c.lsbFirst ? 'f32le' : 'f32be') : c.lsbFirst ? 'u32le' : 'u32be');
      setColCount(nextCols);
      const nextRowBytes = nextCols * nextWb;
      setByteShift(c.address % Math.max(1, nextRowBytes));
    }
    const eb = Math.max(1, Math.floor(c.bits / 8));
    scrollToAddress(c.address);
    onSelectRange([c.address, Math.min(bin.length, c.address + c.rows * c.cols * eb)]);
  };

  // Pattern search step
  const jumpSearchMatch = (dir: -1 | 1) => {
    const list = searchMatches.offsets;
    if (list.length === 0) return;
    const nextIdx = (activeSearchIdx + dir + list.length) % list.length;
    setActiveSearchIdx(nextIdx);
    const off = list[nextIdx];
    scrollToAddress(off);
    onSelectRange([off, Math.min(bin.length, off + Math.max(1, searchMatches.len))]);
  };

  const handleGotoSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = gotoInput.trim().replace(/^0x/i, '');
    if (!cleaned) return;
    const parsed = parseInt(cleaned, 16);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed < bin.length) {
      scrollToAddress(parsed);
      onSelectRange([parsed, Math.min(bin.length, parsed + wordBytes)]);
    }
  };

  // Selection actions
  const handleCopyHex = useCallback(() => {
    if (!selectedRange || selectedRange[1] <= selectedRange[0]) return;
    const slice = bin.subarray(selectedRange[0], selectedRange[1]);
    const hex = Array.from(slice, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    void navigator.clipboard?.writeText(hex);
    showToast(`Copied ${slice.length} B`);
  }, [bin, selectedRange, showToast]);

  const handleCopyFromCompare = useCallback(() => {
    if (!compareBin || !selectedRange || selectedRange[1] <= selectedRange[0]) return;
    const [start, end] = selectedRange;
    const len = Math.min(end, bin.length) - start;
    if (len <= 0) return;
    const next = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      const ci = start + i + compareShift;
      next[i] = ci >= 0 && ci < compareBin.length ? compareBin[ci] : bin[start + i];
    }
    applyPatch(start, next, `Copy ${next.length} B from Compare @ 0x${formatHexAddr(start)}`);
  }, [bin, compareBin, compareShift, selectedRange, applyPatch]);

  const handleCopyRowFromCompare = useCallback(
    (rowStart: number) => {
      if (!compareBin) return;
      const start = Math.max(0, rowStart + byteShift);
      const len = Math.min(rowBytes, bin.length - start);
      if (len <= 0) return;
      const next = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        const ci = start + i + compareShift;
        next[i] = ci >= 0 && ci < compareBin.length ? compareBin[ci] : bin[start + i];
      }
      applyPatch(start, next, `Copy row (${len} B) from Compare @ 0x${formatHexAddr(start)}`);
      showToast(`Copied row 0x${formatHexAddr(start)} ← Compare`);
    },
    [bin, compareBin, byteShift, rowBytes, compareShift, applyPatch, showToast],
  );

  const handleFillSelection = useCallback(
    (byteValue: number) => {
      if (!selectedRange || selectedRange[1] <= selectedRange[0]) return;
      const [start, end] = selectedRange;
      const clampedEnd = Math.min(end, bin.length);
      if (clampedEnd <= start) return;
      const next = new Uint8Array(clampedEnd - start);
      next.fill(byteValue & 0xff);
      applyPatch(
        start,
        next,
        `Fill 0x${byteValue.toString(16).toUpperCase().padStart(2, '0')} (${next.length} B @ 0x${formatHexAddr(start)})`,
      );
    },
    [bin.length, selectedRange, applyPatch],
  );

  // Step selected bytes/words by ±1
  const handleStepSelection = useCallback(
    (delta: -1 | 1) => {
      if (!selectedRange || selectedRange[1] <= selectedRange[0]) return;
      const [start, end] = selectedRange;
      const clampedEnd = Math.min(end, bin.length);
      const len = clampedEnd - start;
      if (len <= 0) return;
      const next = new Uint8Array(bin.subarray(start, clampedEnd));
      const count = Math.max(1, Math.floor(len / wordBytes));
      for (let i = 0; i < count; i++) {
        const localOff = i * wordBytes;
        if (localOff + wordBytes > next.length) break;
        const cur = readWordNumeric(next, localOff, wordFormat, isSigned);
        if (cur !== null && Number.isFinite(cur)) {
          writeWordNumeric(next, localOff, cur + delta, wordFormat, isSigned);
        }
      }
      applyPatch(
        start,
        next,
        `Step ${delta > 0 ? '+1' : '-1'} (${count} elem @ 0x${formatHexAddr(start)})`,
      );
    },
    [bin, selectedRange, wordBytes, wordFormat, isSigned, applyPatch],
  );

  const handleApplyInlineEdit = useCallback(() => {
    if (!selectedRange || selectedRange[1] <= selectedRange[0]) return;
    const rawStr = editValueInput.trim();
    if (!rawStr) return;
    let parsed: number;
    if (wordFormat === 'f32le' || wordFormat === 'f32be') {
      parsed = parseFloat(rawStr);
    } else if (numberBase === 'hex' || /^0x/i.test(rawStr)) {
      parsed = parseInt(rawStr.replace(/^0x/i, ''), 16);
    } else if (numberBase === 'bin') {
      parsed = parseInt(rawStr.replace(/^0b/i, ''), 2);
    } else {
      parsed = parseInt(rawStr, 10);
    }
    if (!Number.isFinite(parsed)) return;

    const [start, end] = selectedRange;
    const clampedEnd = Math.min(end, bin.length);
    const len = clampedEnd - start;
    if (len < wordBytes) return;
    const next = new Uint8Array(bin.subarray(start, clampedEnd));
    const count = Math.floor(len / wordBytes);
    for (let i = 0; i < count; i++) {
      writeWordNumeric(next, i * wordBytes, parsed, wordFormat, isSigned);
    }
    applyPatch(start, next, `Set ${count} elem = ${parsed} @ 0x${formatHexAddr(start)}`);
    setEditPopoverOpen(false);
    showToast(`Wrote ${parsed} to ${count} elem`);
  }, [
    bin,
    selectedRange,
    editValueInput,
    wordFormat,
    numberBase,
    wordBytes,
    isSigned,
    applyPatch,
    showToast,
  ]);

  const handleSelectWholeMap = useCallback(
    (c: MapCandidate) => {
      const eb = Math.max(1, Math.floor(c.bits / 8));
      onSelectRange([c.address, Math.min(bin.length, c.address + c.rows * c.cols * eb)]);
    },
    [bin.length, onSelectRange],
  );

  const handleSelectMapWithAxes = useCallback(
    (c: MapCandidate) => {
      const eb = Math.max(1, Math.floor(c.bits / 8));
      const axisEb = Math.max(1, Math.floor((c.axisBits ?? c.bits) / 8));
      let minAddr = c.address;
      let maxAddr = c.address + c.rows * c.cols * eb;
      if (c.xAxisAddress != null) {
        minAddr = Math.min(minAddr, c.xAxisAddress);
        maxAddr = Math.max(maxAddr, c.xAxisAddress + c.cols * axisEb);
      }
      if (c.yAxisAddress != null && c.rows > 1) {
        minAddr = Math.min(minAddr, c.yAxisAddress);
        maxAddr = Math.max(maxAddr, c.yAxisAddress + c.rows * axisEb);
      }
      onSelectRange([Math.max(0, minAddr), Math.min(bin.length, maxAddr)]);
    },
    [bin.length, onSelectRange],
  );

  const handleMapFromSelection = useCallback(() => {
    if (!selectedRange || selectedRange[1] <= selectedRange[0]) return;
    if (onOpenXdfModalForSelection) {
      onOpenXdfModalForSelection(selectedRange, colCount, wordFormat);
      return;
    }
    const [start, end] = selectedRange;
    const bytes = end - start;
    const bits = wordBytes * 8;
    const elems = Math.max(1, Math.floor(bytes / wordBytes));
    const cols = elems >= colCount ? colCount : elems;
    const rows = Math.max(1, Math.floor(elems / cols));
    const lsbFirst = wordFormat === 'u8' || wordFormat.endsWith('le');
    const isFloat = wordFormat === 'f32le' || wordFormat === 'f32be';
    const synthetic: MapCandidate = {
      id: `sel_${start.toString(16)}_${rows}x${cols}`,
      address: start,
      rows,
      cols,
      bits,
      signed: isSigned,
      isFloat,
      lsbFirst,
      axisBits: bits,
      confidence: 1,
      evidence: 'Data Pattern',
      shortBadge: rows > 1 ? `Selection ${rows}×${cols}` : `Selection 1D (${cols})`,
      reason: 'Manual hex selection',
      rpmAxisDetected: false,
      layout: {
        address: start,
        bits,
        signed: isSigned,
        lsbFirst,
        columnMajor: false,
        isFloat,
        rows,
        cols,
      },
    };
    onAddCandidateToXdf(synthetic, true);
  }, [
    selectedRange,
    onOpenXdfModalForSelection,
    wordBytes,
    wordFormat,
    colCount,
    isSigned,
    onAddCandidateToXdf,
  ]);

  const handleOpenTwins = useCallback(
    (range: [number, number] | null) => {
      if (!range || range[1] <= range[0]) return;
      onFindTwins(range);
      const found = scanTwinsInBin(bin, range, wordBytes);
      setTwinMatches(found);
      setTwinsPopoverOpen(true);
    },
    [bin, wordBytes, onFindTwins],
  );

  // Visible slice calculation
  const visibleRowCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const startDisplayIdx = Math.max(0, topRow - OVERSCAN);
  const endDisplayIdx = Math.min(totalDisplayRows, startDisplayIdx + visibleRowCount);

  const visibleRawRows = useMemo(() => {
    const rows: Array<{ displayIdx: number; rawRow: number; address: number }> = [];
    for (let d = startDisplayIdx; d < endDisplayIdx; d++) {
      const rawRow = diffsOnly && compareBin ? diffStats.diffRows[d] : d;
      if (rawRow === undefined) continue;
      rows.push({ displayIdx: d, rawRow, address: rawRow * rowBytes });
    }
    return rows;
  }, [startDisplayIdx, endDisplayIdx, diffsOnly, compareBin, diffStats.diffRows, rowBytes]);

  // Current top address for Waveform2D / 3D Surface sync
  const topRawRow = diffsOnly && compareBin ? (diffStats.diffRows[topRow] ?? 0) : topRow;
  const windowStartAddress = Math.min(
    Math.max(0, bin.length - rowBytes),
    topRawRow * rowBytes,
  );

  // Hovered / selected byte readout for inspector footer
  const hoveredInfo = useMemo(() => {
    const addr = hover?.address ?? selectedRange?.[0] ?? null;
    if (addr === null || addr < 0 || addr >= bin.length) return null;
    const u8 = bin[addr];
    const u16le = addr + 1 < bin.length ? bin[addr] | (bin[addr + 1] << 8) : null;
    const u16be = addr + 1 < bin.length ? (bin[addr] << 8) | bin[addr + 1] : null;
    const binStr = u8.toString(2).padStart(8, '0');
    const xdfSpan = findXdfAt(addr);
    return { addr, u8, u16le, u16be, binStr, xdfItem: xdfSpan?.item ?? null };
  }, [hover, selectedRange, bin, findXdfAt]);

  // Keyboard shortcuts: M / W cols, [ / ] byte shift, Alt+P toggle potential maps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.altKey && e.code === 'KeyP') {
        e.preventDefault();
        setShowCandidates((v) => !v);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'm') {
        e.preventDefault();
        setColCount((c) => Math.max(1, c - 1));
      } else if (k === 'w') {
        e.preventDefault();
        setColCount((c) => Math.min(32, c + 1));
      } else if (e.key === '[') {
        e.preventDefault();
        setByteShift((s) => (s - 1 + rowBytes) % Math.max(1, rowBytes));
      } else if (e.key === ']') {
        e.preventDefault();
        setByteShift((s) => (s + 1) % Math.max(1, rowBytes));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rowBytes]);

  const handleAutoSyncCompare = useCallback(() => {
    if (!compareBin) return;
    const res = core.autoAlignCompareOffset(bin, compareBin, windowStartAddress, 32768);
    setCompareShift(res.offset);
    showToast(
      `Auto-Sync: ${res.offset >= 0 ? '+' : ''}${res.offset} B (${Math.round(res.confidence * 100)}%)`,
    );
  }, [bin, compareBin, windowStartAddress, showToast]);

  const hasSelection = selectedRange !== null && selectedRange[1] > selectedRange[0];

  const cellWidthCls = useMemo(() => {
    if (numberBase === 'bin') return 'w-[62px]';
    if (wordFormat === 'u8') return numberBase === 'dec' ? 'w-8' : 'w-6';
    if (wordFormat === 'u16le' || wordFormat === 'u16be') {
      return numberBase === 'dec' ? 'w-[48px]' : 'w-[40px]';
    }
    return numberBase === 'dec' ? 'w-[68px]' : 'w-[70px]';
  }, [wordFormat, numberBase]);

  const cellGapCls = colCount <= 8 ? 'gap-1.5' : 'gap-1';

  const gridTemplateColumns = splitMode
    ? `72px 1fr 28px 1fr ${rightColWidth}px`
    : `72px 1fr ${rightColWidth}px`;

  // Compute 3D preview params
  const surface3DParams = useMemo(() => {
    if (preview3DTarget) return preview3DTarget;
    if (selectedRange && selectedRange[1] > selectedRange[0]) {
      const elems = Math.max(4, Math.floor((selectedRange[1] - selectedRange[0]) / wordBytes));
      const c = Math.max(2, Math.min(32, colCount));
      const r = Math.max(2, Math.min(32, Math.ceil(elems / c)));
      return { start: selectedRange[0], rows: r, cols: c };
    }
    return { start: windowStartAddress + byteShift, rows: 16, cols: Math.max(4, colCount) };
  }, [preview3DTarget, selectedRange, wordBytes, colCount, windowStartAddress, byteShift]);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[#0c0d10] text-zinc-100 select-none">
      {/* Top Toolbar Row 1: View Mode, Format, Base, Columns, Shift, Split/Bars, Sync, Go To */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-1.5 border-b border-white/[0.065] bg-[#17181d] px-3 py-1.5">
        {/* Left cluster */}
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Text / 2D / 3D Segmented View Switcher */}
          <div className="inline-flex rounded-lg border border-white/[0.065] bg-[#101115] p-0.5 text-[11px] font-medium">
            {(
              [
                ['text', 'Text'],
                ['2d', '2D'],
                ['3d', '3D'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  if (mode !== '3d') setPreview3DTarget(null);
                  setViewMode(mode);
                }}
                className={`rounded-[6px] px-2 py-0.5 transition-colors cursor-pointer ${
                  viewMode === mode
                    ? 'bg-[#0a84ff] text-white shadow-[0_1px_8px_rgba(10,132,255,0.4)]'
                    : 'text-zinc-400 hover:text-zinc-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Data Format Selector (7 formats) */}
          <select
            value={wordFormat}
            onChange={(e) => setWordFormat(e.target.value as HexWordFormat)}
            title="Word Data Format"
            className="rounded-lg border border-white/[0.065] bg-[#101115] px-2 py-1 font-mono text-[11px] text-zinc-100 outline-none focus:border-[#0a84ff] cursor-pointer"
          >
            {WORD_FORMAT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value} className="bg-[#17181d] text-zinc-100">
                {opt.label}
              </option>
            ))}
          </select>

          {/* Hex / Dec / Bin + Signed (±) */}
          <div className="inline-flex rounded-lg border border-white/[0.065] bg-[#101115] p-0.5 font-mono text-[11px]">
            {(
              [
                ['hex', 'Hex'],
                ['dec', 'Dec'],
                ['bin', 'Bin'],
              ] as const
            ).map(([b, label]) => (
              <button
                key={b}
                type="button"
                onClick={() => setNumberBase(b)}
                className={`rounded-[6px] px-1.5 py-0.5 transition-colors cursor-pointer ${
                  numberBase === b
                    ? 'bg-[#0a84ff]/30 text-sky-200'
                    : 'text-zinc-400 hover:text-zinc-100'
                }`}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setIsSigned((s) => !s)}
              title="Toggle Signed (±) / Unsigned"
              className={`ml-0.5 rounded-[6px] px-1.5 py-0.5 transition-colors cursor-pointer ${
                isSigned ? 'bg-[#0a84ff]/25 text-sky-200' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              ±
            </button>
          </div>

          {/* Free Column Count (1–32, M / W keys) */}
          <div
            className="inline-flex items-center rounded-lg border border-white/[0.065] bg-[#101115] p-0.5 font-mono text-[11px]"
            title="Columns per row (1–32 · shortcuts M / W)"
          >
            <button
              type="button"
              onClick={() => setColCount((c) => Math.max(1, c - 1))}
              className="rounded px-1.5 py-0.5 text-zinc-400 hover:bg-white/[0.08] hover:text-white cursor-pointer"
            >
              −
            </button>
            <input
              type="number"
              min={1}
              max={32}
              value={colCount}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (Number.isFinite(v)) setColCount(Math.max(1, Math.min(32, v)));
              }}
              className="w-7 bg-transparent text-center text-zinc-100 outline-none [appearance:textfield]"
            />
            <span className="pr-1 text-[10px] text-zinc-500">col</span>
            <button
              type="button"
              onClick={() => setColCount((c) => Math.min(32, c + 1))}
              className="rounded px-1.5 py-0.5 text-zinc-400 hover:bg-white/[0.08] hover:text-white cursor-pointer"
            >
              +
            </button>
          </div>

          {/* Byte Shift ([ / ]) */}
          <div
            className="inline-flex items-center rounded-lg border border-white/[0.065] bg-[#101115] p-0.5 font-mono text-[11px]"
            title="Shift row start by bytes (shortcuts [ / ] · click value to reset)"
          >
            <button
              type="button"
              onClick={() => setByteShift((s) => (s - 1 + rowBytes) % Math.max(1, rowBytes))}
              className="rounded px-1 py-0.5 text-zinc-400 hover:bg-white/[0.08] hover:text-white cursor-pointer"
            >
              ◀
            </button>
            <button
              type="button"
              onClick={() => setByteShift(0)}
              className={`px-1 py-0.5 tabular-nums cursor-pointer ${
                byteShift !== 0 ? 'font-semibold text-amber-300' : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="Click to reset shift to +0"
            >
              +{byteShift}B
            </button>
            <button
              type="button"
              onClick={() => setByteShift((s) => (s + 1) % Math.max(1, rowBytes))}
              className="rounded px-1 py-0.5 text-zinc-400 hover:bg-white/[0.08] hover:text-white cursor-pointer"
            >
              ▶
            </button>
          </div>

          {/* Split / Single Toggle + Right-Pane Display Mode (Val / Δ / Δ%) + Bars */}
          <div className="inline-flex items-center rounded-lg border border-white/[0.065] bg-[#101115] p-0.5 text-[10.5px]">
            <button
              type="button"
              onClick={() => setSplitMode((v) => !v)}
              title="Toggle Split / Single Pane"
              className={`inline-flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 cursor-pointer ${
                splitMode ? 'bg-white/[0.1] text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {splitMode ? <Columns2 className="h-3 w-3" /> : <Square className="h-3 w-3" />}
              {splitMode ? 'Split' : 'Single'}
            </button>
            {splitMode && compareBin ? (
              <div className="ml-1 inline-flex border-l border-white/[0.08] pl-1 font-mono text-[10px]">
                {(
                  [
                    ['val', 'Val'],
                    ['delta', 'Δ'],
                    ['pct', 'Δ%'],
                  ] as const
                ).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setRightPaneMode(m)}
                    className={`rounded px-1.5 py-0.5 cursor-pointer ${
                      rightPaneMode === m
                        ? 'bg-[#0a84ff]/30 text-sky-200'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => setShowBars((v) => !v)}
            title="Toggle inline cell value spark-bars"
            className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10.5px] font-medium transition-colors cursor-pointer ${
              showBars
                ? 'border-[#0a84ff]/50 bg-[#0a84ff]/20 text-sky-200'
                : 'border-white/[0.065] bg-[#101115] text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <BarChart2 className="h-3 w-3" />
            Bars
          </button>

          {/* Auto-Sync + Shift Pill + Sync=0 Reset */}
          {compareBin && (
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={handleAutoSyncCompare}
                title="Auto-align comparison BIN offset (±32 KB window)"
                className="rounded-lg border border-white/[0.065] bg-[#101115] px-2 py-1 font-mono text-[10.5px] text-zinc-300 hover:bg-white/[0.08] hover:text-white cursor-pointer"
              >
                Sync
              </button>
              {compareShift !== 0 ? (
                <>
                  <span className="rounded-md border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-amber-300 tabular-nums">
                    {compareShift > 0 ? `+${compareShift}` : compareShift} B
                  </span>
                  <button
                    type="button"
                    onClick={() => setCompareShift(0)}
                    title="Reset compare offset to 0"
                    className="rounded-md border border-white/[0.08] bg-[#101115] px-1.5 py-0.5 font-mono text-[10px] text-zinc-300 hover:bg-white/[0.1] hover:text-white cursor-pointer"
                  >
                    Sync=0
                  </button>
                </>
              ) : null}
            </div>
          )}
        </div>

        {/* Right cluster: Diffs Only, Diff Nav, Bookmarks, Code Drawer, Go To */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={!compareBin}
            onClick={() => {
              setDiffsOnly((v) => !v);
              scrollToDisplayRow(0);
            }}
            className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors ${
              !compareBin
                ? 'cursor-not-allowed border-white/[0.04] bg-white/[0.02] text-zinc-600'
                : diffsOnly
                  ? 'border-[#0a84ff]/50 bg-[#0a84ff]/20 text-sky-200 cursor-pointer'
                  : 'border-white/[0.065] bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08] cursor-pointer'
            }`}
          >
            <Filter className="h-3 w-3" />
            Diffs Only
          </button>

          {compareBin ? (
            <div className="inline-flex items-center gap-0.5 rounded-lg border border-white/[0.065] bg-[#101115] px-1 py-0.5">
              <button
                type="button"
                onClick={() => jumpDiff(-1)}
                disabled={diffStats.clusters.length === 0}
                title="Previous Diff"
                className="rounded p-0.5 text-zinc-300 hover:bg-white/[0.08] disabled:opacity-35 cursor-pointer"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <span className="px-1 font-mono text-[10.5px] font-semibold text-sky-300 tabular-nums">
                {diffStats.totalDiffBytes.toLocaleString()} Δ
              </span>
              <button
                type="button"
                onClick={() => jumpDiff(1)}
                disabled={diffStats.clusters.length === 0}
                title="Next Diff"
                className="rounded p-0.5 text-zinc-300 hover:bg-white/[0.08] disabled:opacity-35 cursor-pointer"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}

          {/* Bookmark Menu Popover */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setBookmarksOpen((v) => !v)}
              title="Bookmarks"
              className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                bookmarksOpen || effectiveBookmarks.length > 0
                  ? 'border-amber-400/35 bg-amber-500/15 text-amber-200'
                  : 'border-white/[0.065] bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08]'
              }`}
            >
              <Bookmark className="h-3 w-3" />
              <span className="font-mono text-[10px] tabular-nums">{effectiveBookmarks.length}</span>
            </button>

            {bookmarksOpen ? (
              <div className="glass-popover absolute right-0 top-full z-40 mt-1.5 w-68 rounded-xl p-2.5 text-zinc-100 shadow-2xl">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-zinc-200">Hex Bookmarks</span>
                  <button
                    type="button"
                    onClick={() => setBookmarksOpen(false)}
                    className="rounded p-0.5 text-zinc-400 hover:bg-white/[0.08] hover:text-white cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="mb-2 flex items-center gap-1">
                  <input
                    type="text"
                    value={bookmarkLabelInput}
                    onChange={(e) => setBookmarkLabelInput(e.target.value)}
                    placeholder="Label (optional)"
                    className="min-w-0 flex-1 rounded-md border border-white/[0.08] bg-[#101115] px-2 py-1 text-[11px] text-zinc-100 placeholder-zinc-500 outline-none focus:border-[#0a84ff]"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const target = selectedRange?.[0] ?? windowStartAddress;
                      handleAddBookmarkAt(target, bookmarkLabelInput);
                      setBookmarkLabelInput('');
                    }}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[#0a84ff]/45 bg-[#0a84ff]/20 px-2 py-1 text-[10.5px] font-medium text-sky-200 hover:bg-[#0a84ff]/35 cursor-pointer"
                  >
                    <BookmarkPlus className="h-3 w-3" />
                    + 0x{formatHexAddr(selectedRange?.[0] ?? windowStartAddress)}
                  </button>
                </div>

                {effectiveBookmarks.length === 0 ? (
                  <div className="py-3 text-center text-[11px] text-zinc-500">No bookmarks yet.</div>
                ) : (
                  <div className="max-h-44 space-y-1 overflow-y-auto">
                    {effectiveBookmarks.map((bm) => (
                      <button
                        key={bm.id}
                        type="button"
                        onClick={() => {
                          scrollToAddress(bm.address);
                          onSelectRange([bm.address, Math.min(bin.length, bm.address + wordBytes)]);
                          setBookmarksOpen(false);
                        }}
                        className="flex w-full items-center justify-between gap-2 rounded-md border border-white/[0.05] bg-[#101115] px-2 py-1 text-left text-[11px] hover:border-[#0a84ff]/40 hover:bg-white/[0.06] cursor-pointer"
                      >
                        <span className="truncate text-zinc-200">{bm.label}</span>
                        <span className="shrink-0 font-mono text-[10px] text-sky-300 tabular-nums">
                          0x{formatHexAddr(bm.address)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {effectiveBookmarks.length > 0 ? (
                  <button
                    type="button"
                    onClick={handleClearAllBookmarks}
                    className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/10 py-1 text-[10.5px] font-medium text-rose-300 hover:bg-rose-500/20 cursor-pointer"
                  >
                    <Trash2 className="h-3 w-3" />
                    Clear All Bookmarks
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => {
              if (drawerOpen) {
                setDrawerOpen(false);
              } else {
                openDrawerAt(selectedRange?.[0] ?? windowStartAddress, drawerTab);
              }
            }}
            title="Toggle Code XREFs & Disassembler"
            className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
              drawerOpen
                ? 'border-[#0a84ff]/60 bg-[#0a84ff]/25 text-sky-100'
                : 'border-white/[0.065] bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08]'
            }`}
          >
            <Cpu className="h-3 w-3" />
            Code
          </button>

          <form onSubmit={handleGotoSubmit} className="relative flex items-center">
            <Navigation className="pointer-events-none absolute left-2 h-3 w-3 text-zinc-500" />
            <input
              type="text"
              value={gotoInput}
              onChange={(e) => setGotoInput(e.target.value)}
              placeholder="Go To 0x…"
              className="w-24 rounded-lg border border-white/[0.065] bg-[#101115] py-1 pr-2 pl-6 font-mono text-[11px] text-zinc-100 placeholder-zinc-500 outline-none transition-colors focus:border-[#0a84ff]"
            />
          </form>
        </div>
      </div>

      {/* Top Toolbar Row 2: Pattern Search Bar + Potential Maps Cluster */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/[0.065] bg-[#14151a] px-3 py-1.5 text-[11px]">
        {/* Pattern Search: Hex / ?? / "Text" */}
        <div className="flex items-center gap-1.5">
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-2 h-3 w-3 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setActiveSearchIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  jumpSearchMatch(e.shiftKey ? -1 : 1);
                }
              }}
              placeholder='Search Hex / ?? / "Text"'
              className="w-48 rounded-lg border border-white/[0.065] bg-[#101115] py-0.5 pr-6 pl-6 font-mono text-[10.5px] text-zinc-100 placeholder-zinc-500 outline-none focus:border-[#0a84ff]"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-1.5 text-zinc-500 hover:text-zinc-200 cursor-pointer"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </div>

          {searchQuery.trim() ? (
            <div className="inline-flex items-center gap-0.5 rounded-md border border-white/[0.065] bg-[#101115] px-1 py-0.5 font-mono text-[10px] tabular-nums">
              <span
                className={
                  searchMatches.offsets.length > 0 ? 'px-1 text-emerald-300' : 'px-1 text-zinc-500'
                }
              >
                {searchMatches.offsets.length > 0
                  ? `${(activeSearchIdx % searchMatches.offsets.length) + 1}/${searchMatches.offsets.length}`
                  : '0'}
              </span>
              <button
                type="button"
                disabled={searchMatches.offsets.length === 0}
                onClick={() => jumpSearchMatch(-1)}
                title="Previous Match"
                className="rounded p-0.5 text-zinc-300 hover:bg-white/[0.08] disabled:opacity-30 cursor-pointer"
              >
                <ChevronLeft className="h-3 w-3" />
              </button>
              <button
                type="button"
                disabled={searchMatches.offsets.length === 0}
                onClick={() => jumpSearchMatch(1)}
                title="Next Match"
                className="rounded p-0.5 text-zinc-300 hover:bg-white/[0.08] disabled:opacity-30 cursor-pointer"
              >
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          ) : null}
        </div>

        {/* Potential Maps Toolbar Cluster */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowCandidates((v) => !v)}
            title="Toggle Potential Maps highlight (⌥P)"
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10.5px] font-medium transition-colors cursor-pointer ${
              showCandidates
                ? 'border-amber-400/45 bg-amber-500/15 text-amber-200'
                : 'border-white/[0.065] bg-[#101115] text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Sparkles className="h-3 w-3" />
            Maps
            <span className="font-mono text-[9.5px] opacity-75">⌥P</span>
          </button>

          {/* Candidate < / > Jump */}
          <div className="inline-flex items-center gap-0.5 rounded-md border border-white/[0.065] bg-[#101115] px-1 py-0.5 font-mono text-[10px] tabular-nums">
            <button
              type="button"
              disabled={filteredCandidates.length === 0}
              onClick={() => jumpCandidate(-1)}
              title="Previous Potential Map"
              className="rounded p-0.5 text-zinc-300 hover:bg-white/[0.08] disabled:opacity-30 cursor-pointer"
            >
              <ChevronLeft className="h-3 w-3" />
            </button>
            <span className="px-1 text-amber-300">
              {filteredCandidates.length > 0
                ? `${activeCandIdx >= 0 ? (activeCandIdx % filteredCandidates.length) + 1 : 0}/${filteredCandidates.length}`
                : '0'}
            </span>
            <button
              type="button"
              disabled={filteredCandidates.length === 0}
              onClick={() => jumpCandidate(1)}
              title="Next Potential Map"
              className="rounded p-0.5 text-zinc-300 hover:bg-white/[0.08] disabled:opacity-30 cursor-pointer"
            >
              <ChevronRight className="h-3 w-3" />
            </button>
          </div>

          {/* Confidence Filter (85% / 70% / 55%) */}
          <div className="inline-flex rounded-md border border-white/[0.065] bg-[#101115] p-0.5 font-mono text-[10px]">
            {(
              [
                [0.85, '85%'],
                [0.7, '70%'],
                [0.55, '55%'],
              ] as const
            ).map(([thr, label]) => (
              <button
                key={thr}
                type="button"
                onClick={() => setMinConfidence(thr)}
                className={`rounded px-1.5 py-0.5 cursor-pointer ${
                  minConfidence === thr
                    ? 'bg-amber-500/25 text-amber-200'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Pattern Type Filter (All / 2D / 1D / Bosch / Ptr) */}
          <div className="inline-flex rounded-md border border-white/[0.065] bg-[#101115] p-0.5 text-[10px]">
            {(
              [
                ['all', 'All'],
                ['2d', '2D'],
                ['1d', '1D'],
                ['bosch', 'Bosch'],
                ['ptr', 'Ptr'],
              ] as const
            ).map(([pt, label]) => (
              <button
                key={pt}
                type="button"
                onClick={() => setPatternFilter(pt)}
                className={`rounded px-1.5 py-0.5 cursor-pointer ${
                  patternFilter === pt
                    ? 'bg-white/[0.12] text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Auto-Cols on Jump Toggle */}
          <button
            type="button"
            onClick={() => setAutoColsOnJump((v) => !v)}
            title="Automatically set hex columns & alignment when jumping to a map candidate"
            className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium cursor-pointer ${
              autoColsOnJump
                ? 'border-[#0a84ff]/45 bg-[#0a84ff]/15 text-sky-200'
                : 'border-white/[0.065] bg-[#101115] text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Auto-Cols
          </button>

          {/* Rescan */}
          <button
            type="button"
            onClick={handleRescan}
            title="Rescan binary for potential maps"
            className="inline-flex items-center gap-1 rounded-md border border-white/[0.065] bg-[#101115] px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-white/[0.08] hover:text-white cursor-pointer"
          >
            <RefreshCw className="h-2.5 w-2.5" />
            Rescan
          </button>

          {/* Restore Dismissed */}
          {dismissedCount > 0 ? (
            <button
              type="button"
              onClick={handleRestoreDismissed}
              title="Restore ignored map candidates"
              className="inline-flex items-center gap-1 rounded-md border border-amber-400/35 bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-200 hover:bg-amber-500/25 cursor-pointer"
            >
              <RotateCcw className="h-2.5 w-2.5" />
              Restore ({dismissedCount})
            </button>
          ) : null}
        </div>
      </div>

      {/* Main Content Area based on ViewMode (Text / 2D / 3D) */}
      {viewMode === '3d' ? (
        <HexSurface3D
          bin={bin}
          startAddress={surface3DParams.start}
          rows={surface3DParams.rows}
          cols={surface3DParams.cols}
          wordFormat={wordFormat}
          signed={isSigned}
          onExit={() => {
            setPreview3DTarget(null);
            setViewMode('text');
          }}
        />
      ) : viewMode === '2d' ? (
        <Waveform2D
          bin={bin}
          compareBin={compareBin}
          windowStart={windowStartAddress}
          wordFormat={wordFormat}
          candidates={showCandidates ? filteredCandidates : []}
          definition={definition}
          selectedRange={selectedRange}
          onJumpAddress={scrollToAddress}
          expanded={true}
          compareShift={compareShift}
          onCompareShiftChange={setCompareShift}
          onSelectRange={onSelectRange}
          onSelectXdfItem={onSelectXdfItem}
          onSelectCandidate={handleSelectWholeMap}
          signed={isSigned}
        />
      ) : (
        <>
          {/* Column Headers */}
          <div
            style={{ gridTemplateColumns }}
            className="grid shrink-0 items-center border-b border-white/[0.065] bg-[#17181d]/85 px-3 py-1.5 text-[11px] font-medium text-zinc-400"
          >
            <div className="font-mono text-zinc-500">Address</div>
            <div className="flex items-center gap-2 truncate pr-2">
              <span className="h-1.5 w-1.5 rounded-full bg-[#0a84ff] shadow-[0_0_6px_rgba(10,132,255,0.8)]" />
              <span className="truncate text-zinc-100">BIN · {binName}</span>
            </div>
            {splitMode ? (
              <>
                <div className="flex justify-center text-zinc-500" title="Click ← on changed rows to copy from Compare">
                  <GitCompareArrows className="h-3.5 w-3.5" />
                </div>
                <div className="flex items-center gap-2 truncate px-2">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      compareBin
                        ? 'bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.75)]'
                        : 'bg-zinc-600'
                    }`}
                  />
                  <span className="truncate text-zinc-300">
                    {compareBin
                      ? `Comparison · ${compareName}${
                          rightPaneMode === 'delta'
                            ? ' (Δ)'
                            : rightPaneMode === 'pct'
                              ? ' (Δ%)'
                              : ''
                        }`
                      : 'No Comparison Loaded'}
                  </span>
                </div>
              </>
            ) : null}
            {/* Resizable Right Column Header */}
            <div className="relative flex items-center gap-1.5 pl-2.5 text-zinc-400">
              <div
                onMouseDown={(e) => {
                  e.preventDefault();
                  resizingRightColRef.current = { startX: e.clientX, startW: rightColWidth };
                }}
                title="Drag to resize XDF / Candidate column (140–340px)"
                className="absolute inset-y-0 left-0 w-1.5 cursor-col-resize hover:bg-[#0a84ff]/50"
              />
              <Layers className="h-3 w-3 text-[#0a84ff]" />
              <span className="truncate">XDF Map / Detected</span>
            </div>
          </div>

          {/* Main Split Hex-Diff Recessed Well + Slide-over Code Drawer */}
          <div className="relative flex min-h-0 flex-1 overflow-hidden bg-[#101115]">
            <div
              ref={scrollContainerRef}
              onScroll={handleScroll}
              onMouseLeave={() => setHover(null)}
              className="relative min-h-0 flex-1 overflow-y-auto bg-[#101115] font-mono text-[12px] tabular-nums"
            >
              {totalDisplayRows === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-zinc-500">
                  {diffsOnly ? 'No differences between BIN and Comparison.' : 'Empty binary.'}
                </div>
              ) : (
                <div style={{ height: virtualHeight, position: 'relative' }}>
                  {visibleRawRows.map(({ displayIdx, address }) => {
                    const rowEnd = Math.min(bin.length, address + rowBytes);
                    const topPx = (displayIdx * ROW_HEIGHT) / Math.max(1, scrollScale);
                    const { xdf, cand } = findRowAnnotations(address, rowEnd);

                    const rowHasDiff =
                      compareBin !== null &&
                      Array.from({ length: colCount }, (_, i) =>
                        isWordDiff(
                          bin,
                          compareBin,
                          address + byteShift + i * wordBytes,
                          wordBytes,
                          compareShift,
                        ),
                      ).some(Boolean);

                    return (
                      <div
                        key={displayIdx}
                        style={{
                          position: 'absolute',
                          top: topPx,
                          left: 0,
                          right: 0,
                          height: ROW_HEIGHT,
                          gridTemplateColumns,
                        }}
                        className="grid items-center border-b border-white/[0.03] px-3 hover:bg-white/[0.025]"
                      >
                        {/* Address */}
                        <div className="text-[11px] text-zinc-500">{formatHexAddr(address)}</div>

                        {/* Primary BIN cells */}
                        <div className={`flex items-center ${cellGapCls} overflow-hidden pr-2`}>
                          {Array.from({ length: colCount }, (_, colIdx) => {
                            const off = address + byteShift + colIdx * wordBytes;
                            if (off >= bin.length) {
                              return (
                                <span
                                  key={colIdx}
                                  className={`inline-block text-center text-zinc-700 ${cellWidthCls}`}
                                >
                                  ··
                                </span>
                              );
                            }

                            const diff = isWordDiff(
                              bin,
                              compareBin,
                              off,
                              wordBytes,
                              compareShift,
                            );
                            const span = findCandidateAt(off);
                            const xdfSpan = findXdfAt(off);
                            const selected =
                              selectedRange !== null &&
                              off < selectedRange[1] &&
                              off + wordBytes > selectedRange[0];
                            const isSearchHit = searchMatchSet?.has(off) ?? false;

                            let outlineStyle: React.CSSProperties | undefined;
                            const activeSpan =
                              span?.role === 'data'
                                ? {
                                    start: span.start,
                                    end: span.end,
                                    isSelected:
                                      (selectedRange !== null &&
                                        selectedRange[0] < span.end &&
                                        selectedRange[1] > span.start) ||
                                      hover?.candidate?.id === span.candidate.id,
                                    isCandidate: true,
                                  }
                                : xdfSpan
                                  ? {
                                      start: xdfSpan.start,
                                      end: xdfSpan.end,
                                      isSelected:
                                        selectedRange !== null &&
                                        selectedRange[0] < xdfSpan.end &&
                                        selectedRange[1] > xdfSpan.start,
                                      isCandidate: false,
                                    }
                                  : null;

                            if (activeSpan) {
                              const inBlock = (a: number) =>
                                a >= activeSpan.start && a < activeSpan.end;
                              const edgeTop = !inBlock(off - rowBytes);
                              const edgeBottom = !inBlock(off + rowBytes);
                              const edgeLeft = colIdx === 0 || !inBlock(off - wordBytes);
                              const edgeRight =
                                colIdx === colCount - 1 || !inBlock(off + wordBytes);

                              const borderCss = activeSpan.isSelected
                                ? '1.5px solid rgba(255,255,255,0.8)'
                                : activeSpan.isCandidate
                                  ? '1px dashed rgba(245,158,11,0.78)'
                                  : '1px solid rgba(255,255,255,0.22)';

                              outlineStyle = {
                                borderTop: edgeTop ? borderCss : undefined,
                                borderBottom: edgeBottom ? borderCss : undefined,
                                borderLeft: edgeLeft ? borderCss : undefined,
                                borderRight: edgeRight ? borderCss : undefined,
                              };
                            }

                            const cellCls = selected
                              ? 'bg-[#0a84ff]/45 text-white rounded-[4px] ring-1 ring-[#0a84ff]'
                              : isSearchHit
                                ? 'bg-emerald-500/30 text-emerald-100 rounded-[4px] ring-1 ring-emerald-400/70'
                                : diff
                                  ? 'bg-[#0a84ff]/30 text-sky-100 rounded-[4px] ring-1 ring-[#0a84ff]/45'
                                  : span?.role === 'data'
                                    ? 'bg-amber-500/[0.09] text-amber-100 rounded-[3px]'
                                    : span?.role === 'axis'
                                      ? 'bg-zinc-200/[0.07] text-zinc-200 rounded-[3px] ring-1 ring-white/[0.12]'
                                      : xdfSpan
                                        ? 'bg-[#0a84ff]/[0.08] text-zinc-100 rounded-[3px]'
                                        : 'text-zinc-300 rounded-[4px] hover:bg-white/[0.08]';

                            const barPct = showBars
                              ? Math.round(normalizedWordRatio(bin, off, wordFormat, isSigned) * 100)
                              : 0;

                            return (
                              <span
                                key={colIdx}
                                style={outlineStyle}
                                onMouseDown={(e) => {
                                  if (e.button !== 0) return;
                                  if (e.altKey && (span?.candidate || xdfSpan?.item)) {
                                    setPinnedHud({
                                      candidate: span?.candidate ?? null,
                                      xdfItem: xdfSpan?.item ?? null,
                                      anchorX: e.clientX,
                                      anchorY: e.clientY,
                                    });
                                    return;
                                  }
                                  dragAnchorRef.current = off;
                                  onSelectRange([off, Math.min(bin.length, off + wordBytes)]);
                                }}
                                onMouseEnter={(e) => {
                                  setHover({
                                    address: off,
                                    candidate: span?.candidate ?? null,
                                    xdfItem: xdfSpan?.item ?? null,
                                    clientX: e.clientX,
                                    clientY: e.clientY,
                                  });
                                  if (dragAnchorRef.current !== null) {
                                    const a = Math.min(dragAnchorRef.current, off);
                                    const b = Math.min(
                                      bin.length,
                                      Math.max(dragAnchorRef.current, off) + wordBytes,
                                    );
                                    onSelectRange([a, b]);
                                  }
                                }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  if (!selected) {
                                    onSelectRange([off, Math.min(bin.length, off + wordBytes)]);
                                  }
                                  setContextMenu({
                                    x: e.clientX,
                                    y: e.clientY,
                                    address: off,
                                    candidate: span?.candidate ?? null,
                                    xdfItem: xdfSpan?.item ?? null,
                                  });
                                }}
                                className={`relative inline-flex h-[21px] cursor-pointer items-center justify-center overflow-hidden text-[11.5px] transition-colors ${cellWidthCls} ${cellCls}`}
                              >
                                {showBars ? (
                                  <span
                                    style={{ width: `${barPct}%` }}
                                    className="pointer-events-none absolute bottom-0 left-0 h-[2.5px] bg-sky-400/65"
                                  />
                                ) : null}
                                {readWordFormatted(bin, off, wordFormat, numberBase, isSigned)}
                              </span>
                            );
                          })}
                        </div>

                        {/* Center Diff 1-Click Transfer Gutter & Comparison Pane (Split mode) */}
                        {splitMode ? (
                          <>
                            <div className="flex justify-center">
                              {rowHasDiff ? (
                                <button
                                  type="button"
                                  onClick={() => handleCopyRowFromCompare(address)}
                                  title="Copy row from Compare (←)"
                                  className="inline-flex h-5 w-5 items-center justify-center rounded bg-[#0a84ff]/20 text-[11px] font-bold text-sky-300 transition-colors hover:bg-[#0a84ff] hover:text-white cursor-pointer"
                                >
                                  ←
                                </button>
                              ) : (
                                <span className="text-[10px] text-zinc-700">·</span>
                              )}
                            </div>

                            {/* Comparison BIN cells (Val / Δ / Δ%) */}
                            <div className={`flex items-center ${cellGapCls} overflow-hidden px-2`}>
                              {compareBin ? (
                                Array.from({ length: colCount }, (_, colIdx) => {
                                  const off = address + byteShift + colIdx * wordBytes;
                                  const cmpOff = off + compareShift;
                                  if (cmpOff < 0 || cmpOff >= compareBin.length) {
                                    return (
                                      <span
                                        key={colIdx}
                                        className={`inline-block text-center text-zinc-700 ${cellWidthCls}`}
                                      >
                                        ··
                                      </span>
                                    );
                                  }
                                  const diff = isWordDiff(
                                    bin,
                                    compareBin,
                                    off,
                                    wordBytes,
                                    compareShift,
                                  );
                                  const selected =
                                    selectedRange !== null &&
                                    off < selectedRange[1] &&
                                    off + wordBytes > selectedRange[0];

                                  let cellText: string;
                                  let deltaSign = 0;
                                  if (rightPaneMode === 'val') {
                                    cellText = readWordFormatted(
                                      compareBin,
                                      cmpOff,
                                      wordFormat,
                                      numberBase,
                                      isSigned,
                                    );
                                  } else {
                                    const pv = readWordNumeric(bin, off, wordFormat, isSigned);
                                    const cv = readWordNumeric(
                                      compareBin,
                                      cmpOff,
                                      wordFormat,
                                      isSigned,
                                    );
                                    if (pv === null || cv === null) {
                                      cellText = '··';
                                    } else {
                                      const d = pv - cv;
                                      deltaSign = d > 0 ? 1 : d < 0 ? -1 : 0;
                                      if (rightPaneMode === 'delta') {
                                        cellText =
                                          d === 0
                                            ? '0'
                                            : `${d > 0 ? '+' : ''}${
                                                wordFormat === 'f32le' || wordFormat === 'f32be'
                                                  ? d.toFixed(1)
                                                  : Math.round(d)
                                              }`;
                                      } else {
                                        if (d === 0) {
                                          cellText = '0%';
                                        } else {
                                          const denom = Math.abs(cv) > 1e-6 ? Math.abs(cv) : 1;
                                          const pct = (d / denom) * 100;
                                          cellText = `${pct > 0 ? '+' : ''}${
                                            Math.abs(pct) >= 100 ? pct.toFixed(0) : pct.toFixed(1)
                                          }%`;
                                        }
                                      }
                                    }
                                  }

                                  return (
                                    <span
                                      key={colIdx}
                                      onMouseDown={(e) => {
                                        if (e.button !== 0) return;
                                        dragAnchorRef.current = off;
                                        onSelectRange([off, Math.min(bin.length, off + wordBytes)]);
                                      }}
                                      onContextMenu={(e) => {
                                        e.preventDefault();
                                        const span = findCandidateAt(off);
                                        const xdfSpan = findXdfAt(off);
                                        setContextMenu({
                                          x: e.clientX,
                                          y: e.clientY,
                                          address: off,
                                          candidate: span?.candidate ?? null,
                                          xdfItem: xdfSpan?.item ?? null,
                                        });
                                      }}
                                      className={`inline-flex h-[21px] cursor-pointer items-center justify-center rounded-[4px] text-[11px] transition-colors ${cellWidthCls} ${
                                        selected
                                          ? 'bg-amber-500/30 text-amber-100 ring-1 ring-amber-400/70'
                                          : diff
                                            ? deltaSign > 0
                                              ? 'bg-rose-500/25 text-rose-200 ring-1 ring-rose-400/45'
                                              : deltaSign < 0
                                                ? 'bg-cyan-500/25 text-cyan-200 ring-1 ring-cyan-400/45'
                                                : 'bg-[#0a84ff]/30 text-sky-100 ring-1 ring-[#0a84ff]/45'
                                            : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-300'
                                      }`}
                                    >
                                      {cellText}
                                    </span>
                                  );
                                })
                              ) : (
                                <span className="text-[11px] text-zinc-600 italic">
                                  Load a comparison BIN to inspect byte diffs
                                </span>
                              )}
                            </div>
                          </>
                        ) : null}

                        {/* Resizable Right XDF Map / Detected Candidate Annotation Column */}
                        <div className="flex items-center gap-1 overflow-hidden border-l border-white/[0.04] pl-2">
                          {xdf ? (
                            <button
                              type="button"
                              onClick={() => onSelectXdfItem(xdf.id)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                setPinnedHud({
                                  candidate: null,
                                  xdfItem: xdf,
                                  anchorX: e.clientX,
                                  anchorY: e.clientY,
                                });
                              }}
                              title={`${xdf.title} — click to open in Table Editor`}
                              className="truncate rounded-md border border-[#0a84ff]/35 bg-[#0a84ff]/15 px-2 py-0.5 font-sans text-[10.5px] font-medium text-sky-200 transition-colors hover:bg-[#0a84ff]/28 cursor-pointer"
                            >
                              {xdf.title}
                            </button>
                          ) : cand ? (
                            <div className="flex min-w-0 items-center gap-1">
                              <button
                                type="button"
                                onClick={(e) => {
                                  setPinnedHud({
                                    candidate: cand,
                                    xdfItem: null,
                                    anchorX: e.clientX,
                                    anchorY: e.clientY,
                                  });
                                }}
                                title="Click to pin Mini-HUD preview & actions"
                                className="inline-flex min-w-0 items-center gap-1 truncate rounded-md border border-dashed border-amber-400/50 bg-amber-500/[0.12] px-1.5 py-0.5 font-sans text-[10.5px] font-medium text-amber-200 transition-colors hover:bg-amber-500/22 cursor-pointer"
                              >
                                <Sparkles className="h-2.5 w-2.5 shrink-0 text-amber-400" />
                                <span className="truncate">
                                  {cand.rows}×{cand.cols} · {Math.round(cand.confidence * 100)}%
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={() => onAddCandidateToXdf(cand, false)}
                                title="Quick-add candidate to XDF (1-Click)"
                                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-amber-400/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/35 hover:text-white cursor-pointer"
                              >
                                <Plus className="h-3 w-3" />
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Sleek Code XREFs & Disassembler Slide-Over Drawer */}
            {drawerOpen ? (
              <aside className="absolute inset-y-0 right-0 z-30 flex w-[410px] max-w-[92%] flex-col border-l border-white/[0.08] bg-[#17181d]/95 shadow-[-16px_0_48px_rgba(0,0,0,0.6)] backdrop-blur-2xl">
                <div className="flex items-center justify-between gap-2 border-b border-white/[0.065] px-3 py-2.5">
                  <div className="inline-flex rounded-lg border border-white/[0.065] bg-[#101115] p-0.5 text-[11px] font-medium">
                    <button
                      type="button"
                      onClick={() => setDrawerTab('xrefs')}
                      className={`inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 transition-colors cursor-pointer ${
                        drawerTab === 'xrefs'
                          ? 'bg-[#0a84ff] text-white shadow-[0_1px_8px_rgba(10,132,255,0.4)]'
                          : 'text-zinc-400 hover:text-zinc-100'
                      }`}
                    >
                      <Crosshair className="h-3 w-3" />
                      XREFs
                    </button>
                    <button
                      type="button"
                      onClick={() => setDrawerTab('disasm')}
                      className={`inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 transition-colors cursor-pointer ${
                        drawerTab === 'disasm'
                          ? 'bg-[#0a84ff] text-white shadow-[0_1px_8px_rgba(10,132,255,0.4)]'
                          : 'text-zinc-400 hover:text-zinc-100'
                      }`}
                    >
                      <Cpu className="h-3 w-3" />
                      Disassembler
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="rounded-md border border-white/[0.065] bg-[#101115] px-2 py-0.5 font-mono text-[11px] font-semibold text-sky-300 tabular-nums">
                      0x{formatHexAddr(drawerAddress)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setDrawerOpen(false)}
                      title="Close drawer"
                      className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-white/[0.08] hover:text-zinc-100 cursor-pointer"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {drawerTab === 'xrefs' ? (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex items-center justify-between border-b border-white/[0.065] bg-[#101115]/70 px-3 py-1.5 text-[11px] text-zinc-400">
                      <span>
                        Code references to{' '}
                        <span className="font-mono font-medium text-zinc-200">
                          0x{formatHexAddr(drawerAddress)}
                        </span>
                      </span>
                      <span className="font-mono text-[10px] text-zinc-500 tabular-nums">
                        {xrefs.length} found
                      </span>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                      {xrefs.length === 0 ? (
                        <div className="flex h-44 flex-col items-center justify-center rounded-xl border border-white/[0.065] bg-[#101115] px-4 text-center">
                          <Crosshair className="mb-2 h-5 w-5 text-zinc-600" />
                          <div className="text-xs font-medium text-zinc-300">
                            No direct code references found
                          </div>
                          <p className="mt-1 text-[11px] text-zinc-500">
                            Try scanning a map start address or switch to the Disassembler tab.
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          {xrefs.map((xr, idx) => (
                            <div
                              key={`${xr.address}_${idx}`}
                              onClick={() => {
                                scrollToAddress(xr.address);
                                onSelectRange([xr.address, Math.min(bin.length, xr.address + 4)]);
                              }}
                              className="group cursor-pointer rounded-lg border border-white/[0.065] bg-[#101115] p-2.5 transition-colors hover:border-[#0a84ff]/50"
                            >
                              <div className="mb-1 flex items-center justify-between gap-2">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-mono text-[11.5px] font-semibold text-sky-300 tabular-nums">
                                    0x{formatHexAddr(xr.address)}
                                  </span>
                                  <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9.5px] text-zinc-300">
                                    {xr.arch}
                                  </span>
                                  <span className="rounded bg-[#0a84ff]/15 px-1.5 py-0.5 font-mono text-[9.5px] text-sky-300">
                                    {xr.kind}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openDrawerAt(xr.address, 'disasm');
                                  }}
                                  className="rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-zinc-300 hover:border-[#0a84ff]/50 hover:bg-[#0a84ff]/20 hover:text-sky-100 cursor-pointer"
                                >
                                  Disasm
                                </button>
                              </div>
                              <div className="truncate font-mono text-[11px] text-zinc-300">
                                {xr.instruction}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex items-center justify-between gap-2 border-b border-white/[0.065] bg-[#101115]/70 px-3 py-1.5">
                      <div className="inline-flex rounded-md border border-white/[0.065] bg-[#0c0d10] p-0.5 text-[10px] font-medium">
                        {(
                          [
                            ['auto', 'Auto'],
                            ['tricore', 'TriCore'],
                            ['powerpc', 'PPC'],
                            ['c166', 'C166'],
                            ['arm', 'ARM'],
                          ] as const
                        ).map(([a, label]) => (
                          <button
                            key={a}
                            type="button"
                            onClick={() => setDisasmArch(a)}
                            className={`rounded px-1.5 py-0.5 transition-colors cursor-pointer ${
                              disasmArch === a
                                ? 'bg-[#0a84ff] text-white'
                                : 'text-zinc-400 hover:text-zinc-200'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setDrawerAddress((prev) => Math.max(0, prev - 64))}
                          title="Step back 64 bytes"
                          className="rounded border border-white/[0.065] bg-white/[0.04] p-1 text-zinc-300 hover:bg-white/[0.08] cursor-pointer"
                        >
                          <ChevronLeft className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDrawerAddress((prev) =>
                              Math.min(Math.max(0, bin.length - 4), prev + 64),
                            )
                          }
                          title="Step forward 64 bytes"
                          className="rounded border border-white/[0.065] bg-white/[0.04] p-1 text-zinc-300 hover:bg-white/[0.08] cursor-pointer"
                        >
                          <ChevronRight className="h-3 w-3" />
                        </button>
                      </div>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto bg-[#101115] p-2 font-mono text-[11px] tabular-nums">
                      {disasmLines.map((ins) => {
                        const isAnchor = ins.address === drawerAddress;
                        return (
                          <div
                            key={ins.address}
                            onClick={() => {
                              scrollToAddress(ins.address);
                              onSelectRange([
                                ins.address,
                                Math.min(bin.length, ins.address + ins.size),
                              ]);
                            }}
                            className={`grid cursor-pointer grid-cols-[62px_88px_64px_1fr] items-center gap-1.5 rounded px-2 py-1 transition-colors ${
                              isAnchor
                                ? 'bg-[#0a84ff]/20 text-sky-100 ring-1 ring-[#0a84ff]/40'
                                : 'hover:bg-white/[0.04]'
                            }`}
                          >
                            <span className="text-[10.5px] text-zinc-500">
                              {formatHexAddr(ins.address)}
                            </span>
                            <span className="truncate text-[10px] text-zinc-500">{ins.bytes}</span>
                            <span className="font-semibold text-sky-300">{ins.mnemonic}</span>
                            <span className="truncate text-zinc-200">
                              {ins.operands}
                              {ins.comment ? (
                                <span className="ml-2 text-zinc-500">; {ins.comment}</span>
                              ) : null}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </aside>
            ) : null}
          </div>
        </>
      )}

      {/* Selection Inspector Footer */}
      <div className="relative flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-white/[0.065] bg-[#17181d] px-3 py-1.5 text-[11px]">
        <div className="flex flex-wrap items-center gap-2.5 font-mono text-zinc-400 tabular-nums">
          {hoveredInfo ? (
            <>
              <span className="font-semibold text-sky-300">
                0x{formatHexAddr(hoveredInfo.addr)}
              </span>
              <span>
                U8: <strong className="text-zinc-100">{hoveredInfo.u8}</strong>
              </span>
              <span>
                Bin: <strong className="text-emerald-300">{hoveredInfo.binStr}</strong>
              </span>
              {hoveredInfo.u16le !== null ? (
                <>
                  <span>
                    U16 LoHi: <strong className="text-zinc-100">{hoveredInfo.u16le}</strong>
                  </span>
                  <span>
                    HiLo: <strong className="text-zinc-100">{hoveredInfo.u16be}</strong>
                  </span>
                </>
              ) : null}
              {hoveredInfo.xdfItem ? (
                <button
                  type="button"
                  onClick={() => onSelectXdfItem(hoveredInfo.xdfItem!.id)}
                  className="inline-flex items-center gap-1 rounded-md border border-[#0a84ff]/40 bg-[#0a84ff]/15 px-1.5 py-0.5 font-sans text-[10px] font-medium text-sky-200 hover:bg-[#0a84ff]/30 cursor-pointer"
                >
                  <Table2 className="h-3 w-3" />
                  {hoveredInfo.xdfItem.title}
                </button>
              ) : null}
            </>
          ) : (
            <span className="text-zinc-500">Hover or drag to inspect bytes</span>
          )}

          {hasSelection && selectedRange ? (
            <span className="rounded-md border border-white/[0.065] bg-[#101115] px-2 py-0.5 text-amber-300">
              Sel: 0x{formatHexAddr(selectedRange[0])}..0x{formatHexAddr(selectedRange[1])} (
              {selectedRange[1] - selectedRange[0]} B)
            </span>
          ) : null}

          {copyToast ? (
            <span className="rounded-md border border-emerald-400/25 bg-emerald-500/15 px-2 py-0.5 font-sans text-[10px] font-medium text-emerald-300">
              {copyToast}
            </span>
          ) : null}
        </div>

        {/* Quick selection action buttons + Step ±1 + Edit… + Twins popover */}
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Value Step - / + */}
          <div className="inline-flex items-center rounded-md border border-white/[0.065] bg-[#101115] p-0.5">
            <button
              type="button"
              disabled={!hasSelection}
              onClick={() => handleStepSelection(-1)}
              title="Decrement selected word(s) by 1"
              className="rounded p-0.5 text-zinc-300 hover:bg-white/[0.1] hover:text-white disabled:cursor-not-allowed disabled:opacity-30 cursor-pointer"
            >
              <Minus className="h-3 w-3" />
            </button>
            <button
              type="button"
              disabled={!hasSelection}
              onClick={() => handleStepSelection(1)}
              title="Increment selected word(s) by 1"
              className="rounded p-0.5 text-zinc-300 hover:bg-white/[0.1] hover:text-white disabled:cursor-not-allowed disabled:opacity-30 cursor-pointer"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>

          {/* Inline Edit… Popover Trigger */}
          <div className="relative">
            <button
              type="button"
              disabled={!hasSelection}
              onClick={() => {
                if (selectedRange) {
                  setEditValueInput(
                    readWordFormatted(bin, selectedRange[0], wordFormat, numberBase, isSigned),
                  );
                }
                setTwinsPopoverOpen(false);
                setEditPopoverOpen((v) => !v);
              }}
              className="inline-flex items-center gap-1 rounded-md border border-white/[0.065] bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-zinc-200 transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-35 cursor-pointer"
            >
              <Edit3 className="h-3 w-3" />
              Edit…
            </button>

            {editPopoverOpen && hasSelection ? (
              <div className="glass-popover absolute bottom-full right-0 z-40 mb-2 w-64 rounded-xl p-2.5 text-zinc-100 shadow-2xl">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-semibold">Edit / Fill Selection</span>
                  <button
                    type="button"
                    onClick={() => setEditPopoverOpen(false)}
                    className="rounded p-0.5 text-zinc-400 hover:bg-white/[0.08] cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="mb-2 flex items-center gap-1">
                  <input
                    type="text"
                    value={editValueInput}
                    onChange={(e) => setEditValueInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleApplyInlineEdit();
                    }}
                    placeholder={`Exact ${wordFormat} (${numberBase})`}
                    className="min-w-0 flex-1 rounded-md border border-white/[0.08] bg-[#101115] px-2 py-1 font-mono text-[11px] text-zinc-100 outline-none focus:border-[#0a84ff]"
                  />
                  <button
                    type="button"
                    onClick={handleApplyInlineEdit}
                    className="rounded-md bg-[#0a84ff] px-2 py-1 text-[11px] font-medium text-white hover:bg-[#0a84ff]/85 cursor-pointer"
                  >
                    Write
                  </button>
                </div>

                <div className="border-t border-white/[0.065] pt-2">
                  <div className="mb-1 text-[10px] text-zinc-400">Quick Byte Fill</div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        handleFillSelection(0x00);
                        setEditPopoverOpen(false);
                      }}
                      className="rounded-md border border-white/[0.08] bg-white/[0.05] px-2 py-1 font-mono text-[10.5px] text-zinc-200 hover:bg-white/[0.12] cursor-pointer"
                    >
                      0x00
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        handleFillSelection(0xff);
                        setEditPopoverOpen(false);
                      }}
                      className="rounded-md border border-white/[0.08] bg-white/[0.05] px-2 py-1 font-mono text-[10.5px] text-zinc-200 hover:bg-white/[0.12] cursor-pointer"
                    >
                      0xFF
                    </button>
                    <input
                      type="text"
                      maxLength={2}
                      value={customFillHexInput}
                      onChange={(e) =>
                        setCustomFillHexInput(e.target.value.replace(/[^0-9a-fA-F]/g, '').toUpperCase())
                      }
                      className="w-10 rounded-md border border-white/[0.08] bg-[#101115] px-1.5 py-1 text-center font-mono text-[10.5px] text-zinc-100 outline-none focus:border-[#0a84ff]"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const v = parseInt(customFillHexInput || '0', 16);
                        if (Number.isFinite(v)) {
                          handleFillSelection(v & 0xff);
                          setEditPopoverOpen(false);
                        }
                      }}
                      className="flex-1 rounded-md border border-amber-400/35 bg-amber-500/15 px-2 py-1 text-[10.5px] font-medium text-amber-200 hover:bg-amber-500/25 cursor-pointer"
                    >
                      Fill
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <button
            type="button"
            disabled={!hasSelection}
            onClick={handleCopyHex}
            className="inline-flex items-center gap-1 rounded-md border border-white/[0.065] bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-zinc-200 transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-35 cursor-pointer"
          >
            <Copy className="h-3 w-3" />
            Copy Hex
          </button>

          <button
            type="button"
            disabled={!hasSelection || !compareBin}
            onClick={handleCopyFromCompare}
            className="inline-flex items-center gap-1 rounded-md border border-[#0a84ff]/35 bg-[#0a84ff]/15 px-2 py-1 text-[11px] font-medium text-sky-200 transition-colors hover:bg-[#0a84ff]/28 disabled:cursor-not-allowed disabled:opacity-35 cursor-pointer"
          >
            <ArrowLeft className="h-3 w-3" />
            Cmp
          </button>

          {/* Inline Twins Results Popover */}
          <div className="relative">
            <button
              type="button"
              disabled={!hasSelection}
              onClick={() => {
                setEditPopoverOpen(false);
                handleOpenTwins(selectedRange);
              }}
              className="inline-flex items-center gap-1 rounded-md border border-white/[0.065] bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-zinc-200 transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-35 cursor-pointer"
            >
              <Search className="h-3 w-3" />
              Twins
            </button>

            {twinsPopoverOpen ? (
              <div className="glass-popover absolute bottom-full right-0 z-40 mb-2 w-64 rounded-xl p-2.5 text-zinc-100 shadow-2xl">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-semibold">Twin Map Matches</span>
                  <button
                    type="button"
                    onClick={() => setTwinsPopoverOpen(false)}
                    className="rounded p-0.5 text-zinc-400 hover:bg-white/[0.08] cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                {twinMatches.length === 0 ? (
                  <div className="py-3 text-center text-[11px] text-zinc-500">
                    No twin blocks ≥ 86% found.
                  </div>
                ) : (
                  <div className="max-h-48 space-y-1 overflow-y-auto">
                    {twinMatches.map((tm) => (
                      <button
                        key={tm.address}
                        type="button"
                        onClick={() => {
                          const len = selectedRange ? selectedRange[1] - selectedRange[0] : wordBytes;
                          scrollToAddress(tm.address);
                          onSelectRange([tm.address, Math.min(bin.length, tm.address + len)]);
                          setTwinsPopoverOpen(false);
                        }}
                        className="flex w-full items-center justify-between rounded-md border border-white/[0.06] bg-[#101115] px-2 py-1 font-mono text-[11px] hover:border-[#0a84ff]/45 hover:bg-white/[0.06] cursor-pointer"
                      >
                        <span className="text-sky-300">0x{formatHexAddr(tm.address)}</span>
                        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                          {Math.round(tm.similarity * 100)}%
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            disabled={!hasSelection}
            onClick={handleMapFromSelection}
            className="inline-flex items-center gap-1 rounded-md border border-amber-400/35 bg-amber-500/15 px-2 py-1 text-[11px] font-medium text-amber-200 transition-colors hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-35 cursor-pointer"
          >
            <PlusSquare className="h-3 w-3" />
            Map from Selection…
          </button>
        </div>
      </div>

      {/* Synced 2D Waveform Plotter (shown below Text hex view) */}
      {viewMode === 'text' ? (
        <Waveform2D
          bin={bin}
          compareBin={compareBin}
          windowStart={windowStartAddress}
          wordFormat={wordFormat}
          candidates={showCandidates ? filteredCandidates : []}
          definition={definition}
          selectedRange={selectedRange}
          onJumpAddress={scrollToAddress}
          expanded={false}
          compareShift={compareShift}
          onCompareShiftChange={setCompareShift}
          onSelectRange={onSelectRange}
          onSelectXdfItem={onSelectXdfItem}
          onSelectCandidate={handleSelectWholeMap}
          signed={isSigned}
        />
      ) : null}

      {/* Floating or Pinned Liquid Glass Mini-HUD (Candidate OR XDF Map Hover Preview) */}
      {pinnedHud ? (
        <HexMiniHud
          candidate={pinnedHud.candidate}
          xdfItem={pinnedHud.xdfItem}
          bin={bin}
          compareBin={compareBin}
          anchorX={pinnedHud.anchorX}
          anchorY={pinnedHud.anchorY}
          pinned={true}
          onUnpin={() => setPinnedHud(null)}
          onAddToXdf={onAddCandidateToXdf}
          onEditInXdf={(c) => {
            if (onOpenXdfModalForCandidate) onOpenXdfModalForCandidate(c);
            else onAddCandidateToXdf(c, true);
          }}
          onOpenXdfItem={(item) => onSelectXdfItem(item.id)}
          onSetCols={(cols) => setColCount(Math.max(1, Math.min(32, cols)))}
          onIgnoreCandidate={handleIgnoreCandidate}
          heatmapPalette={heatmapPalette}
        />
      ) : (hover?.candidate || hover?.xdfItem) && !contextMenu ? (
        <HexMiniHud
          candidate={hover.candidate}
          xdfItem={hover.xdfItem}
          bin={bin}
          compareBin={compareBin}
          anchorX={hover.clientX}
          anchorY={hover.clientY}
          heatmapPalette={heatmapPalette}
        />
      ) : null}

      {/* Right-click Liquid Glass Context Menu */}
      {contextMenu ? (
        <HexContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          address={contextMenu.address}
          candidate={contextMenu.candidate}
          xdfItem={contextMenu.xdfItem}
          selectedRange={selectedRange}
          hasCompare={compareBin !== null}
          byteShift={byteShift}
          onClose={() => setContextMenu(null)}
          onAddCandidateToXdf={onAddCandidateToXdf}
          onSelectWholeMap={handleSelectWholeMap}
          onCopyHex={handleCopyHex}
          onCopyFromCompare={handleCopyFromCompare}
          onFillSelection={handleFillSelection}
          onCopyAddress={() => {
            const hex = `0x${formatHexAddr(contextMenu.address)}`;
            void navigator.clipboard?.writeText(hex);
            showToast(`Copied ${hex}`);
          }}
          onFindTwins={() => handleOpenTwins(selectedRange)}
          onFindXRefs={() => {
            const target =
              contextMenu.xdfItem?.data.address ??
              contextMenu.candidate?.address ??
              contextMenu.address;
            openDrawerAt(target, 'xrefs');
          }}
          onDisassembleHere={() => {
            openDrawerAt(contextMenu.address, 'disasm');
          }}
          onOpenXdfItem={(item) => onSelectXdfItem(item.id)}
          onSelectXdfItemRange={(item) => {
            const [s, e] = layoutByteRange(item.data);
            onSelectRange([s, Math.min(bin.length, e)]);
          }}
          onCenterAddress={(addr) => scrollToAddress(addr)}
          onCustomizeCandidateXdf={(c) => {
            if (onOpenXdfModalForCandidate) onOpenXdfModalForCandidate(c);
            else onAddCandidateToXdf(c, true);
          }}
          onSetCols={(cols) => {
            setColCount(Math.max(1, Math.min(32, cols)));
            showToast(`Columns set to ${cols}`);
          }}
          onSelectMapWithAxes={handleSelectMapWithAxes}
          onPreview3D={(range, cols) => {
            const elems = Math.max(4, Math.floor((range[1] - range[0]) / wordBytes));
            const c = Math.max(2, Math.min(32, cols ?? colCount));
            const r = Math.max(2, Math.min(32, Math.ceil(elems / c)));
            setPreview3DTarget({ start: range[0], rows: r, cols: c });
            setViewMode('3d');
          }}
          onIgnoreCandidate={handleIgnoreCandidate}
          onAnalyzeCreateXdfFromSelection={handleMapFromSelection}
          onSetColsToSelectionWidth={() => {
            if (!selectedRange || selectedRange[1] <= selectedRange[0]) return;
            const elems = Math.max(1, Math.min(32, Math.floor((selectedRange[1] - selectedRange[0]) / wordBytes)));
            setColCount(elems);
            showToast(`Columns set to ${elems}`);
          }}
          onFillCustomByte={() => {
            setTwinsPopoverOpen(false);
            setEditPopoverOpen(true);
          }}
          onAlignLeftAtAddress={(addr) => {
            const nextShift = addr % Math.max(1, rowBytes);
            setByteShift(nextShift);
            showToast(`Aligned left @ 0x${formatHexAddr(addr)} (+${nextShift} B)`);
          }}
          onResetByteShift={() => {
            setByteShift(0);
            showToast('Byte shift reset to +0 B');
          }}
          onAddBookmark={(addr) => handleAddBookmarkAt(addr)}
        />
      ) : null}
    </div>
  );
};
