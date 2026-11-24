import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Eye, Layers } from 'lucide-react';
import { Cell, parseCellKey } from '@mactuner/core';

export interface Curves2DCanvasProps {
  values: (number | null)[][];
  compareValues?: (number | null)[][] | null;
  xLabels: string[];
  yLabels: string[];
  xValues?: number[];
  units?: string;
  decimals?: number;
  selectedKeys: Set<string>;
  hoveredCell: Cell | null;
  onHoverCell?: (cell: Cell | null) => void;
}

type PlotMode = 'curves' | 'slices';

const SERIES_COLORS = [
  '#38bdf8', // sky
  '#34d399', // emerald
  '#fbbf24', // amber
  '#fb7185', // rose
  '#a78bfa', // violet
  '#fb923c', // orange
  '#2dd4bf', // teal
  '#60a5fa', // blue
];

function formatNum(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(Math.max(0, Math.min(4, decimals)));
}

function sampleIndices(total: number, maxCount: number): number[] {
  if (total <= 0) return [];
  if (total <= maxCount) return Array.from({ length: total }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < maxCount; i++) {
    out.push(Math.round((i / (maxCount - 1)) * (total - 1)));
  }
  return Array.from(new Set(out));
}

export const Curves2DCanvas: React.FC<Curves2DCanvasProps> = ({
  values,
  compareValues = null,
  xLabels,
  yLabels,
  units = '',
  decimals = 1,
  selectedKeys,
  hoveredCell,
  onHoverCell,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 480, h: 240 });
  const [showAll, setShowAll] = useState<boolean>(false);
  const [mode, setMode] = useState<PlotMode>('curves');
  const [showCompare, setShowCompare] = useState<boolean>(true);

  const plottedPtsRef = useRef<{ r: number; c: number; sx: number; sy: number }[]>([]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 10 && height > 10) {
          setSize({ w: Math.floor(width), h: Math.floor(height) });
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = values.length;
  const cols = rows > 0 ? values[0].length : 0;

  // Determine which series indices to plot:
  // - In 'curves' mode: each series is a row (plotted across X columns)
  // - In 'slices' mode: each series is a column (plotted across Y rows)
  const activeIndices = useMemo(() => {
    const isCurves = mode === 'curves';
    const total = isCurves ? rows : cols;
    if (total === 0) return [];

    if (showAll) {
      return Array.from({ length: total }, (_, i) => i);
    }

    if (selectedKeys.size > 0) {
      const idxSet = new Set<number>();
      for (const k of selectedKeys) {
        const cell = parseCellKey(k);
        const idx = isCurves ? cell.r : cell.c;
        if (idx >= 0 && idx < total) idxSet.add(idx);
      }
      if (idxSet.size > 0) {
        return Array.from(idxSet).sort((a, b) => a - b);
      }
    }

    return sampleIndices(total, 6);
  }, [mode, rows, cols, showAll, selectedKeys]);

  // Compute Y-value range for the plotted series
  const { minY, maxY, spanY } = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    const isCurves = mode === 'curves';
    const axisLen = isCurves ? cols : rows;

    for (const sIdx of activeIndices) {
      for (let i = 0; i < axisLen; i++) {
        const r = isCurves ? sIdx : i;
        const c = isCurves ? i : sIdx;
        const v = values[r]?.[c];
        if (v !== null && v !== undefined && Number.isFinite(v)) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
        const cv = compareValues?.[r]?.[c];
        if (showCompare && cv !== null && cv !== undefined && Number.isFinite(cv)) {
          if (cv < min) min = cv;
          if (cv > max) max = cv;
        }
      }
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return { minY: 0, maxY: 1, spanY: 1 };
    }
    const rawSpan = max - min;
    const pad = rawSpan > 1e-9 ? rawSpan * 0.08 : Math.max(1, Math.abs(min) * 0.1);
    const lo = min - pad;
    const hi = max + pad;
    return { minY: lo, maxY: hi, spanY: hi - lo };
  }, [activeIndices, mode, rows, cols, values, compareValues, showCompare]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(size.w * dpr));
    canvas.height = Math.max(1, Math.floor(size.h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const W = size.w;
    const H = size.h;
    ctx.clearRect(0, 0, W, H);

    const isCurves = mode === 'curves';
    const axisLen = isCurves ? cols : rows;
    const axisLabels = isCurves ? xLabels : yLabels;

    if (rows === 0 || cols === 0 || activeIndices.length === 0) {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No curve data', W / 2, H / 2);
      return;
    }

    const padL = 52;
    const padR = 16;
    const padT = 14;
    const padB = 26;
    const plotW = Math.max(20, W - padL - padR);
    const plotH = Math.max(20, H - padT - padB);

    const xFor = (i: number) =>
      axisLen > 1 ? padL + (i / (axisLen - 1)) * plotW : padL + plotW * 0.5;
    const yFor = (v: number) => padT + (1 - (v - minY) / spanY) * plotH;

    // Horizontal grid lines & Y-axis ticks
    ctx.save();
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const frac = i / yTicks;
      const py = padT + frac * plotH;
      const val = maxY - frac * spanY;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(padL + plotW, py);
      ctx.stroke();

      ctx.fillStyle = 'rgba(148, 163, 184, 0.78)';
      ctx.fillText(formatNum(val, decimals), padL - 7, py);
    }

    // Vertical grid lines & X-axis ticks
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTickCount = Math.min(axisLen, Math.max(2, Math.floor(plotW / 62)));
    for (let i = 0; i < xTickCount; i++) {
      const idx = xTickCount === 1 ? 0 : Math.round((i / (xTickCount - 1)) * (axisLen - 1));
      const px = xFor(idx);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, padT);
      ctx.lineTo(px, padT + plotH);
      ctx.stroke();

      ctx.fillStyle = 'rgba(148, 163, 184, 0.78)';
      ctx.fillText(axisLabels[idx] ?? String(idx), px, padT + plotH + 7);
    }

    // Plot border axes
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();
    ctx.restore();

    const pickList: { r: number; c: number; sx: number; sy: number }[] = [];

    // Draw comparison dashed curves first
    if (showCompare && compareValues) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.25;
      activeIndices.forEach((sIdx, seriesPos) => {
        const color = SERIES_COLORS[seriesPos % SERIES_COLORS.length];
        ctx.strokeStyle = `${color}70`;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < axisLen; i++) {
          const r = isCurves ? sIdx : i;
          const c = isCurves ? i : sIdx;
          const v = compareValues[r]?.[c];
          if (v === null || v === undefined || !Number.isFinite(v)) {
            started = false;
            continue;
          }
          const px = xFor(i);
          const py = yFor(v);
          if (!started) {
            ctx.moveTo(px, py);
            started = true;
          } else {
            ctx.lineTo(px, py);
          }
        }
        ctx.stroke();
      });
      ctx.restore();
    }

    // Draw primary series
    activeIndices.forEach((sIdx, seriesPos) => {
      const color = SERIES_COLORS[seriesPos % SERIES_COLORS.length];
      const isHoveredSeries =
        hoveredCell !== null && (isCurves ? hoveredCell.r === sIdx : hoveredCell.c === sIdx);

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = isHoveredSeries ? 2.4 : activeIndices.length > 10 ? 1.15 : 1.75;
      ctx.globalAlpha = hoveredCell && !isHoveredSeries && activeIndices.length > 3 ? 0.55 : 0.95;

      ctx.beginPath();
      let started = false;
      for (let i = 0; i < axisLen; i++) {
        const r = isCurves ? sIdx : i;
        const c = isCurves ? i : sIdx;
        const v = values[r]?.[c];
        if (v === null || v === undefined || !Number.isFinite(v)) {
          started = false;
          continue;
        }
        const px = xFor(i);
        const py = yFor(v);
        pickList.push({ r, c, sx: px, sy: py });
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
      ctx.stroke();

      // Subtle data point nodes when few points
      if (axisLen <= 24 && activeIndices.length <= 8) {
        ctx.fillStyle = color;
        for (let i = 0; i < axisLen; i++) {
          const r = isCurves ? sIdx : i;
          const c = isCurves ? i : sIdx;
          const v = values[r]?.[c];
          if (v === null || v === undefined || !Number.isFinite(v)) continue;
          ctx.beginPath();
          ctx.arc(xFor(i), yFor(v), isHoveredSeries ? 2.8 : 2.0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    });

    plottedPtsRef.current = pickList;

    // Crosshair synced to hoveredCell (3-Way Crosshair Sync)
    if (
      hoveredCell &&
      hoveredCell.r >= 0 &&
      hoveredCell.r < rows &&
      hoveredCell.c >= 0 &&
      hoveredCell.c < cols
    ) {
      const axisIdx = isCurves ? hoveredCell.c : hoveredCell.r;
      const val = values[hoveredCell.r]?.[hoveredCell.c];
      const px = xFor(axisIdx);

      ctx.save();
      // Vertical crosshair line
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(px, padT);
      ctx.lineTo(px, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      if (val !== null && val !== undefined && Number.isFinite(val)) {
        const py = yFor(val);

        // Horizontal hairline
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.25)';
        ctx.beginPath();
        ctx.moveTo(padL, py);
        ctx.lineTo(padL + plotW, py);
        ctx.stroke();

        // Glow ring
        ctx.beginPath();
        ctx.arc(px, py, 9, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(34, 211, 238, 0.25)';
        ctx.fill();

        // Crisp dot
        ctx.beginPath();
        ctx.arc(px, py, 4.2, 0, Math.PI * 2);
        ctx.fillStyle = '#22d3ee';
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
      ctx.restore();
    }
  }, [
    size,
    values,
    compareValues,
    showCompare,
    xLabels,
    yLabels,
    decimals,
    mode,
    activeIndices,
    hoveredCell,
    rows,
    cols,
    minY,
    maxY,
    spanY,
  ]);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!onHoverCell) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      let best: Cell | null = null;
      let bestDistSq = 28 * 28;
      for (const pt of plottedPtsRef.current) {
        const dx = pt.sx - x;
        const dy = pt.sy - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDistSq) {
          bestDistSq = d2;
          best = { r: pt.r, c: pt.c };
        }
      }
      if (best?.r !== hoveredCell?.r || best?.c !== hoveredCell?.c) {
        onHoverCell(best);
      }
    },
    [onHoverCell, hoveredCell],
  );

  const hoveredVal =
    hoveredCell && hoveredCell.r < rows && hoveredCell.c < cols
      ? values[hoveredCell.r]?.[hoveredCell.c] ?? null
      : null;
  const hoveredCmp =
    hoveredCell && compareValues && hoveredCell.r < rows && hoveredCell.c < cols
      ? compareValues[hoveredCell.r]?.[hoveredCell.c] ?? null
      : null;

  const isCurves = mode === 'curves';
  const legendLabels = isCurves ? yLabels : xLabels;

  return (
    <div className="flex flex-col h-full min-h-[240px] rounded-xl bg-[#141821] border border-white/10 overflow-hidden select-none">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-white/10 bg-white/[0.02]">
        <div className="flex items-center gap-2">
          <Activity className="w-3.5 h-3.5 text-[#2589ff]" />
          <span className="text-xs font-semibold tracking-wide text-slate-200">2D Curves</span>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Curves / Slices segmented toggle */}
          <div className="inline-flex rounded-md bg-[#0d1016] p-0.5 border border-white/10">
            <button
              type="button"
              onClick={() => setMode('curves')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                mode === 'curves'
                  ? 'bg-[#2589ff] text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Curves
            </button>
            <button
              type="button"
              onClick={() => setMode('slices')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                mode === 'slices'
                  ? 'bg-[#2589ff] text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Slices
            </button>
          </div>

          {/* Show All toggle */}
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
              showAll
                ? 'bg-[#2589ff]/20 text-sky-300 border-[#2589ff]/45'
                : 'bg-white/[0.04] text-slate-400 border-white/10 hover:text-slate-200'
            }`}
          >
            <Eye className="w-3 h-3" />
            Show All
          </button>

          {compareValues && (
            <button
              type="button"
              onClick={() => setShowCompare((v) => !v)}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
                showCompare
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                  : 'bg-white/[0.04] text-slate-400 border-white/10 hover:text-slate-200'
              }`}
              title="Toggle dashed comparison curves"
            >
              <Layers className="w-3 h-3" />
              Cmp
            </button>
          )}
        </div>
      </div>

      {/* Canvas Area */}
      <div ref={containerRef} className="relative flex-1 min-h-0 w-full">
        <canvas
          ref={canvasRef}
          className="block w-full h-full cursor-crosshair"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => onHoverCell?.(null)}
        />

        {/* Floating crosshair readout */}
        {hoveredCell && hoveredVal !== null && (
          <div className="pointer-events-none absolute top-2 right-2.5 px-2.5 py-1 rounded-lg bg-[#0d1016]/90 border border-cyan-400/35 backdrop-blur-md shadow-lg flex items-center gap-2 text-[11px] font-mono tabular-nums">
            <span className="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_8px_#22d3ee]" />
            <span className="text-slate-400">
              {yLabels[hoveredCell.r] ?? hoveredCell.r} × {xLabels[hoveredCell.c] ?? hoveredCell.c}
            </span>
            <span className="text-cyan-200 font-semibold">
              {formatNum(hoveredVal, decimals)}
              {units ? ` ${units}` : ''}
            </span>
            {hoveredCmp !== null && Math.abs(hoveredVal - hoveredCmp) > 1e-9 && (
              <span className={hoveredVal > hoveredCmp ? 'text-rose-400' : 'text-sky-400'}>
                ({hoveredVal > hoveredCmp ? '+' : ''}
                {formatNum(hoveredVal - hoveredCmp, decimals)})
              </span>
            )}
          </div>
        )}
      </div>

      {/* Row / Slice Legend */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-white/10 bg-[#0d1016]/50 overflow-x-auto">
        <span className="text-[10px] uppercase tracking-wider text-slate-500 shrink-0 mr-1">
          {isCurves ? 'Rows:' : 'Cols:'}
        </span>
        {activeIndices.slice(0, 12).map((idx, pos) => {
          const color = SERIES_COLORS[pos % SERIES_COLORS.length];
          const isHovered =
            hoveredCell !== null && (isCurves ? hoveredCell.r === idx : hoveredCell.c === idx);
          return (
            <span
              key={idx}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono tabular-nums shrink-0 border transition-colors ${
                isHovered
                  ? 'bg-white/10 text-white border-white/25'
                  : 'bg-white/[0.03] text-slate-400 border-white/[0.06]'
              }`}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
              {legendLabels[idx] ?? String(idx)}
            </span>
          );
        })}
        {activeIndices.length > 12 && (
          <span className="text-[10px] font-mono text-slate-500 shrink-0">
            +{activeIndices.length - 12} more
          </span>
        )}
      </div>
    </div>
  );
};

export default Curves2DCanvas;
