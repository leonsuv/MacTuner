import React, { useEffect, useMemo, useRef } from 'react';
import {
  CheckCircle2,
  Columns3,
  Compass,
  EyeOff,
  FilePlus2,
  GitCompareArrows,
  Layers,
  Pin,
  SlidersHorizontal,
  Table2,
  X,
} from 'lucide-react';
import {
  BinCodec,
  scalingFormat,
  scalingValue,
  type Axis,
  type HeatmapPalette as CoreHeatmapPalette,
  type MapCandidate,
  type XDFItem,
} from '@mactuner/core';

export type HeatmapPalette = CoreHeatmapPalette | 'thermal' | 'ocean' | 'grayscale';

export interface HexMiniHudProps {
  candidate?: MapCandidate | null;
  xdfItem?: XDFItem | null;
  bin: Uint8Array;
  compareBin: Uint8Array | null;
  anchorX: number;
  anchorY: number;
  pinned?: boolean;
  onUnpin?: () => void;
  onAddToXdf?: (candidate: MapCandidate, openEditor: boolean) => void;
  onEditInXdf?: (candidate: MapCandidate) => void;
  onOpenXdfItem?: (item: XDFItem) => void;
  onSetCols?: (cols: number) => void;
  onIgnoreCandidate?: (candidate: MapCandidate) => void;
  heatmapPalette?: HeatmapPalette;
}

function samplePalette(t: number, palette: HeatmapPalette = 'thermal'): [number, number, number] {
  const c = Math.max(0, Math.min(1, t));
  if (palette === 'grayscale') {
    const v = Math.round(28 + c * 215);
    return [v, v, v];
  }
  const stops: Array<[number, [number, number, number]]> =
    palette === 'viridis'
      ? [
          [0.0, [68, 1, 84]],
          [0.25, [59, 82, 139]],
          [0.5, [33, 145, 140]],
          [0.75, [94, 201, 98]],
          [1.0, [253, 231, 37]],
        ]
      : palette === 'plasma'
        ? [
            [0.0, [13, 8, 135]],
            [0.33, [156, 23, 158]],
            [0.66, [237, 121, 83]],
            [1.0, [240, 249, 33]],
          ]
        : palette === 'cividis'
          ? [
              [0.0, [0, 32, 77]],
              [0.33, [65, 77, 107]],
              [0.66, [155, 148, 118]],
              [1.0, [253, 234, 69]],
            ]
          : palette === 'high-contrast'
            ? [
                [0.0, [12, 18, 36]],
                [0.35, [0, 160, 255]],
                [0.7, [255, 220, 0]],
                [1.0, [255, 45, 85]],
              ]
            : palette === 'ocean'
              ? [
                  [0.0, [15, 23, 42]],
                  [0.35, [3, 105, 161]],
                  [0.7, [34, 211, 238]],
                  [1.0, [224, 242, 254]],
                ]
              : [
                  [0.0, [24, 28, 44]],
                  [0.2, [10, 132, 255]],
                  [0.44, [34, 211, 238]],
                  [0.64, [52, 211, 153]],
                  [0.82, [251, 191, 36]],
                  [1.0, [244, 63, 94]],
                ];

  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i];
    const [p1, c1] = stops[i + 1];
    if (c >= p0 && c <= p1) {
      const f = (c - p0) / (p1 - p0 || 1);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

function formatNum(v: number, isFloat: boolean): string {
  if (!Number.isFinite(v)) return '—';
  if (isFloat) return v.toFixed(2);
  return Math.abs(v) >= 1000 ? v.toFixed(0) : Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function formatHex(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(6, '0')}`;
}

function axisEndpoints(axis: Axis, bin: Uint8Array): string | null {
  if (axis.count <= 0) return null;
  if (axis.source.kind === 'labels') {
    const labels = axis.source.labels;
    if (labels.length === 0) return null;
    if (labels.length === 1) return `[${labels[0]}]`;
    return `[${labels[0]}…${labels[labels.length - 1]}]`;
  }
  if (axis.source.kind === 'data') {
    const firstRaw = BinCodec.raw(axis.source.layout, { r: 0, c: 0 }, bin);
    const lastIdx = Math.max(0, axis.count - 1);
    const lastCell =
      axis.source.layout.rows > 1 ? { r: lastIdx, c: 0 } : { r: 0, c: lastIdx };
    const lastRaw = BinCodec.raw(axis.source.layout, lastCell, bin);
    if (firstRaw === null || lastRaw === null) return null;
    const f = scalingFormat(axis.scaling, scalingValue(axis.scaling, firstRaw));
    const l = scalingFormat(axis.scaling, scalingValue(axis.scaling, lastRaw));
    return `[${f}…${l}]${axis.scaling.units ? ` ${axis.scaling.units}` : ''}`;
  }
  return null;
}

export const HexMiniHud: React.FC<HexMiniHudProps> = ({
  candidate = null,
  xdfItem = null,
  bin,
  compareBin,
  anchorX,
  anchorY,
  pinned = false,
  onUnpin,
  onAddToXdf,
  onEditInXdf,
  onOpenXdfItem,
  onSetCols,
  onIgnoreCandidate,
  heatmapPalette = 'thermal',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const activeLayout = xdfItem ? xdfItem.data : candidate ? candidate.layout : null;

  const stats = useMemo(() => {
    if (!activeLayout) {
      return {
        rows: 1,
        cols: 1,
        values: new Float64Array(1),
        diffs: new Uint8Array(1),
        min: 0,
        max: 0,
        avg: 0,
        diffCells: 0,
        totalCells: 1,
        maxDeltaPct: 0,
      };
    }

    const rows = Math.max(1, activeLayout.rows);
    const cols = Math.max(1, activeLayout.cols);
    const values = new Float64Array(rows * cols);
    const diffs = new Uint8Array(rows * cols);

    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let validCount = 0;
    let diffCells = 0;
    let maxDeltaPct = 0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const raw = BinCodec.raw(activeLayout, { r, c }, bin);
        const v =
          raw !== null && Number.isFinite(raw)
            ? xdfItem
              ? scalingValue(xdfItem.scaling, raw)
              : raw
            : null;
        if (v !== null && Number.isFinite(v)) {
          values[idx] = v;
          if (v < min) min = v;
          if (v > max) max = v;
          sum += v;
          validCount++;
        } else {
          values[idx] = 0;
        }
        if (compareBin) {
          const craw = BinCodec.raw(activeLayout, { r, c }, compareBin);
          if (craw !== null && raw !== null && craw !== raw) {
            diffs[idx] = 1;
            diffCells++;
            const cv = xdfItem ? scalingValue(xdfItem.scaling, craw) : craw;
            if (v !== null && Number.isFinite(cv)) {
              const denom = Math.abs(cv) > 1e-6 ? Math.abs(cv) : Math.abs(v) > 1e-6 ? Math.abs(v) : 1;
              const pct = (Math.abs(v - cv) / denom) * 100;
              if (pct > maxDeltaPct) maxDeltaPct = pct;
            }
          }
        }
      }
    }

    const avg = validCount > 0 ? sum / validCount : 0;
    return {
      rows,
      cols,
      values,
      diffs,
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : 0,
      avg,
      diffCells,
      totalCells: rows * cols,
      maxDeltaPct,
    };
  }, [activeLayout, xdfItem, bin, compareBin]);

  const xdfAxesPreview = useMemo(() => {
    if (!xdfItem || xdfItem.itemKind.kind !== 'table') return null;
    return {
      x: axisEndpoints(xdfItem.itemKind.x, bin),
      y: xdfItem.data.rows > 1 ? axisEndpoints(xdfItem.itemKind.y, bin) : null,
    };
  }, [xdfItem, bin]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeLayout) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = 256;
    const height = stats.rows === 1 ? 56 : 96;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#101115';
    ctx.fillRect(0, 0, width, height);

    const span = stats.max - stats.min || 1;

    if (stats.rows === 1) {
      const padX = 6;
      const padY = 8;
      const plotW = width - padX * 2;
      const plotH = height - padY * 2;

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      for (let g = 0; g <= 2; g++) {
        const y = Math.round(padY + (plotH * g) / 2) + 0.5;
        ctx.beginPath();
        ctx.moveTo(padX, y);
        ctx.lineTo(width - padX, y);
        ctx.stroke();
      }

      const grad = ctx.createLinearGradient(0, padY, 0, height - padY);
      grad.addColorStop(0, 'rgba(10, 132, 255, 0.34)');
      grad.addColorStop(1, 'rgba(10, 132, 255, 0.0)');

      ctx.beginPath();
      for (let c = 0; c < stats.cols; c++) {
        const t = (stats.values[c] - stats.min) / span;
        const x = padX + (stats.cols > 1 ? (c / (stats.cols - 1)) * plotW : plotW / 2);
        const y = padY + (1 - t) * plotH;
        if (c === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineTo(padX + plotW, height - padY);
      ctx.lineTo(padX, height - padY);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.save();
      ctx.beginPath();
      for (let c = 0; c < stats.cols; c++) {
        const t = (stats.values[c] - stats.min) / span;
        const x = padX + (stats.cols > 1 ? (c / (stats.cols - 1)) * plotW : plotW / 2);
        const y = padY + (1 - t) * plotH;
        if (c === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.shadowColor = 'rgba(56, 189, 248, 0.55)';
      ctx.shadowBlur = 5;
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.75;
      ctx.stroke();
      ctx.restore();

      for (let c = 0; c < stats.cols; c++) {
        if (!stats.diffs[c]) continue;
        const t = (stats.values[c] - stats.min) / span;
        const x = padX + (stats.cols > 1 ? (c / (stats.cols - 1)) * plotW : plotW / 2);
        const y = padY + (1 - t) * plotH;
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      const cw = width / stats.cols;
      const ch = height / stats.rows;
      for (let r = 0; r < stats.rows; r++) {
        for (let c = 0; c < stats.cols; c++) {
          const idx = r * stats.cols + c;
          const t = (stats.values[idx] - stats.min) / span;
          const [R, G, B] = samplePalette(t, heatmapPalette);
          ctx.fillStyle = `rgb(${R},${G},${B})`;
          ctx.fillRect(c * cw, r * ch, Math.ceil(cw), Math.ceil(ch));

          if (stats.diffs[idx]) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
            const pip = Math.max(1.5, Math.min(cw, ch) * 0.28);
            ctx.fillRect(
              c * cw + (cw - pip) * 0.5,
              r * ch + (ch - pip) * 0.5,
              pip,
              pip,
            );
          }
        }
      }

      if (cw >= 10 && ch >= 8) {
        ctx.strokeStyle = 'rgba(12, 13, 16, 0.24)';
        ctx.lineWidth = 0.75;
        for (let c = 1; c < stats.cols; c++) {
          const x = Math.round(c * cw) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
        for (let r = 1; r < stats.rows; r++) {
          const y = Math.round(r * ch) + 0.5;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
          ctx.stroke();
        }
      }
    }
  }, [stats, activeLayout, heatmapPalette]);

  if (!activeLayout) return null;

  const isXdf = xdfItem !== null;
  const cardW = 282;
  const cardH = (stats.rows === 1 ? 224 : 268) + (pinned ? 42 : 0);
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const left = anchorX + 18 + cardW > vw ? Math.max(12, anchorX - cardW - 14) : anchorX + 18;
  const top = anchorY + 14 + cardH > vh ? Math.max(12, vh - cardH - 12) : anchorY + 14;

  const elemBytes = Math.max(1, Math.floor(activeLayout.bits / 8));
  const byteSize = activeLayout.rows * activeLayout.cols * elemBytes;
  const endianLabel =
    activeLayout.bits === 8
      ? '8-bit'
      : `${activeLayout.bits}-bit ${activeLayout.lsbFirst ? 'LoHi' : 'HiLo'}`;
  const isFloat = activeLayout.isFloat || (xdfItem ? xdfItem.scaling.decimals > 0 : false);

  const hasHeaderProof = candidate?.evidence === 'Header Proof';
  const confPct = candidate
    ? Math.round(Math.max(0, Math.min(1, candidate.confidence)) * 100)
    : 100;

  return (
    <div
      style={{ left, top, width: cardW }}
      onMouseDown={(e) => {
        if (pinned) e.stopPropagation();
      }}
      className={`glass-popover fixed z-40 rounded-xl p-3 text-zinc-100 ${
        pinned
          ? 'pointer-events-auto ring-1 ring-[#0a84ff]/55 shadow-[0_18px_48px_rgba(0,0,0,0.7)]'
          : 'pointer-events-none'
      }`}
    >
      {/* Top row: Title & Confidence / XDF Badge & Unpin */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              isXdf
                ? 'bg-[#0a84ff] shadow-[0_0_8px_rgba(10,132,255,0.8)]'
                : 'bg-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.75)]'
            }`}
          />
          <span className="truncate font-mono text-[12px] font-semibold tracking-tight text-zinc-100">
            {isXdf
              ? xdfItem.title
              : candidate?.shortBadge || `${activeLayout.rows}×${activeLayout.cols}`}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {pinned ? (
            <span className="inline-flex items-center gap-0.5 rounded bg-[#0a84ff]/20 px-1 py-0.5 text-[9.5px] font-medium text-sky-300">
              <Pin className="h-2.5 w-2.5" />
            </span>
          ) : null}
          {isXdf ? (
            <span className="rounded-md border border-[#0a84ff]/35 bg-[#0a84ff]/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-sky-300 tabular-nums">
              {activeLayout.rows}×{activeLayout.cols}
            </span>
          ) : (
            <span className="rounded-md border border-amber-400/25 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-300 tabular-nums">
              {confPct}%
            </span>
          )}
          {pinned && onUnpin ? (
            <button
              type="button"
              onClick={onUnpin}
              title="Unpin HUD"
              className="rounded p-0.5 text-zinc-400 hover:bg-white/[0.1] hover:text-white cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Proof & Encoding pills */}
      <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
        {isXdf ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-[#0a84ff]/30 bg-[#0a84ff]/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-200">
            <Table2 className="h-3 w-3" />
            XDF Map
          </span>
        ) : hasHeaderProof ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-emerald-400/25 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
            <CheckCircle2 className="h-3 w-3" />
            Header Proof
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-md border border-white/[0.065] bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-zinc-300">
            <Layers className="h-3 w-3 text-zinc-400" />
            {candidate?.evidence ?? 'Pattern'}
          </span>
        )}
        <span className="rounded-md border border-white/[0.065] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
          {activeLayout.isFloat ? 'Float32' : endianLabel}
          {activeLayout.signed ? ' ±' : ''}
        </span>
        <span className="rounded-md border border-white/[0.065] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 tabular-nums">
          {byteSize} B
        </span>
        {compareBin && stats.diffCells > 0 ? (
          <span className="rounded-md border border-amber-400/30 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-300 tabular-nums">
            max Δ {stats.maxDeltaPct >= 100 ? stats.maxDeltaPct.toFixed(0) : stats.maxDeltaPct.toFixed(1)}%
          </span>
        ) : null}
      </div>

      {/* Thermal Heatmap / Sparkline Canvas */}
      <div className="mb-2.5 overflow-hidden rounded-lg border border-white/[0.08] bg-[#101115] shadow-inner">
        <canvas ref={canvasRef} className="block" />
      </div>

      {/* Min / Avg / Max stats */}
      <div className="mb-2 grid grid-cols-3 gap-1.5 rounded-lg border border-white/[0.065] bg-[#101115]/90 px-2.5 py-1.5 font-mono text-[10px] tabular-nums">
        <div>
          <div className="text-[9px] uppercase tracking-wider text-zinc-500">Min</div>
          <div className="font-semibold text-sky-300">{formatNum(stats.min, isFloat)}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-zinc-500">Avg</div>
          <div className="font-semibold text-zinc-100">{formatNum(stats.avg, isFloat)}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-zinc-500">Max</div>
          <div className="font-semibold text-amber-300">{formatNum(stats.max, isFloat)}</div>
        </div>
      </div>

      {/* Addresses, Axis Previews & Diff footer */}
      <div className="space-y-1 font-mono text-[10px] text-zinc-400 tabular-nums">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1 text-zinc-500">
            <Compass className="h-3 w-3 text-[#0a84ff]" />
            Data
          </span>
          <span className="text-zinc-200">{formatHex(activeLayout.address)}</span>
        </div>

        {isXdf && xdfAxesPreview && (xdfAxesPreview.x || xdfAxesPreview.y) ? (
          <div className="space-y-0.5 text-[9.5px] text-zinc-400">
            {xdfAxesPreview.x ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-zinc-500">X Axis</span>
                <span className="truncate text-zinc-200">{xdfAxesPreview.x}</span>
              </div>
            ) : null}
            {xdfAxesPreview.y ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-zinc-500">Y Axis</span>
                <span className="truncate text-zinc-200">{xdfAxesPreview.y}</span>
              </div>
            ) : null}
          </div>
        ) : !isXdf &&
          candidate &&
          (candidate.xAxisAddress != null || candidate.yAxisAddress != null) ? (
          <div className="flex items-center justify-between gap-2 text-zinc-400">
            <span>
              X:{' '}
              <span className="text-zinc-200">
                {candidate.xAxisAddress != null ? formatHex(candidate.xAxisAddress) : '—'}
              </span>
            </span>
            <span>
              Y:{' '}
              <span className="text-zinc-200">
                {candidate.yAxisAddress != null ? formatHex(candidate.yAxisAddress) : '—'}
              </span>
            </span>
          </div>
        ) : null}

        {compareBin && (
          <div className="flex items-center justify-between border-t border-white/[0.065] pt-1.5">
            <span className="inline-flex items-center gap-1 text-zinc-400">
              <GitCompareArrows className="h-3 w-3 text-amber-400" />
              Diff vs Compare
            </span>
            <span
              className={
                stats.diffCells > 0 ? 'font-semibold text-amber-300' : 'text-emerald-400'
              }
            >
              {stats.diffCells > 0
                ? `${stats.diffCells} / ${stats.totalCells} cells`
                : 'Identical'}
            </span>
          </div>
        )}
      </div>

      {/* Pinned Interactive Action Row */}
      {pinned ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-white/[0.08] pt-2">
          {isXdf && xdfItem ? (
            <>
              {onOpenXdfItem ? (
                <button
                  type="button"
                  onClick={() => {
                    onOpenXdfItem(xdfItem);
                    onUnpin?.();
                  }}
                  className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-[#0a84ff]/45 bg-[#0a84ff]/20 px-2 py-1 text-[10.5px] font-medium text-sky-100 hover:bg-[#0a84ff]/35 cursor-pointer"
                >
                  <Table2 className="h-3 w-3" />
                  Open Editor
                </button>
              ) : null}
              {onSetCols ? (
                <button
                  type="button"
                  onClick={() => onSetCols(activeLayout.cols)}
                  className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.05] px-2 py-1 font-mono text-[10px] text-zinc-200 hover:bg-white/[0.12] cursor-pointer"
                >
                  <Columns3 className="h-3 w-3" />
                  Cols={activeLayout.cols}
                </button>
              ) : null}
            </>
          ) : candidate ? (
            <>
              {onAddToXdf ? (
                <button
                  type="button"
                  onClick={() => {
                    onAddToXdf(candidate, false);
                    onUnpin?.();
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-amber-400/40 bg-amber-500/20 px-2 py-1 text-[10.5px] font-medium text-amber-200 hover:bg-amber-500/30 cursor-pointer"
                >
                  <FilePlus2 className="h-3 w-3" />
                  Add to XDF
                </button>
              ) : null}
              {onEditInXdf ? (
                <button
                  type="button"
                  onClick={() => {
                    onEditInXdf(candidate);
                    onUnpin?.();
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-[#0a84ff]/40 bg-[#0a84ff]/20 px-2 py-1 text-[10.5px] font-medium text-sky-200 hover:bg-[#0a84ff]/30 cursor-pointer"
                >
                  <SlidersHorizontal className="h-3 w-3" />
                  Edit in XDF…
                </button>
              ) : null}
              {onSetCols ? (
                <button
                  type="button"
                  onClick={() => onSetCols(candidate.cols)}
                  className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.05] px-2 py-1 font-mono text-[10px] text-zinc-200 hover:bg-white/[0.12] cursor-pointer"
                >
                  <Columns3 className="h-3 w-3" />
                  Cols={candidate.cols}
                </button>
              ) : null}
              {onIgnoreCandidate ? (
                <button
                  type="button"
                  onClick={() => {
                    onIgnoreCandidate(candidate);
                    onUnpin?.();
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-rose-400/30 bg-rose-500/15 px-2 py-1 text-[10.5px] font-medium text-rose-300 hover:bg-rose-500/25 cursor-pointer"
                >
                  <EyeOff className="h-3 w-3" />
                  Ignore
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
