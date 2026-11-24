import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Copy,
  Filter,
  GitCompareArrows,
  Layers,
  Navigation,
  PlusSquare,
  Search,
  Sparkles,
} from 'lucide-react';
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

function readWordHex(bytes: Uint8Array, offset: number, format: HexWordFormat): string {
  if (offset >= bytes.length) return '··';
  if (format === 'u8') {
    return bytes[offset].toString(16).toUpperCase().padStart(2, '0');
  }
  if (offset + 1 >= bytes.length) {
    return `${bytes[offset].toString(16).toUpperCase().padStart(2, '0')}··`;
  }
  const val =
    format === 'u16le'
      ? bytes[offset] | (bytes[offset + 1] << 8)
      : (bytes[offset] << 8) | bytes[offset + 1];
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
  const [colCount, setColCount] = useState<ColCount>(8);
  const [diffsOnly, setDiffsOnly] = useState<boolean>(false);
  const [gotoInput, setGotoInput] = useState<string>('');
  const [topRow, setTopRow] = useState<number>(0);
  const [viewportHeight, setViewportHeight] = useState<number>(572);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [activeDiffIdx, setActiveDiffIdx] = useState<number>(-1);
  const [copyToast, setCopyToast] = useState<string | null>(null);

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

  // Index XDF items for fast row annotation lookup
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
      // Binary search upper bound
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
        // Find nearest diff row
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

  const hasSelection = selectedRange !== null && selectedRange[1] > selectedRange[0];

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0d1016] text-slate-200 select-none">
      {/* Top Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#141821]/95 px-3 py-2">
        {/* Left group: Word Format + Columns */}
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-white/10 bg-[#0d1016] p-0.5 text-[11px] font-medium">
            {(
              [
                ['u8', '8-bit'],
                ['u16le', '16-bit LoHi'],
                ['u16be', '16-bit HiLo'],
              ] as const
            ).map(([fmt, label]) => (
              <button
                key={fmt}
                type="button"
                onClick={() => setWordFormat(fmt)}
                className={`rounded-md px-2 py-1 transition-colors ${
                  wordFormat === fmt
                    ? 'bg-[#2589ff] text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="inline-flex rounded-lg border border-white/10 bg-[#0d1016] p-0.5 font-mono text-[11px]">
            {([8, 12, 16] as const).map((cols) => (
              <button
                key={cols}
                type="button"
                onClick={() => setColCount(cols)}
                className={`rounded-md px-2 py-1 transition-colors ${
                  colCount === cols
                    ? 'bg-white/15 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {cols} col
              </button>
            ))}
          </div>
        </div>

        {/* Right group: Diffs Only + Diff Nav + Go To */}
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
                ? 'cursor-not-allowed border-white/5 bg-white/[0.02] text-slate-600'
                : diffsOnly
                  ? 'border-amber-400/50 bg-amber-500/20 text-amber-200'
                  : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'
            }`}
          >
            <Filter className="h-3.5 w-3.5" />
            Diffs Only
          </button>

          {compareBin ? (
            <div className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-[#0d1016] px-1.5 py-0.5">
              <button
                type="button"
                onClick={() => jumpDiff(-1)}
                disabled={diffStats.clusters.length === 0}
                title="Previous Diff"
                className="rounded p-1 text-slate-300 hover:bg-white/10 disabled:opacity-35"
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
                className="rounded p-1 text-slate-300 hover:bg-white/10 disabled:opacity-35"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}

          <form onSubmit={handleGotoSubmit} className="relative flex items-center">
            <Navigation className="pointer-events-none absolute left-2 h-3 w-3 text-slate-500" />
            <input
              type="text"
              value={gotoInput}
              onChange={(e) => setGotoInput(e.target.value)}
              placeholder="Go To 0x…"
              className="w-28 rounded-lg border border-white/10 bg-[#0d1016] py-1 pr-2 pl-6 font-mono text-[11px] text-slate-200 placeholder-slate-500 outline-none focus:border-[#2589ff]"
            />
          </form>
        </div>
      </div>

      {/* Column Headers */}
      <div className="grid shrink-0 grid-cols-[76px_1fr_28px_1fr_176px] items-center border-b border-white/10 bg-[#141821]/70 px-3 py-1.5 text-[11px] font-semibold text-slate-400">
        <div className="font-mono">Address</div>
        <div className="flex items-center gap-1.5 truncate pr-2">
          <span className="h-1.5 w-1.5 rounded-full bg-[#2589ff]" />
          <span className="truncate text-slate-200">BIN · {binName}</span>
        </div>
        <div className="flex justify-center text-slate-500">
          <GitCompareArrows className="h-3.5 w-3.5" />
        </div>
        <div className="flex items-center gap-1.5 truncate px-2">
          <span
            className={`h-1.5 w-1.5 rounded-full ${compareBin ? 'bg-amber-400' : 'bg-slate-600'}`}
          />
          <span className="truncate text-slate-300">
            {compareBin ? `Comparison · ${compareName}` : 'No Comparison Loaded'}
          </span>
        </div>
        <div className="flex items-center gap-1 pl-2 text-slate-300">
          <Layers className="h-3 w-3 text-sky-400" />
          XDF Map / Detected
        </div>
      </div>

      {/* Virtualized Split Hex-Diff Grid */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onMouseLeave={() => setHover(null)}
        className="relative min-h-0 flex-1 overflow-y-auto bg-[#0d1016] font-mono text-[12px] tabular-nums"
      >
        {totalDisplayRows === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-slate-500">
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
                  className="grid grid-cols-[76px_1fr_28px_1fr_176px] items-center border-b border-white/[0.03] px-3 hover:bg-white/[0.025]"
                >
                  {/* Address */}
                  <div className="text-[11px] text-slate-500">{formatHexAddr(address)}</div>

                  {/* Primary BIN cells */}
                  <div className="flex items-center gap-1 overflow-hidden pr-2">
                    {Array.from({ length: colCount }, (_, colIdx) => {
                      const off = address + colIdx * wordBytes;
                      if (off >= bin.length) {
                        return (
                          <span
                            key={colIdx}
                            className={`inline-block text-center text-slate-700 ${
                              wordFormat === 'u8' ? 'w-6' : 'w-10'
                            }`}
                          >
                            ··
                          </span>
                        );
                      }

                      const diff = isWordDiff(bin, compareBin, off, wordBytes);
                      const span = findCandidateAt(off);
                      const selected =
                        selectedRange !== null &&
                        off < selectedRange[1] &&
                        off + wordBytes > selectedRange[0];

                      const cellCls = selected
                        ? 'bg-[#2589ff]/40 text-white ring-1 ring-[#2589ff]'
                        : diff
                          ? 'bg-sky-500/25 text-sky-200 ring-1 ring-sky-400/40'
                          : span?.role === 'data'
                            ? 'bg-amber-500/12 text-amber-100 ring-1 ring-amber-400/55'
                            : span?.role === 'axis'
                              ? 'bg-teal-500/10 text-teal-200 ring-1 ring-white/25'
                              : 'text-slate-300 hover:bg-white/10';

                      return (
                        <span
                          key={colIdx}
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
                          className={`inline-flex h-5 cursor-pointer items-center justify-center rounded-[4px] text-[11.5px] transition-colors ${
                            wordFormat === 'u8' ? 'w-6' : 'w-10'
                          } ${cellCls}`}
                        >
                          {readWordHex(bin, off, wordFormat)}
                        </span>
                      );
                    })}
                  </div>

                  {/* Center Diff indicator */}
                  <div className="flex justify-center">
                    {compareBin &&
                    Array.from({ length: colCount }, (_, i) =>
                      isWordDiff(bin, compareBin, address + i * wordBytes, wordBytes),
                    ).some(Boolean) ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.85)]" />
                    ) : (
                      <span className="text-[10px] text-slate-700">·</span>
                    )}
                  </div>

                  {/* Comparison BIN cells */}
                  <div className="flex items-center gap-1 overflow-hidden px-2">
                    {compareBin ? (
                      Array.from({ length: colCount }, (_, colIdx) => {
                        const off = address + colIdx * wordBytes;
                        if (off >= compareBin.length) {
                          return (
                            <span
                              key={colIdx}
                              className={`inline-block text-center text-slate-700 ${
                                wordFormat === 'u8' ? 'w-6' : 'w-10'
                              }`}
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
                            className={`inline-flex h-5 cursor-pointer items-center justify-center rounded-[4px] text-[11.5px] ${
                              wordFormat === 'u8' ? 'w-6' : 'w-10'
                            } ${
                              selected
                                ? 'bg-amber-500/30 text-amber-100 ring-1 ring-amber-400/70'
                                : diff
                                  ? 'bg-sky-500/25 text-sky-200 ring-1 ring-sky-400/40'
                                  : 'text-slate-500'
                            }`}
                          >
                            {readWordHex(compareBin, off, wordFormat)}
                          </span>
                        );
                      })
                    ) : (
                      <span className="text-[11px] text-slate-700 italic">
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
                        className="truncate rounded-md border border-sky-400/35 bg-[#2589ff]/15 px-1.5 py-0.5 font-sans text-[10.5px] font-medium text-sky-200 hover:bg-[#2589ff]/30"
                      >
                        {xdf.title}
                      </button>
                    ) : cand ? (
                      <button
                        type="button"
                        onClick={() => onAddCandidateToXdf(cand, true)}
                        title="Click to add candidate to XDF & open in Table Editor"
                        className="inline-flex items-center gap-1 truncate rounded-md border border-amber-400/40 bg-amber-500/15 px-1.5 py-0.5 font-sans text-[10.5px] font-medium text-amber-200 hover:bg-amber-500/25"
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

      {/* Bottom Status Bar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-white/10 bg-[#141821] px-3 py-1.5 text-[11px]">
        <div className="flex flex-wrap items-center gap-3 font-mono text-slate-400 tabular-nums">
          {hoveredInfo ? (
            <>
              <span className="font-semibold text-sky-300">
                0x{formatHexAddr(hoveredInfo.addr)}
              </span>
              <span>
                U8: <strong className="text-slate-200">{hoveredInfo.u8}</strong>
              </span>
              {hoveredInfo.u16le !== null ? (
                <>
                  <span>
                    U16 LoHi: <strong className="text-slate-200">{hoveredInfo.u16le}</strong>
                  </span>
                  <span>
                    HiLo: <strong className="text-slate-200">{hoveredInfo.u16be}</strong>
                  </span>
                </>
              ) : null}
            </>
          ) : (
            <span className="text-slate-500">Hover or drag to inspect bytes</span>
          )}

          {hasSelection && selectedRange ? (
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-amber-300">
              Sel: 0x{formatHexAddr(selectedRange[0])}..0x{formatHexAddr(selectedRange[1])} (
              {selectedRange[1] - selectedRange[0]} B)
            </span>
          ) : null}

          {copyToast ? (
            <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 font-sans text-[10px] font-medium text-emerald-300">
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
            className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-medium text-slate-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Copy className="h-3 w-3" />
            Copy Hex
          </button>
          <button
            type="button"
            disabled={!hasSelection || !compareBin}
            onClick={handleCopyFromCompare}
            className="inline-flex items-center gap-1 rounded-md border border-sky-400/30 bg-[#2589ff]/15 px-2 py-1 text-[11px] font-medium text-sky-200 hover:bg-[#2589ff]/25 disabled:cursor-not-allowed disabled:opacity-35"
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
            className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-medium text-slate-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Search className="h-3 w-3" />
            Twins
          </button>
          <button
            type="button"
            disabled={!hasSelection}
            onClick={handleMapFromSelection}
            className="inline-flex items-center gap-1 rounded-md border border-amber-400/35 bg-amber-500/15 px-2 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-35"
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

      {/* Floating Mini-HUD when hovering over a detected MapCandidate */}
      {hover?.candidate && !contextMenu ? (
        <HexMiniHud
          candidate={hover.candidate}
          bin={bin}
          compareBin={compareBin}
          anchorX={hover.clientX}
          anchorY={hover.clientY}
        />
      ) : null}

      {/* Right-click Glass Context Menu */}
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
        />
      ) : null}
    </div>
  );
};
