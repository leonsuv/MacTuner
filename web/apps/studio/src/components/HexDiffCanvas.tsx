import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Cpu,
  Crosshair,
  Filter,
  GitCompareArrows,
  Layers,
  Navigation,
  PlusSquare,
  Search,
  Sparkles,
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
import { HexMiniHud } from './HexMiniHud';
import { Waveform2D, type HexWordFormat } from './Waveform2D';

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
}

type ColCount = 8 | 12 | 16;
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
}

interface HoverState {
  address: number;
  candidate: MapCandidate | null;
  clientX: number;
  clientY: number;
}

const ROW_HEIGHT = 26;
const OVERSCAN = 6;
const MAX_VIRTUAL_PX = 8_000_000;

function formatHexAddr(addr: number): string {
  return addr.toString(16).toUpperCase().padStart(6, '0');
}

function readWordHex(
  bytes: Uint8Array,
  offset: number,
  format: HexWordFormat,
  base: 'hex' | 'dec' = 'hex',
  signed = false,
): string {
  if (offset < 0 || offset >= bytes.length) return '··';
  if (format === 'u8') {
    const raw = bytes[offset];
    if (base === 'dec') {
      const v = signed && raw >= 128 ? raw - 256 : raw;
      return String(v);
    }
    return raw.toString(16).toUpperCase().padStart(2, '0');
  }
  if (offset + 1 >= bytes.length) {
    return `${bytes[offset].toString(16).toUpperCase().padStart(2, '0')}··`;
  }
  const val =
    format === 'u16le'
      ? bytes[offset] | (bytes[offset + 1] << 8)
      : (bytes[offset] << 8) | bytes[offset + 1];
  if (base === 'dec') {
    const v = signed && val >= 32768 ? val - 65536 : val;
    return String(v);
  }
  return val.toString(16).toUpperCase().padStart(4, '0');
}

function isWordDiff(
  bin: Uint8Array,
  compareBin: Uint8Array | null,
  offset: number,
  wordBytes: number,
): boolean {
  if (!compareBin) return false;
  for (let i = 0; i < wordBytes; i++) {
    const idx = offset + i;
    if (idx < bin.length && idx < compareBin.length && bin[idx] !== compareBin[idx]) {
      return true;
    }
  }
  return false;
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
      // Fallback to local scanner below
    }
  }

  // Fast built-in XREF scanner: 32-bit LE/BE flash pointers (raw, 0x80000000, 0xA0000000, 0x00800000) & 16-bit segment offsets
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

  // Secondary 16-bit low-word offset match (common in C166 / ME7 DPP-relative map lookups)
  const low16 = targetAddress & 0xffff;
  if (results.length < 12 && low16 > 0x0100 && low16 !== 0xffff) {
    const lo = low16 & 0xff;
    const hi = (low16 >> 8) & 0xff;
    for (let i = 0; i + 4 <= len && results.length < 24; i += 2) {
      if (Math.abs(i - targetAddress) < 16) continue;
      // C166 MOV Rn, #imm16 (0xE6) or ADD/SUB/CMP immediate
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

// Adapter for @mactuner/core's disassembleSlice with built-in fallback
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
      // Fallback to local disassembler below
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
      // TriCore 16-bit (odd low bit 0) vs 32-bit (low bit 1) instruction length
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
      // C166 (Bosch ME7.x)
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
}) => {
  const [wordFormat, setWordFormat] = useState<HexWordFormat>('u16le');
  const [colCount, setColCount] = useState<number>(8);
  const [byteShift, setByteShift] = useState<number>(0);
  const [numberBase, setNumberBase] = useState<'hex' | 'dec'>('hex');
  const [isSigned, setIsSigned] = useState<boolean>(false);
  const [compareShift, setCompareShift] = useState<number>(0);
  const [diffsOnly, setDiffsOnly] = useState<boolean>(false);
  const [gotoInput, setGotoInput] = useState<string>('');
  const [topRow, setTopRow] = useState<number>(0);
  const [viewportHeight, setViewportHeight] = useState<number>(572);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [activeDiffIdx, setActiveDiffIdx] = useState<number>(-1);
  const [copyToast, setCopyToast] = useState<string | null>(null);

  // Code XREFs & Disassembler slide-over drawer state
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('xrefs');
  const [drawerAddress, setDrawerAddress] = useState<number>(0);
  const [disasmArch, setDisasmArch] = useState<CpuArch>('auto');

  const dragAnchorRef = useRef<number | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const wordBytes = wordFormat === 'u8' ? 1 : 2;
  const rowBytes = colCount * wordBytes;

  // Compute diff byte count, diff cluster start offsets, and diff row indices
  const diffStats = useMemo(() => {
    if (!compareBin) {
      return { totalDiffBytes: 0, clusters: [] as number[], diffRows: [] as number[] };
    }
    const len = Math.min(bin.length, compareBin.length);
    let totalDiffBytes = 0;
    const clusters: number[] = [];
    const diffRows: number[] = [];
    let lastDiffRow = -1;
    let inCluster = false;
    let gap = 0;

    for (let i = 0; i < len; i++) {
      if (bin[i] !== compareBin[i]) {
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
  }, [bin, compareBin, rowBytes]);

  // Index MapCandidates for fast lookup
  const candidateSpans = useMemo<SpanEntry[]>(() => {
    const out: SpanEntry[] = [];
    for (const c of candidates) {
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
  }, [candidates]);

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
  const totalDisplayRows =
    diffsOnly && compareBin ? diffStats.diffRows.length : totalRawRows;

  // Virtual scrollbar scaling (keeps scroll height <= MAX_VIRTUAL_PX for 8MB+ binaries)
  const rawContentHeight = totalDisplayRows * ROW_HEIGHT;
  const virtualHeight = Math.min(rawContentHeight, MAX_VIRTUAL_PX);
  const scrollScale =
    rawContentHeight > viewportHeight && virtualHeight > viewportHeight
      ? (rawContentHeight - viewportHeight) / (virtualHeight - viewportHeight)
      : 1;

  // Measure viewport height
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const update = () => setViewportHeight(el.clientHeight || 572);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  // React to external jumpAddress prop
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

  // Global mouseup to end drag selection
  useEffect(() => {
    const onUp = () => {
      dragAnchorRef.current = null;
    };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, []);

  const showToast = useCallback((msg: string) => {
    setCopyToast(msg);
    window.setTimeout(() => setCopyToast((prev) => (prev === msg ? null : prev)), 1600);
  }, []);

  const openDrawerAt = useCallback((addr: number, tab: DrawerTab) => {
    setDrawerAddress(Math.max(0, Math.min(Math.max(0, bin.length - 1), addr)));
    setDrawerTab(tab);
    setDrawerOpen(true);
  }, [bin.length]);

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
    const clampedEnd = Math.min(end, bin.length, compareBin.length);
    if (clampedEnd <= start) return;
    const next = new Uint8Array(compareBin.subarray(start, clampedEnd));
    onApplyPatch(
      start,
      next,
      `Copy ${next.length} B from Compare @ 0x${formatHexAddr(start)}`,
    );
  }, [bin.length, compareBin, selectedRange, onApplyPatch]);

  const handleFillSelection = useCallback(
    (byteValue: number) => {
      if (!selectedRange || selectedRange[1] <= selectedRange[0]) return;
      const [start, end] = selectedRange;
      const clampedEnd = Math.min(end, bin.length);
      if (clampedEnd <= start) return;
      const next = new Uint8Array(clampedEnd - start);
      next.fill(byteValue & 0xff);
      onApplyPatch(
        start,
        next,
        `Fill 0x${byteValue.toString(16).toUpperCase().padStart(2, '0')} (${next.length} B @ 0x${formatHexAddr(start)})`,
      );
    },
    [bin.length, selectedRange, onApplyPatch],
  );

  const handleSelectWholeMap = useCallback(
    (c: MapCandidate) => {
      const eb = Math.max(1, Math.floor(c.bits / 8));
      onSelectRange([c.address, Math.min(bin.length, c.address + c.rows * c.cols * eb)]);
    },
    [bin.length, onSelectRange],
  );

  const handleMapFromSelection = useCallback(() => {
    if (!selectedRange || selectedRange[1] <= selectedRange[0]) return;
    const [start, end] = selectedRange;
    const bytes = end - start;
    const bits = wordFormat === 'u8' ? 8 : 16;
    const eb = bits / 8;
    const elems = Math.max(1, Math.floor(bytes / eb));
    const cols = elems >= colCount ? colCount : elems;
    const rows = Math.max(1, Math.floor(elems / cols));
    const lsbFirst = wordFormat !== 'u16be';
    const synthetic: MapCandidate = {
      id: `sel_${start.toString(16)}_${rows}x${cols}`,
      address: start,
      rows,
      cols,
      bits,
      signed: false,
      isFloat: false,
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
        signed: false,
        lsbFirst,
        columnMajor: false,
        isFloat: false,
        rows,
        cols,
      },
    };
    onAddCandidateToXdf(synthetic, true);
  }, [selectedRange, wordFormat, colCount, onAddCandidateToXdf]);

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

  // Current top address for Waveform2D sync
  const topRawRow =
    diffsOnly && compareBin
      ? (diffStats.diffRows[topRow] ?? 0)
      : topRow;
  const windowStartAddress = Math.min(
    Math.max(0, bin.length - rowBytes),
    topRawRow * rowBytes,
  );

  // Hovered byte/word readout for status bar
  const hoveredInfo = useMemo(() => {
    const addr = hover?.address ?? selectedRange?.[0] ?? null;
    if (addr === null || addr < 0 || addr >= bin.length) return null;
    const u8 = bin[addr];
    const u16le = addr + 1 < bin.length ? bin[addr] | (bin[addr + 1] << 8) : null;
    const u16be = addr + 1 < bin.length ? (bin[addr] << 8) | bin[addr + 1] : null;
    return { addr, u8, u16le, u16be };
  }, [hover, selectedRange, bin]);

  // WinOLS keyboard shortcuts: M / W adjust column width, [ / ] shift byte offset
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
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
    showToast(`Auto-Sync: ${res.offset >= 0 ? '+' : ''}${res.offset} B (${Math.round(res.confidence * 100)}%)`);
  }, [bin, compareBin, windowStartAddress, showToast]);

  const hasSelection = selectedRange !== null && selectedRange[1] > selectedRange[0];
  const cellWidthCls = wordFormat === 'u8' ? (numberBase === 'dec' ? 'w-8' : 'w-6') : (numberBase === 'dec' ? 'w-[48px]' : 'w-[42px]');
  const cellGapCls = colCount <= 8 ? 'gap-1.5' : 'gap-1';

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[#0c0d10] text-zinc-100 select-none">
      {/* Top Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/[0.065] bg-[#17181d] px-3 py-2">
        {/* Left group: Word Format + Base/Signed + Arbitrary Columns + Byte Shift */}
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="inline-flex rounded-lg border border-white/[0.065] bg-[#101115] p-0.5 text-[11px] font-medium">
            {(
              [
                ['u8', '8b'],
                ['u16le', '16 LoHi'],
                ['u16be', '16 HiLo'],
              ] as const
            ).map(([fmt, label]) => (
              <button
                key={fmt}
                type="button"
                onClick={() => setWordFormat(fmt)}
                className={`rounded-[6px] px-2 py-1 transition-colors cursor-pointer ${
                  wordFormat === fmt
                    ? 'bg-[#0a84ff] text-white shadow-[0_1px_8px_rgba(10,132,255,0.4)]'
                    : 'text-zinc-400 hover:text-zinc-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Hex / Dec + Signed (±) */}
          <div className="inline-flex rounded-lg border border-white/[0.065] bg-[#101115] p-0.5 font-mono text-[11px]">
            <button
              type="button"
              onClick={() => setNumberBase((b) => (b === 'hex' ? 'dec' : 'hex'))}
              title="Toggle Hex / Decimal display"
              className="rounded-[6px] px-2 py-1 text-zinc-300 hover:bg-white/[0.08] cursor-pointer"
            >
              {numberBase === 'hex' ? 'Hex' : 'Dec'}
            </button>
            <button
              type="button"
              onClick={() => setIsSigned((s) => !s)}
              title="Toggle Signed (±) / Unsigned"
              className={`rounded-[6px] px-1.5 py-1 transition-colors cursor-pointer ${
                isSigned ? 'bg-[#0a84ff]/25 text-sky-200' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              ±
            </button>
          </div>

          {/* Free Column Count (1–32, WinOLS M / W keys) */}
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
              className="w-8 bg-transparent text-center text-zinc-100 outline-none [appearance:textfield]"
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

          {/* Free Byte Shift (Align columns arbitrarily · shortcuts [ / ]) */}
          <div
            className="inline-flex items-center rounded-lg border border-white/[0.065] bg-[#101115] p-0.5 font-mono text-[11px]"
            title="Shift row start by bytes (shortcuts [ / ] · click value to reset)"
          >
            <button
              type="button"
              onClick={() => setByteShift((s) => (s - 1 + rowBytes) % Math.max(1, rowBytes))}
              className="rounded px-1.5 py-0.5 text-zinc-400 hover:bg-white/[0.08] hover:text-white cursor-pointer"
            >
              ◀
            </button>
            <button
              type="button"
              onClick={() => setByteShift(0)}
              className={`px-1.5 py-0.5 tabular-nums cursor-pointer ${
                byteShift !== 0 ? 'text-amber-300 font-semibold' : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="Click to reset shift to +0"
            >
              +{byteShift}B
            </button>
            <button
              type="button"
              onClick={() => setByteShift((s) => (s + 1) % Math.max(1, rowBytes))}
              className="rounded px-1.5 py-0.5 text-zinc-400 hover:bg-white/[0.08] hover:text-white cursor-pointer"
            >
              ▶
            </button>
          </div>

          {compareBin && (
            <button
              type="button"
              onClick={handleAutoSyncCompare}
              title="Auto-align comparison BIN offset (±32 KB window)"
              className={`rounded-lg border px-2 py-1 font-mono text-[10.5px] transition-colors cursor-pointer ${
                compareShift !== 0
                  ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                  : 'border-white/[0.065] bg-[#101115] text-zinc-400 hover:text-zinc-100'
              }`}
            >
              Sync {compareShift >= 0 ? `+${compareShift}` : compareShift}B
            </button>
          )}
        </div>

        {/* Right group: Diffs Only + Diff Nav + XREF/Disasm Drawer + Go To */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!compareBin}
            onClick={() => {
              setDiffsOnly((v) => !v);
              scrollToDisplayRow(0);
            }}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              !compareBin
                ? 'cursor-not-allowed border-white/[0.04] bg-white/[0.02] text-zinc-600'
                : diffsOnly
                  ? 'border-[#0a84ff]/50 bg-[#0a84ff]/20 text-sky-200'
                  : 'border-white/[0.065] bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08]'
            }`}
          >
            <Filter className="h-3.5 w-3.5" />
            Diffs Only
          </button>

          {compareBin ? (
            <div className="inline-flex items-center gap-1 rounded-lg border border-white/[0.065] bg-[#101115] px-1.5 py-0.5">
              <button
                type="button"
                onClick={() => jumpDiff(-1)}
                disabled={diffStats.clusters.length === 0}
                title="Previous Diff"
                className="rounded p-1 text-zinc-300 hover:bg-white/[0.08] disabled:opacity-35"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <span className="px-1 font-mono text-[11px] font-semibold text-sky-300 tabular-nums">
                {diffStats.totalDiffBytes.toLocaleString()} Δ
              </span>
              <button
                type="button"
                onClick={() => jumpDiff(1)}
                disabled={diffStats.clusters.length === 0}
                title="Next Diff"
                className="rounded p-1 text-zinc-300 hover:bg-white/[0.08] disabled:opacity-35"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}

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
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              drawerOpen
                ? 'border-[#0a84ff]/60 bg-[#0a84ff]/25 text-sky-100'
                : 'border-white/[0.065] bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08]'
            }`}
          >
            <Cpu className="h-3.5 w-3.5" />
            Code
          </button>

          <form onSubmit={handleGotoSubmit} className="relative flex items-center">
            <Navigation className="pointer-events-none absolute left-2.5 h-3 w-3 text-zinc-500" />
            <input
              type="text"
              value={gotoInput}
              onChange={(e) => setGotoInput(e.target.value)}
              placeholder="Go To 0x…"
              className="w-28 rounded-lg border border-white/[0.065] bg-[#101115] py-1 pr-2 pl-7 font-mono text-[11px] text-zinc-100 placeholder-zinc-500 outline-none transition-colors focus:border-[#0a84ff]"
            />
          </form>
        </div>
      </div>

      {/* Column Headers */}
      <div className="grid shrink-0 grid-cols-[72px_1fr_28px_1fr_180px] items-center border-b border-white/[0.065] bg-[#17181d]/85 px-3 py-1.5 text-[11px] font-medium text-zinc-400">
        <div className="font-mono text-zinc-500">Address</div>
        <div className="flex items-center gap-2 truncate pr-2">
          <span className="h-1.5 w-1.5 rounded-full bg-[#0a84ff] shadow-[0_0_6px_rgba(10,132,255,0.8)]" />
          <span className="truncate text-zinc-100">BIN · {binName}</span>
        </div>
        <div className="flex justify-center text-zinc-500">
          <GitCompareArrows className="h-3.5 w-3.5" />
        </div>
        <div className="flex items-center gap-2 truncate px-2">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              compareBin ? 'bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.75)]' : 'bg-zinc-600'
            }`}
          />
          <span className="truncate text-zinc-300">
            {compareBin ? `Comparison · ${compareName}` : 'No Comparison Loaded'}
          </span>
        </div>
        <div className="flex items-center gap-1.5 pl-2 text-zinc-400">
          <Layers className="h-3 w-3 text-[#0a84ff]" />
          XDF Map / Detected
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

                return (
                  <div
                    key={displayIdx}
                    style={{
                      position: 'absolute',
                      top: topPx,
                      left: 0,
                      right: 0,
                      height: ROW_HEIGHT,
                    }}
                    className="grid grid-cols-[72px_1fr_28px_1fr_180px] items-center border-b border-white/[0.03] px-3 hover:bg-white/[0.025]"
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

                        const diff = isWordDiff(bin, compareBin, off, wordBytes);
                        const span = findCandidateAt(off);
                        const xdfSpan = findXdfAt(off);
                        const selected =
                          selectedRange !== null &&
                          off < selectedRange[1] &&
                          off + wordBytes > selectedRange[0];

                        // Crisp block perimeter outline calculation for detected map candidates & XDF maps
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
                          const inBlock = (a: number) => a >= activeSpan.start && a < activeSpan.end;
                          const edgeTop = !inBlock(off - rowBytes);
                          const edgeBottom = !inBlock(off + rowBytes);
                          const edgeLeft = colIdx === 0 || !inBlock(off - wordBytes);
                          const edgeRight = colIdx === colCount - 1 || !inBlock(off + wordBytes);

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
                          : diff
                            ? 'bg-[#0a84ff]/30 text-sky-100 rounded-[4px] ring-1 ring-[#0a84ff]/45'
                            : span?.role === 'data'
                              ? 'bg-amber-500/[0.09] text-amber-100 rounded-[3px]'
                              : span?.role === 'axis'
                                ? 'bg-zinc-200/[0.07] text-zinc-200 rounded-[3px] ring-1 ring-white/[0.12]'
                                : xdfSpan
                                  ? 'bg-[#0a84ff]/[0.08] text-zinc-100 rounded-[3px]'
                                  : 'text-zinc-300 rounded-[4px] hover:bg-white/[0.08]';

                        return (
                          <span
                            key={colIdx}
                            style={outlineStyle}
                            onMouseDown={(e) => {
                              if (e.button !== 0) return;
                              dragAnchorRef.current = off;
                              onSelectRange([off, Math.min(bin.length, off + wordBytes)]);
                            }}
                            onMouseEnter={(e) => {
                              setHover({
                                address: off,
                                candidate: span?.candidate ?? null,
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
                              });
                            }}
                            className={`inline-flex h-[21px] cursor-pointer items-center justify-center text-[11.5px] transition-colors ${cellWidthCls} ${cellCls}`}
                          >
                            {readWordHex(bin, off, wordFormat, numberBase, isSigned)}
                          </span>
                        );
                      })}
                    </div>

                    {/* Center Diff indicator */}
                    <div className="flex justify-center">
                      {compareBin &&
                      Array.from({ length: colCount }, (_, i) =>
                        isWordDiff(bin, compareBin, address + byteShift + i * wordBytes, wordBytes),
                      ).some(Boolean) ? (
                        <span className="h-1.5 w-1.5 rounded-full bg-[#0a84ff] shadow-[0_0_8px_rgba(10,132,255,0.9)]" />
                      ) : (
                        <span className="text-[10px] text-zinc-700">·</span>
                      )}
                    </div>

                    {/* Comparison BIN cells */}
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
                          const diff = isWordDiff(bin, compareBin, off, wordBytes);
                          const selected =
                            selectedRange !== null &&
                            off < selectedRange[1] &&
                            off + wordBytes > selectedRange[0];

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
                                setContextMenu({
                                  x: e.clientX,
                                  y: e.clientY,
                                  address: off,
                                  candidate: span?.candidate ?? null,
                                });
                              }}
                              className={`inline-flex h-[21px] cursor-pointer items-center justify-center rounded-[4px] text-[11.5px] transition-colors ${cellWidthCls} ${
                                selected
                                  ? 'bg-amber-500/30 text-amber-100 ring-1 ring-amber-400/70'
                                  : diff
                                    ? 'bg-[#0a84ff]/30 text-sky-100 ring-1 ring-[#0a84ff]/45'
                                    : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-300'
                              }`}
                            >
                              {readWordHex(compareBin, cmpOff, wordFormat, numberBase, isSigned)}
                            </span>
                          );
                        })
                      ) : (
                        <span className="text-[11px] text-zinc-600 italic">
                          Load a comparison BIN to inspect byte diffs
                        </span>
                      )}
                    </div>

                    {/* XDF Map / Detected Candidate Annotation Column */}
                    <div className="flex items-center gap-1 overflow-hidden pl-2">
                      {xdf ? (
                        <button
                          type="button"
                          onClick={() => onSelectXdfItem(xdf.id)}
                          title={xdf.title}
                          className="truncate rounded-md border border-[#0a84ff]/35 bg-[#0a84ff]/15 px-2 py-0.5 font-sans text-[10.5px] font-medium text-sky-200 transition-colors hover:bg-[#0a84ff]/28"
                        >
                          {xdf.title}
                        </button>
                      ) : cand ? (
                        <button
                          type="button"
                          onClick={() => onAddCandidateToXdf(cand, true)}
                          title="Click to add candidate to XDF & open in Table Editor"
                          className="inline-flex items-center gap-1 truncate rounded-md border border-dashed border-amber-400/50 bg-amber-500/[0.12] px-2 py-0.5 font-sans text-[10.5px] font-medium text-amber-200 transition-colors hover:bg-amber-500/22"
                        >
                          <Sparkles className="h-2.5 w-2.5 shrink-0 text-amber-400" />
                          <span className="truncate">
                            {cand.rows}×{cand.cols} · {Math.round(cand.confidence * 100)}%
                          </span>
                        </button>
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
            {/* Drawer Header */}
            <div className="flex items-center justify-between gap-2 border-b border-white/[0.065] px-3 py-2.5">
              <div className="inline-flex rounded-lg border border-white/[0.065] bg-[#101115] p-0.5 text-[11px] font-medium">
                <button
                  type="button"
                  onClick={() => setDrawerTab('xrefs')}
                  className={`inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 transition-colors ${
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
                  className={`inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 transition-colors ${
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
                  className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-white/[0.08] hover:text-zinc-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Drawer Body */}
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
                        Try scanning a map start address or switch to the Disassembler tab to inspect nearby code.
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
                          className="group cursor-pointer rounded-lg border border-white/[0.065] bg-[#101115] p-2.5 transition-colors hover:border-[#0a84ff]/50 hover:bg-[#101115]/90"
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
                              className="rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-zinc-300 opacity-80 transition-colors hover:border-[#0a84ff]/50 hover:bg-[#0a84ff]/20 hover:text-sky-100 group-hover:opacity-100"
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
                {/* Disasm controls */}
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
                        className={`rounded px-1.5 py-0.5 transition-colors ${
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
                      className="rounded border border-white/[0.065] bg-white/[0.04] p-1 text-zinc-300 hover:bg-white/[0.08]"
                    >
                      <ChevronLeft className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setDrawerAddress((prev) => Math.min(Math.max(0, bin.length - 4), prev + 64))
                      }
                      title="Step forward 64 bytes"
                      className="rounded border border-white/[0.065] bg-white/[0.04] p-1 text-zinc-300 hover:bg-white/[0.08]"
                    >
                      <ChevronRight className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                {/* Disasm listing */}
                <div className="min-h-0 flex-1 overflow-y-auto bg-[#101115] p-2 font-mono text-[11px] tabular-nums">
                  {disasmLines.map((ins) => {
                    const isAnchor = ins.address === drawerAddress;
                    return (
                      <div
                        key={ins.address}
                        onClick={() => {
                          scrollToAddress(ins.address);
                          onSelectRange([ins.address, Math.min(bin.length, ins.address + ins.size)]);
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

      {/* Bottom Status Bar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-white/[0.065] bg-[#17181d] px-3 py-1.5 text-[11px]">
        <div className="flex flex-wrap items-center gap-3 font-mono text-zinc-400 tabular-nums">
          {hoveredInfo ? (
            <>
              <span className="font-semibold text-sky-300">
                0x{formatHexAddr(hoveredInfo.addr)}
              </span>
              <span>
                U8: <strong className="text-zinc-100">{hoveredInfo.u8}</strong>
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

        {/* Quick selection action buttons */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={!hasSelection}
            onClick={handleCopyHex}
            className="inline-flex items-center gap-1 rounded-md border border-white/[0.065] bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-zinc-200 transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Copy className="h-3 w-3" />
            Copy Hex
          </button>
          <button
            type="button"
            disabled={!hasSelection || !compareBin}
            onClick={handleCopyFromCompare}
            className="inline-flex items-center gap-1 rounded-md border border-[#0a84ff]/35 bg-[#0a84ff]/15 px-2 py-1 text-[11px] font-medium text-sky-200 transition-colors hover:bg-[#0a84ff]/28 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <ArrowLeft className="h-3 w-3" />
            Cmp
          </button>
          <button
            type="button"
            disabled={!hasSelection}
            onClick={() => {
              if (selectedRange) onFindTwins(selectedRange);
            }}
            className="inline-flex items-center gap-1 rounded-md border border-white/[0.065] bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-zinc-200 transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Search className="h-3 w-3" />
            Twins
          </button>
          <button
            type="button"
            disabled={!hasSelection}
            onClick={handleMapFromSelection}
            className="inline-flex items-center gap-1 rounded-md border border-amber-400/35 bg-amber-500/15 px-2 py-1 text-[11px] font-medium text-amber-200 transition-colors hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <PlusSquare className="h-3 w-3" />
            Map from Selection…
          </button>
        </div>
      </div>

      {/* Synced 2D Waveform Plotter */}
      <Waveform2D
        bin={bin}
        compareBin={compareBin}
        windowStart={windowStartAddress}
        wordFormat={wordFormat}
        candidates={candidates}
        definition={definition}
        selectedRange={selectedRange}
        onJumpAddress={scrollToAddress}
      />

      {/* Floating Liquid Glass Mini-HUD when hovering over a detected MapCandidate */}
      {hover?.candidate && !contextMenu ? (
        <HexMiniHud
          candidate={hover.candidate}
          bin={bin}
          compareBin={compareBin}
          anchorX={hover.clientX}
          anchorY={hover.clientY}
        />
      ) : null}

      {/* Right-click Liquid Glass Context Menu */}
      {contextMenu ? (
        <HexContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          address={contextMenu.address}
          candidate={contextMenu.candidate}
          selectedRange={selectedRange}
          hasCompare={compareBin !== null}
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
          onFindTwins={() => {
            if (selectedRange) onFindTwins(selectedRange);
          }}
          onFindXRefs={() => {
            const target = contextMenu.candidate?.address ?? contextMenu.address;
            openDrawerAt(target, 'xrefs');
          }}
          onDisassembleHere={() => {
            openDrawerAt(contextMenu.address, 'disasm');
          }}
        />
      ) : null}
    </div>
  );
};
