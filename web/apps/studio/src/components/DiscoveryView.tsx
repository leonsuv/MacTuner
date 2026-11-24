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
  Search,
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

/** Luxury jewel-tile thermal palette: sapphire -> cyan -> emerald -> amber -> ruby */
function jewelTileStyle(tRaw: number): React.CSSProperties {
  const t = Math.max(0, Math.min(1, Number.isFinite(tRaw) ? tRaw : 0.5));
  const stops: [number, number, number][] = [
    [24, 64, 168],   // deep sapphire
    [14, 148, 196],  // jewel cyan
    [16, 168, 114],  // emerald
    [224, 154, 18],  // warm amber
    [217, 56, 68],   // ruby crimson
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
  const [hoveredTile, setHoveredTile] = useState<{ r: number; c: number; val: number } | null>(null);
  const [dtcResults, setDtcResults] = useState<DtcMatch[] | null>(null);
  const [dtcQuery, setDtcQuery] = useState('');
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

  const filteredDtcs = useMemo(() => {
    if (!dtcResults) return null;
    const q = dtcQuery.trim().toLowerCase();
    if (!q) return dtcResults;
    return dtcResults.filter(
      (d) =>
        d.code.toLowerCase().includes(q) ||
        d.description.toLowerCase().includes(q) ||
        formatHex(d.address).toLowerCase().includes(q),
    );
  }, [dtcResults, dtcQuery]);

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

  const totalChangedCells = useMemo(
    () => changedMapsForPorting.reduce((acc, m) => acc + m.changedCells, 0),
    [changedMapsForPorting],
  );

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
    <div className="h-full flex flex-col bg-[#0c0d10] text-zinc-100 overflow-hidden">
      {/* Sub-tab Header */}
      <div className="px-5 py-3 border-b border-white/[0.065] flex items-center justify-between gap-4 bg-[#121317]">
        <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] border border-white/[0.065]">
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
          <span>{candidates.length} candidates</span>
        </div>
      </div>

      {/* MAP FINDER */}
      {subTab === 'finder' && (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Scan Controls Bar */}
          <div className="px-5 py-2.5 border-b border-white/[0.065] bg-[#15161b] flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3.5 flex-wrap">
              <div className="flex items-center rounded-lg bg-[#0c0d10] border border-white/[0.065] p-0.5">
                {([8, 16] as const).map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setBits(b)}
                    className={`px-2.5 py-1 rounded-md text-[11.5px] font-mono tabular-nums transition-colors cursor-pointer ${
                      bits === b
                        ? 'bg-[#0a84ff]/20 text-[#5ac8fa] font-semibold'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {b}-bit
                  </button>
                ))}
              </div>

              <label className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={signed}
                  onChange={(e) => setSigned(e.target.checked)}
                  className="accent-[#0a84ff] rounded"
                />
                <span>Signed</span>
              </label>

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
            {/* Left Candidate List */}
            <div className="col-span-5 border-r border-white/[0.065] overflow-y-auto p-3.5 space-y-2 bg-[#0e0f13]">
              {candidates.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6">
                  <Sparkles className="w-8 h-8 text-zinc-600 mb-2.5" />
                  <p className="text-sm font-medium text-zinc-300">No map candidates scanned</p>
                  <p className="text-xs text-zinc-500 mt-1 max-w-xs">
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
                          {cand.bits}b {cand.lsbFirst ? 'LE' : 'BE'}
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {/* Right Live Jewel-Tile Heatmap Preview */}
            <div className="col-span-7 overflow-y-auto p-5 flex flex-col bg-[#0c0d10]">
              {selectedCandidate && previewMatrix ? (
                <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 flex flex-col flex-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                  <div className="flex items-start justify-between gap-3 pb-3.5 border-b border-white/[0.065]">
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
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
                      >
                        <Binary className="w-3.5 h-3.5 text-[#0a84ff]" />
                        <span>Show in Hex</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onAddCandidateToXdf(selectedCandidate)}
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
                          const span = Math.max(1, previewMatrix.max - previewMatrix.min);
                          const t = (val - previewMatrix.min) / span;
                          const isHovered =
                            hoveredTile?.r === rIdx && hoveredTile?.c === cIdx;
                          return (
                            <div
                              key={`${rIdx}-${cIdx}`}
                              onMouseEnter={() => setHoveredTile({ r: rIdx, c: cIdx, val })}
                              onMouseLeave={() => setHoveredTile(null)}
                              title={`[${rIdx}, ${cIdx}] = ${val}`}
                              className={`h-7 rounded-[4px] border flex items-center justify-center text-[10px] font-mono tabular-nums text-white/95 font-medium select-none transition-transform ${
                                isHovered ? 'scale-105 ring-1 ring-white/70 z-10' : ''
                              }`}
                              style={jewelTileStyle(t)}
                            >
                              {val}
                            </div>
                          );
                        }),
                      )}
                    </div>
                  </div>

                  {/* Jewel Scale Footer */}
                  <div className="mt-3 pt-2.5 border-t border-white/[0.06] flex items-center justify-between gap-3 text-[11px] font-mono tabular-nums text-zinc-400">
                    <div className="flex items-center gap-2">
                      <span>{previewMatrix.min}</span>
                      <div
                        className="h-2 w-28 rounded-full border border-white/10"
                        style={{
                          background:
                            'linear-gradient(90deg, rgb(24,64,168) 0%, rgb(14,148,196) 28%, rgb(16,168,114) 52%, rgb(224,154,18) 78%, rgb(217,56,68) 100%)',
                        }}
                      />
                      <span>{previewMatrix.max}</span>
                    </div>
                    {hoveredTile ? (
                      <span className="text-zinc-200">
                        Cell [{hoveredTile.r}, {hoveredTile.c}] ={' '}
                        <span className="text-[#5ac8fa] font-semibold">{hoveredTile.val}</span>
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

      {/* DTC TABLES */}
      {subTab === 'dtc' && (
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 flex items-center justify-between gap-4 flex-wrap shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div>
              <h2 className="text-sm font-semibold tracking-[-0.01em] text-white">
                Bosch OBD-II P-Code Table Scanner
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Scans binary for contiguous 16-bit BCD P0xxx / P1xxx / P2xxx fault code arrays (0x0000–0x2FFF).
              </p>
            </div>
            <div className="flex items-center gap-2.5">
              {dtcResults && dtcResults.length > 0 && (
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={dtcQuery}
                    onChange={(e) => setDtcQuery(e.target.value)}
                    placeholder="Filter P-code..."
                    className="pl-8 pr-3 py-1.5 rounded-lg bg-[#0c0d10] border border-white/[0.08] text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-[#0a84ff] w-44"
                  />
                </div>
              )}
              <button
                type="button"
                onClick={handleScanDtcs}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-semibold shadow-[0_2px_10px_rgba(10,132,255,0.3)] transition-colors cursor-pointer"
              >
                <ScanSearch className="w-3.5 h-3.5" />
                <span>Scan DTC Tables</span>
              </button>
            </div>
          </div>

          {filteredDtcs === null ? (
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-12 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <FileWarning className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
              <h3 className="text-sm font-semibold text-zinc-200">Ready to scan DTC tables</h3>
              <p className="text-xs text-zinc-400 max-w-md mx-auto mt-1 mb-4">
                Detect OBD-II P-code definitions and jump directly to their flash offset in the Hex Editor.
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
          ) : filteredDtcs.length === 0 ? (
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-10 text-center">
              <CheckCircle2 className="w-8 h-8 text-zinc-500 mx-auto mb-2" />
              <p className="text-sm font-medium text-zinc-200">
                {dtcResults && dtcResults.length > 0
                  ? 'No DTCs match your filter'
                  : 'No contiguous Bosch P-code tables found'}
              </p>
              <p className="text-xs text-zinc-400 mt-1">
                {dtcResults && dtcResults.length > 0
                  ? 'Try clearing the search query above.'
                  : 'This binary may use encrypted or non-BCD fault structures (e.g. VAG/DFC table).'}
              </p>
            </div>
          ) : (
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="px-4 py-2.5 border-b border-white/[0.065] flex items-center justify-between text-[11px] text-zinc-400">
                <span className="font-semibold uppercase tracking-wider text-zinc-300">
                  Detected Fault Code Array
                </span>
                <span className="font-mono tabular-nums">{filteredDtcs.length} entries</span>
              </div>
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/[0.065] bg-white/[0.02] text-[10.5px] uppercase tracking-wider text-zinc-500">
                    <th className="py-2.5 px-4 font-semibold">DTC Code</th>
                    <th className="py-2.5 px-4 font-semibold">Address</th>
                    <th className="py-2.5 px-4 font-semibold">Raw</th>
                    <th className="py-2.5 px-4 font-semibold">Status</th>
                    <th className="py-2.5 px-4 font-semibold">Description</th>
                    <th className="py-2.5 px-4 font-semibold text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05] text-xs">
                  {filteredDtcs.map((dtc) => (
                    <tr key={`${dtc.code}-${dtc.address}`} className="hover:bg-white/[0.025] transition-colors">
                      <td className="py-2.5 px-4">
                        <span className="inline-flex px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 font-mono tabular-nums font-semibold text-amber-300">
                          {dtc.code}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-zinc-300">
                        {formatHex(dtc.address)}
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-zinc-400">
                        0x{dtc.rawValue.toString(16).toUpperCase().padStart(4, '0')}
                      </td>
                      <td className="py-2.5 px-4">
                        <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-400">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                          {dtc.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-zinc-300">{dtc.description}</td>
                      <td className="py-2.5 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => onShowInHex(dtc.address)}
                          className="px-2.5 py-1 rounded-md bg-white/[0.05] hover:bg-[#0a84ff]/20 hover:text-[#5ac8fa] text-[11px] font-medium text-zinc-300 border border-white/[0.08] transition-colors cursor-pointer"
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
          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 flex items-center justify-between gap-4 flex-wrap shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div>
              <h2 className="text-sm font-semibold tracking-[-0.01em] text-white">
                Stage 1 vs Stock Tune Porting
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                {changedMapsForPorting.length} modified XDF maps ({totalChangedCells.toLocaleString()} changed cells) ready to port or export as a delta summary.
              </p>
              {portedMessage && (
                <p className="text-xs text-emerald-400 mt-1.5 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {portedMessage}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={changedMapsForPorting.length === 0}
              onClick={handleExportPortSummary}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] disabled:opacity-35 disabled:cursor-not-allowed text-white text-xs font-semibold shadow-[0_2px_10px_rgba(10,132,255,0.3)] transition-colors cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Port &amp; Export Summary</span>
            </button>
          </div>

          {changedMapsForPorting.length === 0 ? (
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-10 text-center text-xs text-zinc-400">
              No changed maps detected between current BIN and baseline Stock BIN.
            </div>
          ) : (
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/[0.065] bg-white/[0.02] text-[10.5px] uppercase tracking-wider text-zinc-500">
                    <th className="py-2.5 px-4 font-semibold">Map Name</th>
                    <th className="py-2.5 px-4 font-semibold">Address</th>
                    <th className="py-2.5 px-4 font-semibold">Changed Cells</th>
                    <th className="py-2.5 px-4 font-semibold">Max Delta</th>
                    <th className="py-2.5 px-4 font-semibold">Avg Shift</th>
                    <th className="py-2.5 px-4 font-semibold text-right">Inspect</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05] text-xs">
                  {changedMapsForPorting.map((entry) => (
                    <tr key={entry.item.id} className="hover:bg-white/[0.025] transition-colors">
                      <td className="py-2.5 px-4 font-medium text-zinc-100">{entry.item.title}</td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-zinc-400">
                        {formatHex(entry.item.data.address)}
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-amber-300">
                        {entry.changedCells} / {entry.totalCells}
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-zinc-200">
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
                          className="px-2.5 py-1 rounded-md bg-white/[0.05] hover:bg-[#0a84ff]/20 hover:text-[#5ac8fa] text-[11px] font-medium text-zinc-300 border border-white/[0.08] transition-colors cursor-pointer"
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
