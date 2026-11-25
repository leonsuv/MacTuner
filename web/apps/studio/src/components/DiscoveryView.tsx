import React, { useMemo, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  Binary,
  CheckCircle2,
  Download,
  FileWarning,
  Layers,
  Package,
  Pencil,
  Plus,
  Radar,
  ScanSearch,
  Search,
  Sparkles,
  Upload,
} from 'lucide-react';
import {
  BinCodec,
  ContentPortMatch,
  DataLayout,
  DtcEntry,
  DtcScanResult,
  IDENTITY_SCALING,
  MtPatchPackage,
  Patch,
  PortingMatch,
  XDFDefinition,
  XDFItem,
  applyMtPatch,
  applyPortedTune,
  buildPortedXdf,
  contentPortScan,
  correlateXdfToTargetBin,
  createDtcXdfFlag,
  exportDefinition,
  extractMtPatch,
  identifyECU,
  parseBinaryFile,
  scanDtcs,
  toggleDtc,
} from '@mactuner/core';
import type { MapCandidate } from './Sidebar';

export type DiscoverySubTab = 'finder' | 'dtc' | 'porting' | 'batch';
type ScanWidth = '8' | '16' | 'f32';
type DtcFilter = 'all' | 'active' | 'disabled';
type PortingMode = 'xdf' | 'content';
type TransferMode = 'absolute' | 'delta' | 'percent';

export interface DtcMatch {
  code: string;
  rawValue: number;
  address: number;
  classByteAddress?: number;
  classValue?: number;
  status: 'Active' | 'Masked (Off)';
  description: string;
}

export interface DiscoveryViewProps {
  bytes: Uint8Array;
  baselineBytes: Uint8Array | null;
  xdf: XDFDefinition | null;
  candidates: MapCandidate[];
  onCandidatesChange?: (candidates: MapCandidate[]) => void;
  onShowInHex: (address: number) => void;
  onAddCandidateToXdf: (candidate: MapCandidate) => void;
  onPortMaps?: (itemIds: number[]) => void;
  onOpenXdfModal?: (item: XDFItem) => void;
  onPatchBytes?: (patches: Patch[], label: string) => void;
  onReplaceBytes?: (nextBytes: Uint8Array, label: string) => void;
  onAddXdfItem?: (item: XDFItem) => void;
  fileName?: string;
}

const KNOWN_DTC_DESCRIPTIONS: Record<string, string> = {
  P0101: 'Mass Air Flow Circuit Range/Performance',
  P0102: 'Mass Air Flow Circuit Low Input',
  P0113: 'Intake Air Temp Sensor 1 Circuit High',
  P0130: 'O2 Sensor Circuit Bank 1 Sensor 1',
  P0136: 'O2 Sensor Circuit Bank 1 Sensor 2',
  P0141: 'O2 Sensor Heater Circuit Bank 1 Sensor 2',
  P0171: 'System Too Lean Bank 1',
  P0172: 'System Too Rich Bank 1',
  P0234: 'Turbocharger Overboost Condition',
  P0299: 'Turbocharger Underboost Condition',
  P0300: 'Random/Multiple Cylinder Misfire Detected',
  P0301: 'Cylinder 1 Misfire Detected',
  P0401: 'Exhaust Gas Recirculation Flow Insufficient',
  P0420: 'Catalyst System Efficiency Below Threshold',
  P0441: 'Evaporative Emission System Incorrect Purge Flow',
  P0507: 'Idle Air Control System RPM Higher Than Expected',
  P0607: 'Control Module Performance (Anchor)',
  P2004: 'Intake Manifold Runner Control Stuck Open',
  P2015: 'Intake Manifold Runner Position Sensor Range',
  P2187: 'System Too Lean at Idle Bank 1',
  P2270: 'O2 Sensor Signal Biased/Stuck Lean Bank 1 S2',
};

function formatHex(addr: number): string {
  return `0x${Math.max(0, addr).toString(16).toUpperCase().padStart(5, '0')}`;
}

function triggerDownload(
  data: Uint8Array | string,
  filename: string,
  mime = 'application/octet-stream',
) {
  const part: BlobPart = typeof data === 'string' ? data : data.slice().buffer;
  const blob = new Blob([part], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Luxury jewel-tile thermal palette: sapphire -> cyan -> emerald -> amber -> ruby */
function jewelTileStyle(tRaw: number): React.CSSProperties {
  const t = Math.max(0, Math.min(1, Number.isFinite(tRaw) ? tRaw : 0.5));
  const stops: [number, number, number][] = [
    [24, 64, 168],
    [14, 148, 196],
    [16, 168, 114],
    [224, 154, 18],
    [217, 56, 68],
  ];
  const scaled = t * (stops.length - 1);
  const idx = Math.min(stops.length - 2, Math.floor(scaled));
  const frac = scaled - idx;
  const a = stops[idx];
  const b = stops[idx + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * frac);
  const g = Math.round(a[1] + (b[1] - a[1]) * frac);
  const bl = Math.round(a[2] + (b[2] - a[2]) * frac);

  const hiR = Math.min(255, r + 26);
  const hiG = Math.min(255, g + 26);
  const hiB = Math.min(255, bl + 26);
  const loR = Math.max(0, r - 24);
  const loG = Math.max(0, g - 24);
  const loB = Math.max(0, bl - 24);

  return {
    background: `linear-gradient(180deg, rgba(${hiR},${hiG},${hiB},0.84) 0%, rgba(${loR},${loG},${loB},0.72) 100%)`,
    borderColor: `rgba(${hiR},${hiG},${hiB},0.35)`,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.22)',
  };
}

type LocalMapCandidate = MapCandidate & { isFloat?: boolean };

function scanBinForMaps(
  bytes: Uint8Array,
  baseline: Uint8Array | null,
  width: ScanWidth,
  signed: boolean,
  lsbFirst: boolean,
): LocalMapCandidate[] {
  const isFloat = width === 'f32';
  const bits = width === 'f32' ? 32 : width === '16' ? 16 : 8;
  const elemBytes = bits / 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const results: LocalMapCandidate[] = [];
  const usedRanges: Array<[number, number]> = [];

  const overlaps = (start: number, end: number) =>
    usedRanges.some(([s, e]) => start < e && end > s);

  if (isFloat) {
    const readF = (off: number): number => view.getFloat32(off, lsbFirst);
    const plausibleF = (v: number): boolean =>
      Number.isFinite(v) && Math.abs(v) < 1e6 && (v === 0 || Math.abs(v) > 1e-5);

    for (let off = 0; off + 64 * 4 <= bytes.length && results.length < 36; off += 4) {
      if (overlaps(off, off + 64 * 4)) continue;
      // Check for 8x8 or 6x6 smooth IEEE-754 float table
      const rows = 8;
      const cols = 8;
      const endAddr = off + rows * cols * 4;
      if (endAddr > bytes.length) break;

      let ok = true;
      let minV = Infinity;
      let maxV = -Infinity;
      let nonZero = 0;
      let diffSum = 0;
      let diffCount = 0;

      for (let r = 0; r < rows && ok; r++) {
        for (let c = 0; c < cols; c++) {
          const v = readF(off + (r * cols + c) * 4);
          if (!plausibleF(v)) {
            ok = false;
            break;
          }
          if (Math.abs(v) > 1e-5) nonZero++;
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
          if (c > 0) {
            const prev = readF(off + (r * cols + c - 1) * 4);
            diffSum += Math.abs(v - prev);
            diffCount++;
          }
        }
      }
      if (!ok || nonZero < rows * cols * 0.5) continue;
      const span = maxV - minV;
      if (span <= 1e-4 || !Number.isFinite(span)) continue;
      const avgStep = diffCount > 0 ? diffSum / diffCount : span;
      const smoothness = 1 - Math.min(1, avgStep / Math.max(1e-4, span));
      if (smoothness < 0.65) continue;

      let hasDiff = false;
      if (baseline && baseline.length >= endAddr) {
        for (let k = off; k < endAddr; k++) {
          if (bytes[k] !== baseline[k]) {
            hasDiff = true;
            break;
          }
        }
      }

      usedRanges.push([off, endAddr]);
      results.push({
        id: `f32-${off.toString(16)}-${rows}x${cols}`,
        address: off,
        rows,
        cols,
        bits: 32,
        signed: true,
        lsbFirst,
        isFloat: true,
        confidence: Math.min(0.95, 0.72 + smoothness * 0.22),
        patternLabel: `IEEE-754 Float32 ${rows}×${cols}${hasDiff ? ' · Diff' : ''}`,
        hasHeaderProof: false,
        hasAxes: false,
        hasDiff,
        domainHint: 'Float32 Calibration Surface',
      });
      off = endAddr - 4;
    }
    return results.sort((a, b) => b.confidence - a.confidence);
  }

  const readVal = (off: number): number => {
    if (bits === 16) return signed ? view.getInt16(off, lsbFirst) : view.getUint16(off, lsbFirst);
    return signed ? view.getInt8(off) : view.getUint8(off);
  };

  const readU = (off: number): number => {
    if (bits === 16) return view.getUint16(off, lsbFirst);
    return view.getUint8(off);
  };

  const isMonotonic = (off: number, count: number): boolean => {
    if (off + count * elemBytes > bytes.length) return false;
    let prev = readVal(off);
    let rises = 0;
    for (let i = 1; i < count; i++) {
      const cur = readVal(off + i * elemBytes);
      if (cur < prev) return false;
      if (cur > prev) rises++;
      prev = cur;
    }
    return rises >= Math.max(2, Math.floor(count * 0.6));
  };

  for (let off = 0; off + 32 * elemBytes < bytes.length; off += elemBytes) {
    const r = readU(off);
    const c = readU(off + elemBytes);
    if (r < 4 || r > 24 || c < 4 || c > 24) continue;
    const yAxisAddr = off + 2 * elemBytes;
    const xAxisAddr = yAxisAddr + r * elemBytes;
    const dataAddr = xAxisAddr + c * elemBytes;
    const endAddr = dataAddr + r * c * elemBytes;
    if (endAddr > bytes.length || overlaps(off, endAddr)) continue;
    if (!isMonotonic(yAxisAddr, r) || !isMonotonic(xAxisAddr, c)) continue;

    let minV = Infinity;
    let maxV = -Infinity;
    let diffSum = 0;
    let diffCount = 0;
    for (let row = 0; row < r; row++) {
      for (let col = 0; col < c; col++) {
        const v = readVal(dataAddr + (row * c + col) * elemBytes);
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
        if (col > 0) {
          const prev = readVal(dataAddr + (row * c + col - 1) * elemBytes);
          diffSum += Math.abs(v - prev);
          diffCount++;
        }
      }
    }
    const span = maxV - minV;
    if (span <= 0) continue;
    const avgStep = diffCount > 0 ? diffSum / diffCount : span;
    const smoothness = 1 - Math.min(1, avgStep / Math.max(1, span));
    if (smoothness < 0.35) continue;

    let hasDiff = false;
    if (baseline && baseline.length >= endAddr) {
      for (let k = dataAddr; k < endAddr; k++) {
        if (bytes[k] !== baseline[k]) {
          hasDiff = true;
          break;
        }
      }
    }

    usedRanges.push([off, endAddr]);
    results.push({
      id: `bosch-${dataAddr.toString(16)}-${r}x${c}`,
      address: dataAddr,
      headerAddress: off,
      rows: r,
      cols: c,
      bits,
      signed,
      lsbFirst,
      confidence: Math.min(0.99, 0.84 + smoothness * 0.14),
      patternLabel: `Bosch ${r}×${c} + Axes${hasDiff ? ' · Diff' : ''}`,
      hasHeaderProof: true,
      hasAxes: true,
      hasDiff,
      xAxisAddress: xAxisAddr,
      yAxisAddress: yAxisAddr,
      domainHint: r >= 12 && c >= 12 ? 'Primary Calibration Surface' : 'Bosch 2D Table',
    });
    if (results.length >= 48) break;
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}

function candidateToDraftXdfItem(cand: MapCandidate): XDFItem {
  const isFloat = cand.bits === 32;
  const xLayout: DataLayout | null =
    cand.xAxisAddress !== undefined
      ? {
          address: cand.xAxisAddress,
          bits: cand.bits,
          signed: cand.signed,
          lsbFirst: cand.lsbFirst,
          columnMajor: false,
          isFloat,
          rows: 1,
          cols: cand.cols,
        }
      : null;
  const yLayout: DataLayout | null =
    cand.yAxisAddress !== undefined
      ? {
          address: cand.yAxisAddress,
          bits: cand.bits,
          signed: cand.signed,
          lsbFirst: cand.lsbFirst,
          columnMajor: false,
          isFloat,
          rows: 1,
          cols: cand.rows,
        }
      : null;

  return {
    id: Math.floor(Date.now() % 1_000_000) + cand.address,
    title: `${cand.domainHint ?? 'Detected Map'} @ ${formatHex(cand.address)}`,
    description: cand.patternLabel ?? `Auto-detected ${cand.rows}×${cand.cols} map`,
    categories: [],
    itemKind: {
      kind: 'table',
      x: {
        source: xLayout ? { kind: 'data', layout: xLayout } : { kind: 'none' },
        count: cand.cols,
        scaling: IDENTITY_SCALING,
      },
      y: {
        source: yLayout ? { kind: 'data', layout: yLayout } : { kind: 'none' },
        count: cand.rows,
        scaling: IDENTITY_SCALING,
      },
    },
    data: {
      address: cand.address,
      bits: cand.bits,
      signed: cand.signed,
      lsbFirst: cand.lsbFirst,
      columnMajor: false,
      isFloat,
      rows: cand.rows,
      cols: cand.cols,
    },
    scaling: IDENTITY_SCALING,
  };
}

export const DiscoveryView: React.FC<DiscoveryViewProps> = ({
  bytes,
  baselineBytes,
  xdf,
  candidates,
  onCandidatesChange,
  onShowInHex,
  onAddCandidateToXdf,
  onPortMaps,
  onOpenXdfModal,
  onPatchBytes,
  onReplaceBytes,
  onAddXdfItem,
  fileName = 'ecu_active.bin',
}) => {
  const [subTab, setSubTab] = useState<DiscoverySubTab>('finder');

  // --- Map Finder state ---
  const [scanWidth, setScanWidth] = useState<ScanWidth>('16');
  const [signed, setSigned] = useState(false);
  const [lsbFirst, setLsbFirst] = useState(true);
  const [localCandidates, setLocalCandidates] = useState<LocalMapCandidate[] | null>(null);
  const effectiveCandidates: LocalMapCandidate[] = localCandidates ?? candidates;
  const [selectedCandId, setSelectedCandId] = useState<string | null>(candidates[0]?.id ?? null);
  const [hoveredTile, setHoveredTile] = useState<{ r: number; c: number; val: number } | null>(null);

  // --- DTC Scanner state (real core dtcEngine) ---
  const [dtcScan, setDtcScan] = useState<DtcScanResult | null>(null);
  const [dtcScanned, setDtcScanned] = useState(false);
  const [dtcFilter, setDtcFilter] = useState<DtcFilter>('all');
  const [dtcQuery, setDtcQuery] = useState('');
  const [dtcNotice, setDtcNotice] = useState<string | null>(null);

  // --- Tune Porting state ---
  const [portingMode, setPortingMode] = useState<PortingMode>('xdf');
  const [transferMode, setTransferMode] = useState<TransferMode>('delta');
  const [targetBin, setTargetBin] = useState<Uint8Array | null>(null);
  const [targetBinName, setTargetBinName] = useState<string>('');
  const [xdfMatches, setXdfMatches] = useState<PortingMatch[]>([]);
  const [portedMessage, setPortedMessage] = useState<string | null>(null);
  const targetBinInputRef = useRef<HTMLInputElement | null>(null);

  // 2-Anchor Content Port state
  const [cpSrcStock, setCpSrcStock] = useState<Uint8Array | null>(null);
  const [cpSrcStockName, setCpSrcStockName] = useState<string>('Active Baseline');
  const [cpSrcMod, setCpSrcMod] = useState<Uint8Array | null>(null);
  const [cpSrcModName, setCpSrcModName] = useState<string>('Active BIN');
  const [cpTargetStock, setCpTargetStock] = useState<Uint8Array | null>(null);
  const [cpTargetName, setCpTargetName] = useState<string>('');
  const [cpTolerance, setCpTolerance] = useState<number>(2);
  const [cpUniqueOnly, setCpUniqueOnly] = useState<boolean>(false);
  const [cpMatches, setCpMatches] = useState<ContentPortMatch[]>([]);
  const cpStockRef = useRef<HTMLInputElement | null>(null);
  const cpModRef = useRef<HTMLInputElement | null>(null);
  const cpTargetRef = useRef<HTMLInputElement | null>(null);

  // --- Batch Tuner (.mtpatch) state ---
  const [patchName, setPatchName] = useState<string>('Stage 1 Tune Package');
  const [patchAuthor, setPatchAuthor] = useState<string>('');
  const [patchDesc, setPatchDesc] = useState<string>('');
  const [loadedPatch, setLoadedPatch] = useState<MtPatchPackage | null>(null);
  const [batchApplyMode, setBatchApplyMode] = useState<TransferMode>('delta');
  const [batchQueue, setBatchQueue] = useState<
    Array<{
      id: string;
      name: string;
      bytes: Uint8Array;
      result?: { bytes: Uint8Array; appliedMaps: number; skippedMaps: number };
    }>
  >([]);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const [batchDragging, setBatchDragging] = useState(false);
  const mtPatchInputRef = useRef<HTMLInputElement | null>(null);
  const batchBinInputRef = useRef<HTMLInputElement | null>(null);

  const selectedCandidate = useMemo(
    () => effectiveCandidates.find((c) => c.id === selectedCandId) ?? effectiveCandidates[0] ?? null,
    [effectiveCandidates, selectedCandId],
  );

  const previewMatrix = useMemo(() => {
    if (!selectedCandidate) return null;
    const isFloat = Boolean(selectedCandidate.isFloat) || selectedCandidate.bits === 32;
    const layout: DataLayout = {
      address: selectedCandidate.address,
      bits: selectedCandidate.bits,
      signed: selectedCandidate.signed,
      lsbFirst: selectedCandidate.lsbFirst,
      columnMajor: false,
      isFloat,
      rows: selectedCandidate.rows,
      cols: selectedCandidate.cols,
    };
    const grid: number[][] = [];
    let min = Infinity;
    let max = -Infinity;
    for (let r = 0; r < layout.rows; r++) {
      const row: number[] = [];
      for (let c = 0; c < layout.cols; c++) {
        const v = BinCodec.raw(layout, { r, c }, bytes) ?? 0;
        const safe = Number.isFinite(v) ? v : 0;
        if (safe < min) min = safe;
        if (safe > max) max = safe;
        row.push(safe);
      }
      grid.push(row);
    }
    return { grid, min, max, isFloat };
  }, [selectedCandidate, bytes]);

  const dtcStats = useMemo(() => {
    const entries = dtcScan?.entries ?? [];
    let active = 0;
    let disabled = 0;
    for (const e of entries) {
      if (e.isDisabled) disabled++;
      else active++;
    }
    return { total: entries.length, active, disabled };
  }, [dtcScan]);

  const filteredDtcs = useMemo(() => {
    if (!dtcScan) return null;
    const q = dtcQuery.trim().toLowerCase();
    return dtcScan.entries.filter((e) => {
      if (dtcFilter === 'active' && e.isDisabled) return false;
      if (dtcFilter === 'disabled' && !e.isDisabled) return false;
      if (!q) return true;
      const desc = (KNOWN_DTC_DESCRIPTIONS[e.pCode] ?? '').toLowerCase();
      return (
        e.pCode.toLowerCase().includes(q) ||
        desc.includes(q) ||
        formatHex(e.codeAddress).toLowerCase().includes(q) ||
        formatHex(e.switchAddress).toLowerCase().includes(q)
      );
    });
  }, [dtcScan, dtcFilter, dtcQuery]);

  // --- Handlers ---
  const handleScanBin = () => {
    const found = scanBinForMaps(bytes, baselineBytes, scanWidth, signed, lsbFirst);
    setLocalCandidates(found);
    onCandidatesChange?.(found);
    setSelectedCandId(found[0]?.id ?? null);
  };

  const handleEditInXdf = (cand: LocalMapCandidate) => {
    const withFloat: LocalMapCandidate = { ...cand, isFloat: cand.bits === 32 };
    if (onOpenXdfModal) {
      onOpenXdfModal(candidateToDraftXdfItem(withFloat));
    } else {
      onAddCandidateToXdf(withFloat);
    }
  };

  const handleScanDtcs = () => {
    const res = scanDtcs(bytes);
    setDtcScanned(true);
    setDtcScan(res);
    setDtcNotice(
      res.entries.length > 0
        ? `Detected ${res.entries.length} DTCs (${res.familyHint}, ${res.endianness}, stride ${res.stride}B${res.p0607Anchored ? ', P0607-anchored' : ''}).`
        : 'Scanned BIN — 0 OEM DTC switch tables detected in this binary.',
    );
  };

  const handleLoadSampleMed17Dtcs = () => {
    const baseCodeAddr = Math.min(Math.max(0, bytes.length - 64), 0x1a000);
    const baseSwitchAddr = Math.min(Math.max(0, bytes.length - 32), 0x1a800);
    const sampleCodes: Array<{ pCode: string; raw: number; cls: number }> = [
      { pCode: 'P0101', raw: 0x0101, cls: 0x03 },
      { pCode: 'P0136', raw: 0x0136, cls: 0x02 },
      { pCode: 'P0141', raw: 0x0141, cls: 0x02 },
      { pCode: 'P0234', raw: 0x0234, cls: 0x04 },
      { pCode: 'P0299', raw: 0x0299, cls: 0x04 },
      { pCode: 'P0420', raw: 0x0420, cls: 0x01 },
      { pCode: 'P0607', raw: 0x0607, cls: 0x05 },
      { pCode: 'P2015', raw: 0x2015, cls: 0x03 },
      { pCode: 'P2270', raw: 0x2270, cls: 0x02 },
    ];
    const entries: DtcEntry[] = sampleCodes.map((s, idx) => {
      const swAddr = Math.min(Math.max(0, bytes.length - 1), baseSwitchAddr + idx);
      const curVal = bytes.length > swAddr ? bytes[swAddr] : s.cls;
      return {
        id: idx + 1,
        pCode: s.pCode,
        rawCode: s.raw,
        codeAddress: Math.min(Math.max(0, bytes.length - 2), baseCodeAddr + idx * 4),
        switchAddress: swAddr,
        switchBytes: 1,
        errorClass: s.cls,
        currentValue: curVal,
        isDisabled: curVal === 0,
        tableIndex: idx,
        familyHint: 'Bosch MED17 (Sample)',
      };
    });
    setDtcScanned(true);
    setDtcScan({
      entries,
      codeTableAddress: baseCodeAddr,
      switchTableAddress: baseSwitchAddr,
      stride: 4,
      endianness: 'LE',
      familyHint: 'Bosch MED17 (Sample)',
      p0607Anchored: true,
    });
    setDtcNotice(`Loaded ${entries.length} sample Bosch MED17 DTC entries for interactive preview.`);
  };

  const handleToggleDtc = (entry: DtcEntry) => {
    const res = toggleDtc(bytes, entry);
    const label = `DTC ${entry.pCode} ${res.entry.isDisabled ? 'OFF (0x00)' : `ON (0x${res.entry.currentValue.toString(16).toUpperCase()})`} @ ${formatHex(entry.switchAddress)}`;

    if (onPatchBytes) {
      const len = entry.switchBytes === 2 ? 2 : 1;
      const oldSlice = bytes.slice(entry.switchAddress, entry.switchAddress + len);
      const nextSlice = res.bytes.slice(entry.switchAddress, entry.switchAddress + len);
      onPatchBytes([{ offset: entry.switchAddress, old: oldSlice, next: nextSlice }], label);
    } else if (onReplaceBytes) {
      onReplaceBytes(res.bytes, label);
    }

    setDtcScan((prev) =>
      prev
        ? {
            ...prev,
            entries: prev.entries.map((e) => (e.id === entry.id ? res.entry : e)),
          }
        : prev,
    );
    setDtcNotice(label);
  };

  const handleAddDtcToXdf = (entry: DtcEntry) => {
    const nextId =
      (xdf?.items.reduce((m, it) => Math.max(m, it.id), 0) ?? 1000) + 1;
    const item = createDtcXdfFlag(entry, nextId);
    if (onAddXdfItem) {
      onAddXdfItem(item);
      setDtcNotice(`Added "${item.title}" to XDF definition.`);
    } else if (onOpenXdfModal) {
      onOpenXdfModal(item);
    } else {
      const miniDef: XDFDefinition = {
        title: `DTC ${entry.pCode} Flag`,
        description: item.description,
        baseOffset: 0,
        categories: {},
        items: [item],
      };
      const xml = exportDefinition(miniDef, 'xdf');
      if (typeof xml === 'string') {
        triggerDownload(xml, `dtc_${entry.pCode.toLowerCase()}.xdf`, 'application/xml');
        setDtcNotice(`Exported "${item.title}" as XDF flag.`);
      }
    }
  };

  const handleLoadTargetBinForXdfPort = async (file: File) => {
    const raw = new Uint8Array(await file.arrayBuffer());
    const parsed = parseBinaryFile(file.name, raw);
    setTargetBin(parsed);
    setTargetBinName(file.name);
    if (xdf) {
      const matches = correlateXdfToTargetBin(xdf, baselineBytes ?? bytes, parsed);
      setXdfMatches(matches);
      const high = matches.filter((m) => m.confidence >= 0.8).length;
      setPortedMessage(`Correlated ${matches.length} XDF items to ${file.name} (${high} high-confidence ≥80%).`);
    } else {
      setPortedMessage(`Loaded target BIN "${file.name}" — load an XDF to correlate maps.`);
    }
  };

  const handleExportPortedXdf = () => {
    if (!xdf || xdfMatches.length === 0) return;
    const ported = buildPortedXdf(xdf, xdfMatches);
    const xml = exportDefinition(ported, 'xdf');
    if (typeof xml === 'string') {
      const base = (targetBinName || fileName).replace(/\.bin$/i, '');
      triggerDownload(xml, `${base}-ported.xdf`, 'application/xml');
      setPortedMessage(`Exported ${base}-ported.xdf (${xdfMatches.filter((m) => m.selected !== false).length} items).`);
    }
  };

  const handleExportPortedBin = () => {
    if (!xdf || !targetBin || xdfMatches.length === 0) return;
    const srcStock = baselineBytes ?? bytes;
    const { bytes: portedBytes, appliedCount } = applyPortedTune(
      srcStock,
      bytes,
      targetBin,
      xdf,
      xdfMatches,
      transferMode,
    );
    const ids = xdfMatches.filter((m) => m.selected !== false).map((m) => m.itemId);
    onPortMaps?.(ids);
    const base = (targetBinName || 'target').replace(/\.bin$/i, '');
    triggerDownload(portedBytes, `${base}-ported.bin`, 'application/octet-stream');
    setPortedMessage(`Exported ${base}-ported.bin — applied ${appliedCount} modified map(s) using ${transferMode} mode.`);
  };

  const handleRunContentPortScan = () => {
    const srcStock = cpSrcStock ?? baselineBytes;
    const srcMod = cpSrcMod ?? bytes;
    const tgt = cpTargetStock;
    if (!srcStock || !srcMod || !tgt) {
      setPortedMessage('Load Source Stock, Source Mod, and Target Stock BINs first.');
      return;
    }
    const found = contentPortScan(srcStock, srcMod, tgt, {
      tolerance: cpTolerance,
      uniqueOnly: cpUniqueOnly,
    });
    setCpMatches(found);
    const matched = found.filter((m) => m.targetStart !== null).length;
    setPortedMessage(`2-Anchor scan found ${found.length} changed clusters (${matched} matched in target).`);
  };

  const handleApplyContentPort = () => {
    const srcStock = cpSrcStock ?? baselineBytes;
    const srcMod = cpSrcMod ?? bytes;
    const tgt = cpTargetStock;
    if (!srcStock || !srcMod || !tgt) return;

    const selected = cpMatches.filter((m) => m.selected && m.targetStart !== null);
    if (selected.length === 0) return;

    const out = new Uint8Array(tgt);
    let patchedBytes = 0;

    for (const cl of selected) {
      const tStart = cl.targetStart!;
      const len = cl.sourceEnd - cl.sourceStart;
      for (let i = 0; i < len; i++) {
        const sIdx = cl.sourceStart + i;
        const tIdx = tStart + i;
        if (sIdx >= srcStock.length || sIdx >= srcMod.length || tIdx >= out.length) continue;
        if (srcMod[sIdx] === srcStock[sIdx]) continue;
        const orig = srcStock[sIdx];
        const mod = srcMod[sIdx];
        const curTgt = out[tIdx];
        let nextVal = mod;
        if (transferMode === 'delta') {
          nextVal = curTgt + (mod - orig);
        } else if (transferMode === 'percent') {
          nextVal = orig > 0 ? Math.round(curTgt * (mod / orig)) : curTgt + (mod - orig);
        }
        out[tIdx] = Math.max(0, Math.min(255, Math.round(nextVal)));
        patchedBytes++;
      }
    }

    if (onReplaceBytes) {
      onReplaceBytes(out, `2-Anchor Content Port (${selected.length} clusters, ${patchedBytes} B)`);
      setPortedMessage(`Applied ${selected.length} ported cluster(s) (${patchedBytes} B) to active BIN.`);
    } else {
      const base = (cpTargetName || 'target').replace(/\.bin$/i, '');
      triggerDownload(out, `${base}-content-ported.bin`);
      setPortedMessage(`Downloaded ${base}-content-ported.bin (${patchedBytes} B patched).`);
    }
  };

  // --- Batch Tuner (.mtpatch) handlers ---
  const handleExtractMtPatch = () => {
    if (!xdf || !baselineBytes) {
      setBatchNotice('Requires both an XDF definition and a Stock Baseline BIN to extract .mtpatch.');
      return;
    }
    const ecu = identifyECU(bytes);
    const pkg = extractMtPatch(baselineBytes, bytes, xdf, {
      name: patchName.trim() || 'MacTuner Patch',
      author: patchAuthor.trim() || undefined,
      description: patchDesc.trim() || undefined,
      ecuFamily: ecu.ecuFamily,
      softwareNumber: ecu.softwareNumber !== '—' ? ecu.softwareNumber : undefined,
    });
    setLoadedPatch(pkg);
    const slug = pkg.name.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'tune';
    triggerDownload(JSON.stringify(pkg, null, 2), `${slug}.mtpatch`, 'application/json');
    setBatchNotice(`Extracted & downloaded ${slug}.mtpatch (${pkg.items.length} modified map(s)) and loaded into Batch Queue.`);
  };

  const handleLoadMtPatchFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as MtPatchPackage;
      if (!parsed || parsed.format !== 'mactuner-patch-v1' || !Array.isArray(parsed.items)) {
        setBatchNotice(`Invalid .mtpatch file "${file.name}".`);
        return;
      }
      setLoadedPatch(parsed);
      setBatchNotice(`Loaded "${parsed.name}" (${parsed.items.length} map patch(es)).`);
    } catch {
      setBatchNotice(`Failed to parse JSON in "${file.name}".`);
    }
  };

  const handleAddBatchBins = async (files: FileList | File[]) => {
    const added: typeof batchQueue = [];
    for (const f of Array.from(files)) {
      const raw = new Uint8Array(await f.arrayBuffer());
      const parsed = parseBinaryFile(f.name, raw);
      added.push({
        id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: f.name,
        bytes: parsed,
      });
    }
    if (added.length > 0) {
      setBatchQueue((prev) => [...prev, ...added]);
      setBatchNotice(`Queued ${added.length} target BIN file(s).`);
    }
  };

  const handleRunBatchApply = () => {
    if (!loadedPatch || batchQueue.length === 0) return;
    let totalApplied = 0;
    const nextQueue = batchQueue.map((item) => {
      const res = applyMtPatch(item.bytes, loadedPatch, batchApplyMode, xdf ?? undefined);
      totalApplied += res.appliedMaps;
      const outName = item.name.replace(/\.bin$/i, '') + `_tuned_${batchApplyMode}.bin`;
      triggerDownload(res.bytes, outName, 'application/octet-stream');
      return { ...item, result: res };
    });
    setBatchQueue(nextQueue);
    setBatchNotice(
      `Batch applied "${loadedPatch.name}" (${batchApplyMode}) across ${nextQueue.length} file(s) — ${totalApplied} map application(s) downloaded.`,
    );
  };

  return (
    <div className="h-full flex flex-col bg-[#0c0d10] text-zinc-100 overflow-hidden">
      {/* Sub-tab Header */}
      <div className="px-5 py-3 border-b border-white/[0.065] flex items-center justify-between gap-4 bg-[#121317] flex-wrap">
        <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] border border-white/[0.065]">
          {(
            [
              { id: 'finder', label: 'Map Finder', icon: <Radar className="w-3.5 h-3.5" /> },
              { id: 'dtc', label: 'DTC Scanner', icon: <FileWarning className="w-3.5 h-3.5" /> },
              { id: 'porting', label: 'Tune Porting', icon: <ArrowRightLeft className="w-3.5 h-3.5" /> },
              { id: 'batch', label: 'Batch Tuner (.mtpatch)', icon: <Package className="w-3.5 h-3.5" /> },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id)}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[11.5px] font-medium transition-all cursor-pointer ${
                subTab === t.id
                  ? 'bg-[#0a84ff] text-white shadow-[0_1px_10px_rgba(10,132,255,0.4)]'
                  : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
              }`}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-[11.5px] font-mono tabular-nums text-zinc-400">
          <span className="px-2 py-0.5 rounded-md bg-white/[0.04] border border-white/[0.065] text-zinc-300">
            {(bytes.length / 1024).toFixed(0)} KB
          </span>
          <span className="text-zinc-600">·</span>
          <span>{effectiveCandidates.length} candidates</span>
        </div>
      </div>

      {/* TAB 1: MAP FINDER */}
      {subTab === 'finder' && (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Scan Controls Bar */}
          <div className="px-5 py-2.5 border-b border-white/[0.065] bg-[#15161b] flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3.5 flex-wrap">
              <div className="flex items-center rounded-lg bg-[#0c0d10] border border-white/[0.065] p-0.5">
                {(
                  [
                    { id: '8', label: '8-bit' },
                    { id: '16', label: '16-bit' },
                    { id: 'f32', label: 'Float32' },
                  ] as const
                ).map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => setScanWidth(w.id)}
                    className={`px-2.5 py-1 rounded-md text-[11.5px] font-mono tabular-nums transition-colors cursor-pointer ${
                      scanWidth === w.id
                        ? 'bg-[#0a84ff]/20 text-[#5ac8fa] font-semibold'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {w.label}
                  </button>
                ))}
              </div>

              {scanWidth !== 'f32' && (
                <label className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={signed}
                    onChange={(e) => setSigned(e.target.checked)}
                    className="accent-[#0a84ff] rounded"
                  />
                  <span>Signed</span>
                </label>
              )}

              <label className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={lsbFirst}
                  onChange={(e) => setLsbFirst(e.target.checked)}
                  className="accent-[#0a84ff] rounded"
                />
                <span>LSB (Intel)</span>
              </label>
            </div>

            <button
              type="button"
              onClick={handleScanBin}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-semibold shadow-[0_2px_12px_rgba(10,132,255,0.35)] transition-all cursor-pointer"
            >
              <ScanSearch className="w-3.5 h-3.5" />
              <span>Scan BIN</span>
            </button>
          </div>

          {/* Split Body: Candidates Left / Jewel-Tile Heatmap Preview Right */}
          <div className="flex-1 grid grid-cols-12 min-h-0">
            <div className="col-span-5 border-r border-white/[0.065] overflow-y-auto p-3.5 space-y-2 bg-[#0e0f13]">
              {effectiveCandidates.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6">
                  <Sparkles className="w-8 h-8 text-zinc-600 mb-2.5" />
                  <p className="text-sm font-medium text-zinc-300">No map candidates scanned</p>
                  <p className="text-xs text-zinc-500 mt-1 max-w-xs">
                    Configure word width (8-bit, 16-bit, or Float32) &amp; endianness above, then click Scan BIN.
                  </p>
                </div>
              ) : (
                effectiveCandidates.map((cand) => {
                  const isSel = selectedCandidate?.id === cand.id;
                  const pct = Math.round(cand.confidence * 100);
                  return (
                    <button
                      key={cand.id}
                      type="button"
                      onClick={() => {
                        setSelectedCandId(cand.id);
                        setHoveredTile(null);
                      }}
                      className={`w-full text-left p-3.5 rounded-xl border transition-all cursor-pointer ${
                        isSel
                          ? 'bg-[#0a84ff]/[0.12] border-[#0a84ff]/45 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
                          : 'bg-[#17181d] border-white/[0.065] hover:border-white/[0.14] hover:bg-[#1c1d24]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs font-mono tabular-nums font-semibold text-white">
                            {formatHex(cand.address)}
                          </span>
                          <span className="text-[10.5px] font-mono tabular-nums px-1.5 py-0.5 rounded bg-white/[0.06] text-zinc-300">
                            {cand.rows}×{cand.cols}
                          </span>
                          {cand.hasHeaderProof && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                              Header Proof
                            </span>
                          )}
                          {cand.hasDiff && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30">
                              Diff
                            </span>
                          )}
                        </div>
                        <span
                          className={`text-[11px] font-mono tabular-nums font-semibold px-1.5 py-0.5 rounded shrink-0 ${
                            pct >= 90
                              ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25'
                              : 'bg-amber-500/15 text-amber-300 border border-amber-500/25'
                          }`}
                        >
                          {pct}%
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between text-[11px] text-zinc-400">
                        <span className="truncate">
                          {cand.patternLabel ?? `Bosch ${cand.rows}×${cand.cols} + Axes`}
                        </span>
                        <span className="font-mono tabular-nums text-zinc-500 shrink-0 ml-2">
                          {cand.bits === 32 ? 'F32' : `${cand.bits}b`} {cand.lsbFirst ? 'LE' : 'BE'}
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            <div className="col-span-7 overflow-y-auto p-5 flex flex-col bg-[#0c0d10]">
              {selectedCandidate && previewMatrix ? (
                <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 flex flex-col flex-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                  <div className="flex items-start justify-between gap-3 pb-3.5 border-b border-white/[0.065] flex-wrap">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold tracking-[-0.01em] text-white">
                          {selectedCandidate.domainHint ?? 'Detected Calibration Map'}
                        </h3>
                        <span className="text-xs font-mono tabular-nums text-[#5ac8fa]">
                          {formatHex(selectedCandidate.address)}
                        </span>
                      </div>
                      <p className="text-[11.5px] text-zinc-400 mt-0.5 font-mono tabular-nums">
                        {selectedCandidate.rows}×{selectedCandidate.cols} ·{' '}
                        {previewMatrix.isFloat
                          ? 'Float32'
                          : `${selectedCandidate.bits}-bit ${selectedCandidate.signed ? 'signed' : 'unsigned'}`}{' '}
                        {selectedCandidate.lsbFirst ? 'LSB' : 'MSB'} · Range [
                        {previewMatrix.isFloat ? previewMatrix.min.toFixed(2) : previewMatrix.min} ..{' '}
                        {previewMatrix.isFloat ? previewMatrix.max.toFixed(2) : previewMatrix.max}]
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 flex-wrap">
                      <button
                        type="button"
                        onClick={() => onShowInHex(selectedCandidate.address)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
                      >
                        <Binary className="w-3.5 h-3.5 text-[#0a84ff]" />
                        <span>Show in Hex</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleEditInXdf(selectedCandidate)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
                      >
                        <Pencil className="w-3.5 h-3.5 text-amber-400" />
                        <span>Edit in XDF…</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onAddCandidateToXdf({
                            ...selectedCandidate,
                            isFloat: selectedCandidate.bits === 32,
                          } as MapCandidate)
                        }
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-xs font-semibold text-white shadow-[0_2px_10px_rgba(10,132,255,0.3)] transition-colors cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add to XDF</span>
                      </button>
                    </div>
                  </div>

                  {/* Jewel-Tile Heatmap Grid */}
                  <div className="flex-1 mt-4 overflow-auto rounded-lg bg-[#0c0d10] border border-white/[0.06] p-2.5">
                    <div
                      className="grid gap-1"
                      style={{
                        gridTemplateColumns: `repeat(${selectedCandidate.cols}, minmax(28px, 1fr))`,
                      }}
                    >
                      {previewMatrix.grid.map((row, rIdx) =>
                        row.map((val, cIdx) => {
                          const span = Math.max(1e-6, previewMatrix.max - previewMatrix.min);
                          const t = (val - previewMatrix.min) / span;
                          const isHovered = hoveredTile?.r === rIdx && hoveredTile?.c === cIdx;
                          const disp = previewMatrix.isFloat ? val.toFixed(1) : String(val);
                          return (
                            <div
                              key={`${rIdx}-${cIdx}`}
                              onMouseEnter={() => setHoveredTile({ r: rIdx, c: cIdx, val })}
                              onMouseLeave={() => setHoveredTile(null)}
                              title={`[${rIdx}, ${cIdx}] = ${disp}`}
                              className={`h-7 rounded-[4px] border flex items-center justify-center text-[10px] font-mono tabular-nums text-white/95 font-medium select-none transition-transform ${
                                isHovered ? 'scale-105 ring-1 ring-white/70 z-10' : ''
                              }`}
                              style={jewelTileStyle(t)}
                            >
                              {disp}
                            </div>
                          );
                        }),
                      )}
                    </div>
                  </div>

                  <div className="mt-3 pt-2.5 border-t border-white/[0.06] flex items-center justify-between gap-3 text-[11px] font-mono tabular-nums text-zinc-400">
                    <div className="flex items-center gap-2">
                      <span>{previewMatrix.isFloat ? previewMatrix.min.toFixed(2) : previewMatrix.min}</span>
                      <div
                        className="h-2 w-28 rounded-full border border-white/10"
                        style={{
                          background:
                            'linear-gradient(90deg, rgb(24,64,168) 0%, rgb(14,148,196) 28%, rgb(16,168,114) 52%, rgb(224,154,18) 78%, rgb(217,56,68) 100%)',
                        }}
                      />
                      <span>{previewMatrix.isFloat ? previewMatrix.max.toFixed(2) : previewMatrix.max}</span>
                    </div>
                    {hoveredTile ? (
                      <span className="text-zinc-200">
                        Cell [{hoveredTile.r}, {hoveredTile.c}] ={' '}
                        <span className="text-[#5ac8fa] font-semibold">
                          {previewMatrix.isFloat ? hoveredTile.val.toFixed(3) : hoveredTile.val}
                        </span>
                      </span>
                    ) : (
                      <span className="text-zinc-500">Hover any jewel tile to inspect raw cell</span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center text-zinc-500">
                  <Radar className="w-9 h-9 text-zinc-700 mb-2.5" />
                  <p className="text-xs">Select a map candidate to inspect its jewel-tile heatmap.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: DTC SCANNER — REAL DTC-OFF SWITCH PATCHER */}
      {subTab === 'dtc' && (
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 flex items-center justify-between gap-4 flex-wrap shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div>
              <h2 className="text-sm font-semibold tracking-[-0.01em] text-white">
                OEM DTC-Off Switch Patcher
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                P0607-anchored Bosch/Siemens DTC scanner with parallel 8-bit error-class switch correlation &amp; 1-click live patching.
              </p>
            </div>
            <button
              type="button"
              onClick={handleScanDtcs}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-semibold shadow-[0_2px_10px_rgba(10,132,255,0.3)] transition-colors cursor-pointer"
            >
              <ScanSearch className="w-3.5 h-3.5" />
              <span>Scan DTC Tables</span>
            </button>
          </div>

          {dtcNotice && (
            <div className="rounded-xl bg-[#0a84ff]/10 border border-[#0a84ff]/30 px-4 py-2 text-xs text-[#5ac8fa]">
              {dtcNotice}
            </div>
          )}

          {/* 4 KPI Cards */}
          {dtcScan && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  Detected DTCs
                </div>
                <div className="mt-1 text-xl font-mono tabular-nums font-bold text-white">
                  {dtcStats.total}
                </div>
                <div className="text-[10.5px] font-mono text-zinc-500">
                  {dtcScan.familyHint} · {dtcScan.endianness}
                </div>
              </div>

              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  Active
                </div>
                <div className="mt-1 text-xl font-mono tabular-nums font-bold text-emerald-400">
                  {dtcStats.active}
                </div>
                <div className="text-[10.5px] text-zinc-500">Error-class enabled</div>
              </div>

              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  Disabled (DTC-Off)
                </div>
                <div className="mt-1 text-xl font-mono tabular-nums font-bold text-amber-400">
                  {dtcStats.disabled}
                </div>
                <div className="text-[10.5px] text-zinc-500">Switch byte = 0x00</div>
              </div>

              <button
                type="button"
                disabled={dtcScan.switchTableAddress < 0}
                onClick={() => dtcScan.switchTableAddress >= 0 && onShowInHex(dtcScan.switchTableAddress)}
                className="text-left rounded-xl bg-[#17181d] hover:bg-[#1c1d24] border border-white/[0.065] hover:border-[#0a84ff]/40 p-3.5 transition-colors cursor-pointer disabled:opacity-50"
              >
                <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  Switch Table (Click → Hex)
                </div>
                <div className="mt-1 text-xl font-mono tabular-nums font-bold text-[#5ac8fa]">
                  {dtcScan.switchTableAddress >= 0 ? formatHex(dtcScan.switchTableAddress) : '—'}
                </div>
                <div className="text-[10.5px] font-mono text-zinc-500">
                  Code Table: {dtcScan.codeTableAddress >= 0 ? formatHex(dtcScan.codeTableAddress) : '—'}
                </div>
              </button>
            </div>
          )}

          {/* Filter & Search Bar */}
          {dtcScan && dtcScan.entries.length > 0 && (
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-[#17181d] border border-white/[0.065]">
                {(
                  [
                    { id: 'all', label: `All (${dtcStats.total})` },
                    { id: 'active', label: `Active (${dtcStats.active})` },
                    { id: 'disabled', label: `Disabled (${dtcStats.disabled})` },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setDtcFilter(f.id)}
                    className={`px-3 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                      dtcFilter === f.id
                        ? 'bg-[#0a84ff] text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              <div className="relative">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={dtcQuery}
                  onChange={(e) => setDtcQuery(e.target.value)}
                  placeholder="Filter P-code, address..."
                  className="pl-8 pr-3 py-1.5 rounded-lg bg-[#17181d] border border-white/[0.08] text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-[#0a84ff] w-56"
                />
              </div>
            </div>
          )}

          {!dtcScanned && filteredDtcs === null ? (
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-12 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <FileWarning className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
              <h3 className="text-sm font-semibold text-zinc-200">Ready to scan OEM DTC tables</h3>
              <p className="text-xs text-zinc-400 max-w-md mx-auto mt-1 mb-4">
                Correlates P-code arrays with their parallel error-class switch table for instant 1-click DTC-Off patching.
              </p>
              <button
                type="button"
                onClick={handleScanDtcs}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-semibold transition-colors cursor-pointer"
              >
                <ScanSearch className="w-3.5 h-3.5" />
                <span>Scan DTC Tables</span>
              </button>
            </div>
          ) : !filteredDtcs || filteredDtcs.length === 0 ? (
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-10 text-center space-y-3">
              <CheckCircle2 className="w-8 h-8 text-amber-400/80 mx-auto" />
              <div>
                <p className="text-sm font-semibold text-zinc-100">
                  {dtcScan && dtcScan.entries.length > 0
                    ? 'No DTCs match the selected filter'
                    : 'Scanned BIN — 0 OEM DTC switch tables detected'}
                </p>
                {(!dtcScan || dtcScan.entries.length === 0) && (
                  <p className="text-xs text-zinc-400 max-w-md mx-auto mt-1">
                    No contiguous Bosch/Siemens P-code switch table was found in this binary. Load sample MED17 DTCs to preview live patching, or inspect raw flash in Hex.
                  </p>
                )}
              </div>
              {(!dtcScan || dtcScan.entries.length === 0) && (
                <div className="flex items-center justify-center gap-2 pt-1 flex-wrap">
                  <button
                    type="button"
                    onClick={handleLoadSampleMed17Dtcs}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-semibold transition-colors cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Load Sample MED17 DTCs</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onShowInHex(0)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-zinc-200 text-xs font-medium transition-colors cursor-pointer"
                  >
                    <Binary className="w-3.5 h-3.5 text-[#5ac8fa]" />
                    <span>Open Hex</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/[0.065] bg-white/[0.02] text-[10.5px] uppercase tracking-wider text-zinc-500">
                      <th className="py-2.5 px-4 font-semibold">DTC Code</th>
                      <th className="py-2.5 px-4 font-semibold">Code Addr</th>
                      <th className="py-2.5 px-4 font-semibold">Switch Addr</th>
                      <th className="py-2.5 px-4 font-semibold">Class</th>
                      <th className="py-2.5 px-4 font-semibold">Status (Live Toggle)</th>
                      <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.05] text-xs">
                    {filteredDtcs.slice(0, 300).map((dtc) => (
                      <tr key={`${dtc.pCode}-${dtc.codeAddress}`} className="hover:bg-white/[0.025] transition-colors">
                        <td className="py-2.5 px-4">
                          <div className="flex items-center gap-2">
                            <span className="inline-flex px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 font-mono tabular-nums font-semibold text-amber-300">
                              {dtc.pCode}
                            </span>
                            {KNOWN_DTC_DESCRIPTIONS[dtc.pCode] && (
                              <span className="text-[11px] text-zinc-400 truncate max-w-[200px]">
                                {KNOWN_DTC_DESCRIPTIONS[dtc.pCode]}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 px-4 font-mono tabular-nums text-zinc-400">
                          {formatHex(dtc.codeAddress)}
                        </td>
                        <td className="py-2.5 px-4 font-mono tabular-nums text-[#5ac8fa]">
                          {formatHex(dtc.switchAddress)}
                        </td>
                        <td className="py-2.5 px-4 font-mono tabular-nums text-zinc-300">
                          0x{dtc.currentValue.toString(16).toUpperCase().padStart(2, '0')}
                        </td>
                        <td className="py-2.5 px-4">
                          <button
                            type="button"
                            onClick={() => handleToggleDtc(dtc)}
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold transition-all cursor-pointer ${
                              dtc.isDisabled
                                ? 'bg-rose-500/15 border-rose-500/35 text-rose-300 hover:bg-rose-500/25'
                                : 'bg-emerald-500/15 border-emerald-500/35 text-emerald-300 hover:bg-emerald-500/25'
                            }`}
                          >
                            <span
                              className={`w-2 h-2 rounded-full ${
                                dtc.isDisabled ? 'bg-rose-400' : 'bg-emerald-400'
                              }`}
                            />
                            <span>{dtc.isDisabled ? 'DTC-Off' : 'Active'}</span>
                          </button>
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleAddDtcToXdf(dtc)}
                              className="px-2 py-1 rounded-md bg-[#0a84ff]/15 hover:bg-[#0a84ff]/30 text-[#5ac8fa] text-[11px] font-medium border border-[#0a84ff]/35 transition-colors cursor-pointer"
                              title="Save DTC switch as XDF Flag item"
                            >
                              + XDF
                            </button>
                            <button
                              type="button"
                              onClick={() => onShowInHex(dtc.switchAddress)}
                              className="px-2 py-1 rounded-md bg-white/[0.05] hover:bg-white/[0.1] text-[11px] font-medium text-zinc-300 border border-white/[0.08] transition-colors cursor-pointer"
                            >
                              Hex
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: TUNE PORTING — REAL CROSS-VERSION & 2-ANCHOR CONTENT PORT */}
      {subTab === 'porting' && (
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Hidden file inputs */}
          <input
            ref={targetBinInputRef}
            type="file"
            accept=".bin,.ori,.mod,.hex,.s19"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleLoadTargetBinForXdfPort(f);
              e.target.value = '';
            }}
          />
          <input
            ref={cpStockRef}
            type="file"
            accept=".bin,.ori,.mod"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setCpSrcStock(parseBinaryFile(f.name, new Uint8Array(await f.arrayBuffer())));
              setCpSrcStockName(f.name);
              e.target.value = '';
            }}
          />
          <input
            ref={cpModRef}
            type="file"
            accept=".bin,.ori,.mod"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setCpSrcMod(parseBinaryFile(f.name, new Uint8Array(await f.arrayBuffer())));
              setCpSrcModName(f.name);
              e.target.value = '';
            }}
          />
          <input
            ref={cpTargetRef}
            type="file"
            accept=".bin,.ori,.mod"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setCpTargetStock(parseBinaryFile(f.name, new Uint8Array(await f.arrayBuffer())));
              setCpTargetName(f.name);
              e.target.value = '';
            }}
          />

          {/* Mode Switch & Transfer Mode */}
          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[#0c0d10] border border-white/[0.065]">
              <button
                type="button"
                onClick={() => setPortingMode('xdf')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer ${
                  portingMode === 'xdf'
                    ? 'bg-[#0a84ff] text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                XDF Cross-Version Port
              </button>
              <button
                type="button"
                onClick={() => setPortingMode('content')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer ${
                  portingMode === 'content'
                    ? 'bg-[#0a84ff] text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                2-Anchor Content Port (No XDF)
              </button>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className="text-zinc-400">Transfer Mode:</span>
              <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-[#0c0d10] border border-white/[0.065]">
                {(['absolute', 'delta', 'percent'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setTransferMode(m)}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-medium capitalize cursor-pointer ${
                      transferMode === m
                        ? 'bg-[#0a84ff]/20 text-[#5ac8fa]'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {portedMessage && (
            <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-4 py-2 text-xs text-emerald-300 flex items-center gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>{portedMessage}</span>
            </div>
          )}

          {portingMode === 'xdf' ? (
            <div className="space-y-4">
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <h3 className="text-sm font-semibold text-white">XDF Cross-Version Porting</h3>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Correlates every XDF map across shifted software revisions (±64 KB) to export a ported XDF and ported BIN.
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => targetBinInputRef.current?.click()}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-xs font-medium text-zinc-100 cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5 text-[#5ac8fa]" />
                    <span>{targetBinName || 'Load Target BIN…'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={xdfMatches.length === 0}
                    onClick={handleExportPortedXdf}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-35 border border-white/[0.08] text-xs font-medium text-zinc-100 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5 text-amber-400" />
                    <span>Export -ported.xdf</span>
                  </button>
                  <button
                    type="button"
                    disabled={!targetBin || xdfMatches.length === 0}
                    onClick={handleExportPortedBin}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] disabled:opacity-35 text-white text-xs font-semibold cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Export -ported.bin</span>
                  </button>
                </div>
              </div>

              {xdfMatches.length > 0 && (
                <div className="rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-white/[0.065] bg-white/[0.02] text-[10.5px] uppercase tracking-wider text-zinc-500">
                        <th className="py-2.5 px-3">Use</th>
                        <th className="py-2.5 px-3">Map</th>
                        <th className="py-2.5 px-3">Source</th>
                        <th className="py-2.5 px-3">Target</th>
                        <th className="py-2.5 px-3">Offset Δ</th>
                        <th className="py-2.5 px-3 text-right">Confidence</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.05]">
                      {xdfMatches.map((m) => {
                        const pct = Math.round(m.confidence * 100);
                        return (
                          <tr key={m.itemId} className="hover:bg-white/[0.025]">
                            <td className="py-2 px-3">
                              <input
                                type="checkbox"
                                checked={m.selected !== false}
                                onChange={(e) =>
                                  setXdfMatches((prev) =>
                                    prev.map((x) =>
                                      x.itemId === m.itemId ? { ...x, selected: e.target.checked } : x,
                                    ),
                                  )
                                }
                                className="accent-[#0a84ff]"
                              />
                            </td>
                            <td className="py-2 px-3 font-medium text-zinc-100">{m.title}</td>
                            <td className="py-2 px-3 font-mono text-zinc-400">{formatHex(m.sourceAddr)}</td>
                            <td className="py-2 px-3 font-mono text-[#5ac8fa]">{formatHex(m.targetAddr)}</td>
                            <td className="py-2 px-3 font-mono text-amber-300">
                              {m.delta >= 0 ? `+0x${m.delta.toString(16).toUpperCase()}` : `-0x${Math.abs(m.delta).toString(16).toUpperCase()}`}
                            </td>
                            <td className="py-2 px-3 text-right font-mono">
                              <span
                                className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                                  pct >= 80
                                    ? 'bg-emerald-500/15 text-emerald-400'
                                    : pct >= 55
                                      ? 'bg-amber-500/15 text-amber-300'
                                      : 'bg-rose-500/15 text-rose-300'
                                }`}
                              >
                                {pct}%
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            /* 2-Anchor Content Port */
            <div className="space-y-4">
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                  <button
                    type="button"
                    onClick={() => cpStockRef.current?.click()}
                    className="p-3 rounded-lg bg-[#0c0d10] border border-white/[0.08] hover:border-[#0a84ff]/50 text-left cursor-pointer"
                  >
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500">1. Source Stock</div>
                    <div className="text-xs font-mono text-zinc-200 mt-0.5 truncate">
                      {cpSrcStock ? cpSrcStockName : baselineBytes ? 'Active Stock Baseline (loaded)' : 'Click to load…'}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => cpModRef.current?.click()}
                    className="p-3 rounded-lg bg-[#0c0d10] border border-white/[0.08] hover:border-[#0a84ff]/50 text-left cursor-pointer"
                  >
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500">2. Source Mod</div>
                    <div className="text-xs font-mono text-zinc-200 mt-0.5 truncate">
                      {cpSrcMod ? cpSrcModName : `${fileName} (active)`}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => cpTargetRef.current?.click()}
                    className="p-3 rounded-lg bg-[#0c0d10] border border-white/[0.08] hover:border-[#0a84ff]/50 text-left cursor-pointer"
                  >
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500">3. Target Stock</div>
                    <div className="text-xs font-mono text-[#5ac8fa] mt-0.5 truncate">
                      {cpTargetName || 'Click to load target .bin…'}
                    </div>
                  </button>
                </div>

                <div className="flex items-center justify-between gap-4 flex-wrap pt-1">
                  <div className="flex items-center gap-4 flex-wrap text-xs">
                    <label className="flex items-center gap-2 text-zinc-300">
                      <span>Tolerance:</span>
                      <input
                        type="range"
                        min={0}
                        max={10}
                        step={0.5}
                        value={cpTolerance}
                        onChange={(e) => setCpTolerance(Number(e.target.value))}
                        className="w-24 accent-[#0a84ff]"
                      />
                      <span className="font-mono text-[#5ac8fa]">{cpTolerance.toFixed(1)}%</span>
                    </label>
                    <label className="flex items-center gap-1.5 text-zinc-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={cpUniqueOnly}
                        onChange={(e) => setCpUniqueOnly(e.target.checked)}
                        className="accent-[#0a84ff]"
                      />
                      <span>Unique matches only</span>
                    </label>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleRunContentPortScan}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-xs font-semibold text-white cursor-pointer"
                    >
                      <ScanSearch className="w-3.5 h-3.5 text-[#5ac8fa]" />
                      <span>Scan Clusters</span>
                    </button>
                    <button
                      type="button"
                      disabled={cpMatches.filter((m) => m.selected && m.targetStart !== null).length === 0}
                      onClick={handleApplyContentPort}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] disabled:opacity-35 text-white text-xs font-semibold cursor-pointer"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Apply to Active BIN</span>
                    </button>
                  </div>
                </div>
              </div>

              {cpMatches.length > 0 && (
                <div className="rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden">
                  <table className="w-full text-left border-collapse text-xs font-mono">
                    <thead>
                      <tr className="border-b border-white/[0.065] bg-white/[0.02] text-[10.5px] uppercase tracking-wider text-zinc-500">
                        <th className="py-2.5 px-3">Use</th>
                        <th className="py-2.5 px-3">Source Range</th>
                        <th className="py-2.5 px-3">Target</th>
                        <th className="py-2.5 px-3">Offset Δ</th>
                        <th className="py-2.5 px-3">Bytes</th>
                        <th className="py-2.5 px-3 text-right">Confidence</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.05]">
                      {cpMatches.map((cl) => (
                        <tr key={cl.id} className="hover:bg-white/[0.025]">
                          <td className="py-2 px-3">
                            <input
                              type="checkbox"
                              disabled={cl.targetStart === null}
                              checked={cl.selected}
                              onChange={(e) =>
                                setCpMatches((prev) =>
                                  prev.map((x) =>
                                    x.id === cl.id ? { ...x, selected: e.target.checked } : x,
                                  ),
                                )
                              }
                              className="accent-[#0a84ff]"
                            />
                          </td>
                          <td className="py-2 px-3 text-zinc-300">
                            {formatHex(cl.sourceStart)}–{formatHex(cl.sourceEnd - 1)}
                          </td>
                          <td className="py-2 px-3 text-[#5ac8fa]">
                            {cl.targetStart !== null ? formatHex(cl.targetStart) : 'No match'}
                          </td>
                          <td className="py-2 px-3 text-amber-300">
                            {cl.delta !== null
                              ? `${cl.delta >= 0 ? '+' : '-'}0x${Math.abs(cl.delta).toString(16).toUpperCase()}`
                              : '—'}
                          </td>
                          <td className="py-2 px-3 text-zinc-400">{cl.changedBytes} B</td>
                          <td className="py-2 px-3 text-right">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10.5px] ${
                                cl.unique
                                  ? 'bg-emerald-500/15 text-emerald-400'
                                  : cl.targetStart !== null
                                    ? 'bg-amber-500/15 text-amber-300'
                                    : 'bg-rose-500/15 text-rose-300'
                              }`}
                            >
                              {Math.round(cl.confidence * 100)}% ({cl.candidateCount})
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 4: BATCH TUNER (.mtpatch) */}
      {subTab === 'batch' && (
        <div
          className="flex-1 overflow-y-auto p-5 space-y-4"
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setBatchDragging(true);
          }}
          onDragLeave={() => setBatchDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setBatchDragging(false);
            if (e.dataTransfer.files.length > 0) void handleAddBatchBins(e.dataTransfer.files);
          }}
        >
          <input
            ref={mtPatchInputRef}
            type="file"
            accept=".mtpatch,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleLoadMtPatchFile(f);
              e.target.value = '';
            }}
          />
          <input
            ref={batchBinInputRef}
            type="file"
            multiple
            accept=".bin,.ori,.mod,.hex,.s19"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void handleAddBatchBins(e.target.files);
              e.target.value = '';
            }}
          />

          {/* Extract .mtpatch Card */}
          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h2 className="text-sm font-semibold text-white">
                  1. Extract Portable Tune Package (.mtpatch)
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Captures physical cell deltas, percentages &amp; axis edits between Stock Baseline and Active BIN.
                </p>
              </div>
              <button
                type="button"
                disabled={!xdf || !baselineBytes}
                onClick={handleExtractMtPatch}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] disabled:opacity-35 text-white text-xs font-semibold cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Extract &amp; Download .mtpatch</span>
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <input
                type="text"
                value={patchName}
                onChange={(e) => setPatchName(e.target.value)}
                placeholder="Package Name"
                className="px-3 py-1.5 rounded-lg bg-[#0c0d10] border border-white/[0.08] text-xs text-zinc-100 focus:outline-none focus:border-[#0a84ff]"
              />
              <input
                type="text"
                value={patchAuthor}
                onChange={(e) => setPatchAuthor(e.target.value)}
                placeholder="Author (optional)"
                className="px-3 py-1.5 rounded-lg bg-[#0c0d10] border border-white/[0.08] text-xs text-zinc-100 focus:outline-none focus:border-[#0a84ff]"
              />
              <input
                type="text"
                value={patchDesc}
                onChange={(e) => setPatchDesc(e.target.value)}
                placeholder="Notes / Fuel grade (optional)"
                className="px-3 py-1.5 rounded-lg bg-[#0c0d10] border border-white/[0.08] text-xs text-zinc-100 focus:outline-none focus:border-[#0a84ff]"
              />
            </div>
          </div>

          {batchNotice && (
            <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-4 py-2 text-xs text-emerald-300">
              {batchNotice}
            </div>
          )}

          {/* Batch Apply Card */}
          <div
            className={`rounded-xl bg-[#17181d] border p-4 space-y-3 transition-colors ${
              batchDragging ? 'border-[#0a84ff] ring-2 ring-[#0a84ff]/30' : 'border-white/[0.065]'
            }`}
          >
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h2 className="text-sm font-semibold text-white">
                  2. Batch Apply .mtpatch to Multiple Target BINs
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  {loadedPatch
                    ? `Active Package: "${loadedPatch.name}" (${loadedPatch.items.length} map(s))`
                    : 'Load a .mtpatch JSON file or extract one above, then drop multiple target .bin files.'}
                </p>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-[#0c0d10] border border-white/[0.065]">
                  {(['absolute', 'delta', 'percent'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setBatchApplyMode(m)}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-medium capitalize cursor-pointer ${
                        batchApplyMode === m
                          ? 'bg-[#0a84ff]/20 text-[#5ac8fa]'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => mtPatchInputRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-xs font-medium text-zinc-100 cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5 text-amber-400" />
                  <span>Load .mtpatch</span>
                </button>
                <button
                  type="button"
                  onClick={() => batchBinInputRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-xs font-medium text-zinc-100 cursor-pointer"
                >
                  <Layers className="w-3.5 h-3.5 text-[#5ac8fa]" />
                  <span>Add Target .bin(s)</span>
                </button>
                <button
                  type="button"
                  disabled={!loadedPatch || batchQueue.length === 0}
                  onClick={handleRunBatchApply}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] disabled:opacity-35 text-white text-xs font-semibold cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Batch Apply &amp; Download ({batchQueue.length})</span>
                </button>
              </div>
            </div>

            {batchQueue.length === 0 ? (
              <div className="rounded-lg border border-dashed border-white/[0.1] bg-[#0c0d10] p-8 text-center text-xs text-zinc-500">
                Drop one or more target <code className="text-zinc-300">.bin</code> files anywhere here to queue them for batch tuning.
              </div>
            ) : (
              <div className="divide-y divide-white/[0.05] rounded-lg bg-[#0c0d10] border border-white/[0.065] overflow-hidden">
                {batchQueue.map((item) => (
                  <div
                    key={item.id}
                    className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-mono font-medium text-zinc-100 truncate">{item.name}</div>
                      <div className="text-[11px] font-mono text-zinc-500">
                        {Math.round(item.bytes.length / 1024)} KB
                        {item.result
                          ? ` · Applied ${item.result.appliedMaps} map(s), skipped ${item.result.skippedMaps}`
                          : ' · Queued'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {item.result && (
                        <button
                          type="button"
                          onClick={() =>
                            triggerDownload(
                              item.result!.bytes,
                              item.name.replace(/\.bin$/i, '') + `_tuned_${batchApplyMode}.bin`,
                            )
                          }
                          className="px-2.5 py-1 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-[11px] font-medium cursor-pointer"
                        >
                          Download
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setBatchQueue((prev) => prev.filter((x) => x.id !== item.id))}
                        className="px-2 py-1 rounded-md bg-white/[0.05] hover:bg-rose-500/20 text-zinc-400 hover:text-rose-300 text-[11px] cursor-pointer"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
