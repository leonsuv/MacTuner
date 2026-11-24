import React, { useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  Binary,
  CheckCircle2,
  Download,
  FileWarning,
  Plus,
  Radar,
  ScanSearch,
  Sparkles,
} from 'lucide-react';
import {
  BinCodec,
  DataLayout,
  XDFDefinition,
  XDFItem,
  scalingValue,
} from '@mactuner/core';
import type { MapCandidate } from './Sidebar';

export type DiscoverySubTab = 'finder' | 'dtc' | 'porting';

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
  P2004: 'Intake Manifold Runner Control Stuck Open',
  P2015: 'Intake Manifold Runner Position Sensor Range',
  P2187: 'System Too Lean at Idle Bank 1',
  P2270: 'O2 Sensor Signal Biased/Stuck Lean Bank 1 S2',
};

function formatHex(addr: number): string {
  return `0x${Math.max(0, addr).toString(16).toUpperCase().padStart(5, '0')}`;
}

function heatColor(t: number): string {
  const c = Math.max(0, Math.min(1, t));
  if (c < 0.25) {
    const k = c / 0.25;
    return `rgb(${Math.round(18 + k * 14)}, ${Math.round(42 + k * 84)}, ${Math.round(115 + k * 110)})`;
  }
  if (c < 0.5) {
    const k = (c - 0.25) / 0.25;
    return `rgb(${Math.round(32 + k * 24)}, ${Math.round(126 + k * 74)}, ${Math.round(225 - k * 95)})`;
  }
  if (c < 0.75) {
    const k = (c - 0.5) / 0.25;
    return `rgb(${Math.round(56 + k * 189)}, ${Math.round(200 - k * 42)}, ${Math.round(130 - k * 119)})`;
  }
  const k = (c - 0.75) / 0.25;
  return `rgb(${Math.round(245 - k * 12)}, ${Math.round(158 - k * 98)}, ${Math.round(11 + k * 42)})`;
}

function scanBinForMaps(
  bytes: Uint8Array,
  baseline: Uint8Array | null,
  bits: 8 | 16,
  signed: boolean,
  lsbFirst: boolean,
): MapCandidate[] {
  const elemBytes = bits === 16 ? 2 : 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const results: MapCandidate[] = [];
  const usedRanges: Array<[number, number]> = [];

  const readVal = (off: number): number => {
    if (bits === 16) return signed ? view.getInt16(off, lsbFirst) : view.getUint16(off, lsbFirst);
    return signed ? view.getInt8(off) : view.getUint8(off);
  };

  const readU = (off: number): number => {
    if (bits === 16) return view.getUint16(off, lsbFirst);
    return view.getUint8(off);
  };

  const overlaps = (start: number, end: number) =>
    usedRanges.some(([s, e]) => start < e && end > s);

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

  // Pass 1: Bosch 2D Header Proof [rows, cols, yAxis, xAxis, data]
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

    // Check data smoothness & non-trivial variance
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

function scanBinForDtcs(bytes: Uint8Array): DtcMatch[] {
  if (bytes.length < 16) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const matches: DtcMatch[] = [];

  const isPlausibleBcdPCode = (v: number): string | null => {
    if (v === 0 || v > 0x2fff) return null;
    const d3 = (v >> 12) & 0xf;
    const d2 = (v >> 8) & 0xf;
    const d1 = (v >> 4) & 0xf;
    const d0 = v & 0xf;
    if (d3 > 2 || d2 > 9 || d1 > 9 || d0 > 9) return null;
    const code = `P${d3}${d2}${d1}${d0}`;
    if (d3 === 0 && d2 === 0 && d1 === 0) return null;
    return code;
  };

  // Look for contiguous runs of >= 4 plausible Bosch OBD-II 16-bit P-codes (0x0000..0x2FFF)
  let off = 0;
  while (off + 8 <= bytes.length && matches.length < 64) {
    let runLen = 0;
    while (off + (runLen + 1) * 2 <= bytes.length) {
      const vLE = view.getUint16(off + runLen * 2, true);
      if (isPlausibleBcdPCode(vLE)) runLen++;
      else break;
    }
    if (runLen >= 4) {
      for (let i = 0; i < runLen && matches.length < 64; i++) {
        const addr = off + i * 2;
        const raw = view.getUint16(addr, true);
        const code = isPlausibleBcdPCode(raw);
        if (!code) continue;
        matches.push({
          code,
          rawValue: raw,
          address: addr,
          status: 'Active',
          description: KNOWN_DTC_DESCRIPTIONS[code] ?? 'OBD-II Powertrain Diagnostic Code',
        });
      }
      off += runLen * 2;
    } else {
      off += 2;
    }
  }

  return matches;
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
}) => {
  const [subTab, setSubTab] = useState<DiscoverySubTab>('finder');
  const [bits, setBits] = useState<8 | 16>(16);
  const [signed, setSigned] = useState(false);
  const [lsbFirst, setLsbFirst] = useState(true);
  const [selectedCandId, setSelectedCandId] = useState<string | null>(
    candidates[0]?.id ?? null,
  );
  const [dtcResults, setDtcResults] = useState<DtcMatch[] | null>(null);
  const [portedMessage, setPortedMessage] = useState<string | null>(null);

  const selectedCandidate = useMemo(
    () => candidates.find((c) => c.id === selectedCandId) ?? candidates[0] ?? null,
    [candidates, selectedCandId],
  );

  const previewMatrix = useMemo(() => {
    if (!selectedCandidate) return null;
    const layout: DataLayout = {
      address: selectedCandidate.address,
      bits: selectedCandidate.bits,
      signed: selectedCandidate.signed,
      lsbFirst: selectedCandidate.lsbFirst,
      columnMajor: false,
      isFloat: false,
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
        if (v < min) min = v;
        if (v > max) max = v;
        row.push(v);
      }
      grid.push(row);
    }
    return { grid, min, max };
  }, [selectedCandidate, bytes]);

  const changedMapsForPorting = useMemo(() => {
    if (!xdf || !baselineBytes) return [];
    const changed: Array<{
      item: XDFItem;
      changedCells: number;
      totalCells: number;
      maxDelta: number;
      avgDeltaPct: number;
    }> = [];

    for (const item of xdf.items) {
      const total = item.data.rows * item.data.cols;
      let changedCells = 0;
      let maxDelta = 0;
      let pctSum = 0;

      for (let r = 0; r < item.data.rows; r++) {
        for (let c = 0; c < item.data.cols; c++) {
          const curRaw = BinCodec.raw(item.data, { r, c }, bytes);
          const baseRaw = BinCodec.raw(item.data, { r, c }, baselineBytes);
          if (curRaw === null || baseRaw === null || curRaw === baseRaw) continue;
          changedCells++;
          const curVal = scalingValue(item.scaling, curRaw);
          const baseVal = scalingValue(item.scaling, baseRaw);
          const delta = curVal - baseVal;
          if (Math.abs(delta) > Math.abs(maxDelta)) maxDelta = delta;
          if (Math.abs(baseVal) > 1e-6) {
            pctSum += (delta / Math.abs(baseVal)) * 100;
          }
        }
      }

      if (changedCells > 0) {
        changed.push({
          item,
          changedCells,
          totalCells: total,
          maxDelta,
          avgDeltaPct: pctSum / changedCells,
        });
      }
    }
    return changed;
  }, [xdf, bytes, baselineBytes]);

  const handleScanBin = () => {
    const found = scanBinForMaps(bytes, baselineBytes, bits, signed, lsbFirst);
    onCandidatesChange?.(found);
    setSelectedCandId(found[0]?.id ?? null);
  };

  const handleScanDtcs = () => {
    const found = scanBinForDtcs(bytes);
    setDtcResults(found);
  };

  const handleExportPortSummary = () => {
    const ids = changedMapsForPorting.map((m) => m.item.id);
    if (onPortMaps) {
      onPortMaps(ids);
    }
    const lines = [
      `MacTuner Stage 1 -> Stock Tune Porting Summary`,
      `Generated: ${new Date().toISOString()}`,
      `Changed Maps: ${changedMapsForPorting.length}`,
      '',
      ...changedMapsForPorting.map(
        (m) =>
          `- ${m.item.title} (${formatHex(m.item.data.address)}, ${m.item.data.rows}x${m.item.data.cols}): ${m.changedCells}/${m.totalCells} cells, max delta ${m.maxDelta >= 0 ? '+' : ''}${m.maxDelta.toFixed(2)} ${m.item.scaling.units}`,
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mactuner-tune-port-summary.txt';
    a.click();
    URL.revokeObjectURL(url);
    setPortedMessage(`Exported ${changedMapsForPorting.length} changed map deltas.`);
  };

  return (
    <div className="h-full flex flex-col bg-[#0d1016] text-slate-100 overflow-hidden">
      {/* Sub-tab Header */}
      <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between gap-4 bg-[#10141c]">
        <div className="flex items-center gap-1 p-1 rounded-lg bg-[#141821] border border-white/10">
          {(
            [
              { id: 'finder', label: 'Map Finder', icon: <Radar className="w-3.5 h-3.5" /> },
              { id: 'dtc', label: 'DTC Tables', icon: <FileWarning className="w-3.5 h-3.5" /> },
              { id: 'porting', label: 'Tune Porting', icon: <ArrowRightLeft className="w-3.5 h-3.5" /> },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                subTab === t.id
                  ? 'bg-[#2589ff] text-white shadow-[0_1px_10px_rgba(37,137,255,0.35)]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        <div className="text-xs font-mono tabular-nums text-slate-400">
          BIN: {(bytes.length / 1024).toFixed(0)} KB · {candidates.length} candidates
        </div>
      </div>

      {/* MAP FINDER */}
      {subTab === 'finder' && (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Scan Controls Bar */}
          <div className="px-5 py-2.5 border-b border-white/10 bg-[#141821]/60 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center rounded-md bg-[#0d1016] border border-white/10 p-0.5">
                {([8, 16] as const).map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setBits(b)}
                    className={`px-2.5 py-1 rounded text-xs font-mono tabular-nums transition-colors ${
                      bits === b
                        ? 'bg-[#2589ff]/25 text-[#6ab0ff] font-semibold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {b}-bit
                  </button>
                ))}
              </div>

              <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={signed}
                  onChange={(e) => setSigned(e.target.checked)}
                  className="accent-[#2589ff] rounded"
                />
                <span>Signed</span>
              </label>

              <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={lsbFirst}
                  onChange={(e) => setLsbFirst(e.target.checked)}
                  className="accent-[#2589ff] rounded"
                />
                <span>LSB (Intel)</span>
              </label>
            </div>

            <button
              type="button"
              onClick={handleScanBin}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#2589ff] hover:bg-[#1d78e8] text-white text-xs font-semibold shadow-[0_2px_12px_rgba(37,137,255,0.35)] transition-all"
            >
              <ScanSearch className="w-3.5 h-3.5" />
              <span>Scan BIN</span>
            </button>
          </div>

          {/* Split Body: Candidates Left / Thermal Preview Right */}
          <div className="flex-1 grid grid-cols-12 min-h-0">
            {/* Left Candidate List */}
            <div className="col-span-5 border-r border-white/10 overflow-y-auto p-3 space-y-2">
              {candidates.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6">
                  <Sparkles className="w-8 h-8 text-slate-600 mb-2" />
                  <p className="text-sm font-medium text-slate-300">No map candidates scanned</p>
                  <p className="text-xs text-slate-500 mt-1">
                    Configure word width &amp; endianness above, then click Scan BIN.
                  </p>
                </div>
              ) : (
                candidates.map((cand) => {
                  const isSel = selectedCandidate?.id === cand.id;
                  const pct = Math.round(cand.confidence * 100);
                  return (
                    <button
                      key={cand.id}
                      type="button"
                      onClick={() => setSelectedCandId(cand.id)}
                      className={`w-full text-left p-3 rounded-xl border transition-all ${
                        isSel
                          ? 'bg-[#2589ff]/15 border-[#2589ff]/50 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
                          : 'bg-[#141821]/80 border-white/10 hover:border-white/20'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono tabular-nums font-semibold text-white">
                            {formatHex(cand.address)}
                          </span>
                          <span className="text-[11px] font-mono tabular-nums px-1.5 py-0.5 rounded bg-white/[0.07] text-slate-300">
                            {cand.rows}×{cand.cols}
                          </span>
                          {cand.hasHeaderProof && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#f59e0b]/15 text-[#fbbf24] border border-[#f59e0b]/35">
                              Header Proof
                            </span>
                          )}
                        </div>
                        <span
                          className={`text-xs font-mono tabular-nums font-semibold px-1.5 py-0.5 rounded ${
                            pct >= 90
                              ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                              : 'bg-[#f59e0b]/15 text-[#fbbf24] border border-[#f59e0b]/30'
                          }`}
                        >
                          {pct}%
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-400">
                        <span className="truncate">
                          {cand.patternLabel ?? `Bosch ${cand.rows}×${cand.cols} + Axes`}
                        </span>
                        <span className="font-mono tabular-nums text-slate-500 shrink-0 ml-2">
                          {cand.bits}b {cand.lsbFirst ? 'LE' : 'BE'}
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {/* Right Live Thermal Heatmap Preview */}
            <div className="col-span-7 overflow-y-auto p-5 flex flex-col">
              {selectedCandidate && previewMatrix ? (
                <div className="rounded-xl bg-[#141821] border border-white/10 p-4 flex flex-col flex-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                  <div className="flex items-start justify-between gap-3 pb-3 border-b border-white/10">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-white">
                          {selectedCandidate.domainHint ?? 'Detected Calibration Map'}
                        </h3>
                        <span className="text-xs font-mono tabular-nums text-[#6ab0ff]">
                          {formatHex(selectedCandidate.address)}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5 font-mono tabular-nums">
                        {selectedCandidate.rows}×{selectedCandidate.cols} · {selectedCandidate.bits}-bit{' '}
                        {selectedCandidate.signed ? 'signed' : 'unsigned'}{' '}
                        {selectedCandidate.lsbFirst ? 'LSB' : 'MSB'} · Range [{previewMatrix.min} ..{' '}
                        {previewMatrix.max}]
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onShowInHex(selectedCandidate.address)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.11] border border-white/10 text-xs font-medium text-slate-200 transition-colors"
                      >
                        <Binary className="w-3.5 h-3.5 text-[#2589ff]" />
                        <span>Show in Hex</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onAddCandidateToXdf(selectedCandidate)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#2589ff] hover:bg-[#1d78e8] text-xs font-semibold text-white transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add to XDF</span>
                      </button>
                    </div>
                  </div>

                  {/* Thermal Heatmap Grid */}
                  <div className="flex-1 mt-4 overflow-auto">
                    <div
                      className="grid gap-0.5"
                      style={{
                        gridTemplateColumns: `repeat(${selectedCandidate.cols}, minmax(26px, 1fr))`,
                      }}
                    >
                      {previewMatrix.grid.map((row, rIdx) =>
                        row.map((val, cIdx) => {
                          const span = Math.max(1, previewMatrix.max - previewMatrix.min);
                          const t = (val - previewMatrix.min) / span;
                          return (
                            <div
                              key={`${rIdx}-${cIdx}`}
                              title={`[${rIdx}, ${cIdx}] = ${val}`}
                              className="h-7 rounded-[3px] flex items-center justify-center text-[10px] font-mono tabular-nums text-white/95 font-medium select-none"
                              style={{ backgroundColor: heatColor(t) }}
                            >
                              {val}
                            </div>
                          );
                        }),
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center text-slate-500">
                  <Radar className="w-9 h-9 text-slate-600 mb-2" />
                  <p className="text-xs">Select a map candidate to inspect its live thermal heatmap.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* DTC TABLES */}
      {subTab === 'dtc' && (
        <div className="flex-1 overflow-y-auto p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-white">Bosch OBD-II P-Code Table Scanner</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Scans binary for contiguous 16-bit BCD P0xxx / P1xxx / P2xxx fault code arrays (0x0000–0x2FFF).
              </p>
            </div>
            <button
              type="button"
              onClick={handleScanDtcs}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#2589ff] hover:bg-[#1d78e8] text-white text-xs font-semibold transition-colors"
            >
              <ScanSearch className="w-3.5 h-3.5" />
              <span>Scan DTC Tables</span>
            </button>
          </div>

          {dtcResults === null ? (
            <div className="rounded-xl bg-[#141821] border border-white/10 p-12 text-center">
              <FileWarning className="w-10 h-10 text-slate-500 mx-auto mb-3" />
              <h3 className="text-sm font-semibold text-slate-200">Ready to scan DTC tables</h3>
              <p className="text-xs text-slate-400 max-w-md mx-auto mt-1 mb-4">
                Detect OBD-II P-code definitions and jump directly to their flash offset in the Hex Editor.
              </p>
              <button
                type="button"
                onClick={handleScanDtcs}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#2589ff] hover:bg-[#1d78e8] text-white text-xs font-semibold transition-colors"
              >
                <ScanSearch className="w-3.5 h-3.5" />
                <span>Scan DTC Tables</span>
              </button>
            </div>
          ) : dtcResults.length === 0 ? (
            <div className="rounded-xl bg-[#141821] border border-white/10 p-10 text-center">
              <CheckCircle2 className="w-8 h-8 text-slate-500 mx-auto mb-2" />
              <p className="text-sm font-medium text-slate-200">No contiguous Bosch P-code tables found</p>
              <p className="text-xs text-slate-400 mt-1">
                This binary may use encrypted or non-BCD fault structures (e.g. VAG/DFC table).
              </p>
            </div>
          ) : (
            <div className="rounded-xl bg-[#141821] border border-white/10 overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10 bg-white/[0.02] text-[11px] uppercase tracking-wider text-slate-400">
                    <th className="py-2.5 px-4 font-semibold">DTC Code</th>
                    <th className="py-2.5 px-4 font-semibold">Address</th>
                    <th className="py-2.5 px-4 font-semibold">Raw</th>
                    <th className="py-2.5 px-4 font-semibold">Description</th>
                    <th className="py-2.5 px-4 font-semibold text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06] text-xs">
                  {dtcResults.map((dtc) => (
                    <tr key={`${dtc.code}-${dtc.address}`} className="hover:bg-white/[0.03]">
                      <td className="py-2 px-4 font-mono tabular-nums font-semibold text-[#fbbf24]">
                        {dtc.code}
                      </td>
                      <td className="py-2 px-4 font-mono tabular-nums text-slate-300">
                        {formatHex(dtc.address)}
                      </td>
                      <td className="py-2 px-4 font-mono tabular-nums text-slate-400">
                        0x{dtc.rawValue.toString(16).toUpperCase().padStart(4, '0')}
                      </td>
                      <td className="py-2 px-4 text-slate-300">{dtc.description}</td>
                      <td className="py-2 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => onShowInHex(dtc.address)}
                          className="px-2.5 py-1 rounded bg-white/[0.06] hover:bg-[#2589ff]/20 hover:text-[#6ab0ff] text-[11px] font-medium text-slate-300 border border-white/10 transition-colors"
                        >
                          In Hex
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TUNE PORTING */}
      {subTab === 'porting' && (
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="rounded-xl bg-[#141821] border border-white/10 p-4 flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h2 className="text-sm font-semibold text-white">Stage 1 vs Stock Tune Porting</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                {changedMapsForPorting.length} modified XDF maps ready to port or export as a delta summary.
              </p>
              {portedMessage && (
                <p className="text-xs text-emerald-400 mt-1 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {portedMessage}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={changedMapsForPorting.length === 0}
              onClick={handleExportPortSummary}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#2589ff] hover:bg-[#1d78e8] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Port &amp; Export Summary</span>
            </button>
          </div>

          {changedMapsForPorting.length === 0 ? (
            <div className="rounded-xl bg-[#141821] border border-white/10 p-10 text-center text-xs text-slate-400">
              No changed maps detected between current BIN and baseline Stock BIN.
            </div>
          ) : (
            <div className="rounded-xl bg-[#141821] border border-white/10 overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10 bg-white/[0.02] text-[11px] uppercase tracking-wider text-slate-400">
                    <th className="py-2.5 px-4 font-semibold">Map Name</th>
                    <th className="py-2.5 px-4 font-semibold">Address</th>
                    <th className="py-2.5 px-4 font-semibold">Changed Cells</th>
                    <th className="py-2.5 px-4 font-semibold">Max Delta</th>
                    <th className="py-2.5 px-4 font-semibold">Avg Shift</th>
                    <th className="py-2.5 px-4 font-semibold text-right">Inspect</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06] text-xs">
                  {changedMapsForPorting.map((entry) => (
                    <tr key={entry.item.id} className="hover:bg-white/[0.03]">
                      <td className="py-2.5 px-4 font-medium text-slate-100">{entry.item.title}</td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-slate-400">
                        {formatHex(entry.item.data.address)}
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-[#fbbf24]">
                        {entry.changedCells} / {entry.totalCells}
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-slate-200">
                        {entry.maxDelta >= 0 ? '+' : ''}
                        {entry.maxDelta.toFixed(entry.item.scaling.decimals)} {entry.item.scaling.units}
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-emerald-400">
                        {entry.avgDeltaPct >= 0 ? '+' : ''}
                        {entry.avgDeltaPct.toFixed(1)}%
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => onShowInHex(entry.item.data.address)}
                          className="px-2.5 py-1 rounded bg-white/[0.06] hover:bg-[#2589ff]/20 hover:text-[#6ab0ff] text-[11px] font-medium text-slate-300 border border-white/10 transition-colors"
                        >
                          In Hex
                        </button>
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
  );
};
