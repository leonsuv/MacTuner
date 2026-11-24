import React, { useEffect, useMemo, useRef } from 'react';
import { CheckCircle2, Compass, GitCompareArrows, Layers } from 'lucide-react';
import { BinCodec, type MapCandidate } from '@mactuner/core';

export interface HexMiniHudProps {
  candidate: MapCandidate;
  bin: Uint8Array;
  compareBin: Uint8Array | null;
  anchorX: number;
  anchorY: number;
}

function thermalColor(t: number): [number, number, number] {
  const c = Math.max(0, Math.min(1, t));
  // Liquid-glass Pro Dark thermal ramp: deep navy -> electric blue -> cyan -> emerald -> amber -> crimson
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [18, 28, 56]],
    [0.25, [37, 137, 255]],
    [0.5, [34, 211, 238]],
    [0.72, [245, 158, 11]],
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

export const HexMiniHud: React.FC<HexMiniHudProps> = ({
  candidate,
  bin,
  compareBin,
  anchorX,
  anchorY,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const stats = useMemo(() => {
    const layout = candidate.layout;
    const rows = Math.max(1, candidate.rows);
    const cols = Math.max(1, candidate.cols);
    const values = new Float64Array(rows * cols);
    const diffs = new Uint8Array(rows * cols);

    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let validCount = 0;
    let diffCells = 0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const v = BinCodec.raw(layout, { r, c }, bin);
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
          const cv = BinCodec.raw(layout, { r, c }, compareBin);
          if (cv !== null && v !== null && cv !== v) {
            diffs[idx] = 1;
            diffCells++;
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
    };
  }, [candidate, bin, compareBin]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = 248;
    const height = stats.rows === 1 ? 56 : 96;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#0d1016';
    ctx.fillRect(0, 0, width, height);

    const span = stats.max - stats.min || 1;

    if (stats.rows === 1) {
      // 1D Curve Sparkline
      const padX = 6;
      const padY = 8;
      const plotW = width - padX * 2;
      const plotH = height - padY * 2;

      // Subtle grid lines
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      for (let g = 0; g <= 2; g++) {
        const y = padY + (plotH * g) / 2;
        ctx.beginPath();
        ctx.moveTo(padX, y);
        ctx.lineTo(width - padX, y);
        ctx.stroke();
      }

      // Area fill
      const grad = ctx.createLinearGradient(0, padY, 0, height - padY);
      grad.addColorStop(0, 'rgba(37, 137, 255, 0.35)');
      grad.addColorStop(1, 'rgba(37, 137, 255, 0.02)');

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

      // Main stroke
      ctx.beginPath();
      for (let c = 0; c < stats.cols; c++) {
        const t = (stats.values[c] - stats.min) / span;
        const x = padX + (stats.cols > 1 ? (c / (stats.cols - 1)) * plotW : plotW / 2);
        const y = padY + (1 - t) * plotH;
        if (c === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.75;
      ctx.stroke();

      // Diff pips
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
      // 2D Thermal Heatmap Grid
      const cw = width / stats.cols;
      const ch = height / stats.rows;
      for (let r = 0; r < stats.rows; r++) {
        for (let c = 0; c < stats.cols; c++) {
          const idx = r * stats.cols + c;
          const t = (stats.values[idx] - stats.min) / span;
          const [R, G, B] = thermalColor(t);
          ctx.fillStyle = `rgb(${R},${G},${B})`;
          ctx.fillRect(c * cw, r * ch, Math.ceil(cw), Math.ceil(ch));

          if (stats.diffs[idx]) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
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
    }
  }, [stats]);

  // Keep popover inside viewport
  const cardW = 274;
  const cardH = stats.rows === 1 ? 216 : 256;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const left = anchorX + 18 + cardW > vw ? Math.max(12, anchorX - cardW - 14) : anchorX + 18;
  const top = anchorY + 14 + cardH > vh ? Math.max(12, vh - cardH - 12) : anchorY + 14;

  const hasHeaderProof = candidate.evidence === 'Header Proof';
  const confPct = Math.round(Math.max(0, Math.min(1, candidate.confidence)) * 100);
  const endianLabel = candidate.bits === 8 ? '8-bit' : `${candidate.bits}-bit ${candidate.lsbFirst ? 'LoHi' : 'HiLo'}`;
  const elemBytes = Math.max(1, Math.floor(candidate.bits / 8));
  const byteSize = candidate.rows * candidate.cols * elemBytes;

  return (
    <div
      style={{ left, top, width: cardW }}
      className="glass-popover pointer-events-none fixed z-40 rounded-xl p-3 text-slate-200 ring-1 ring-amber-400/25"
    >
      {/* Top row: Title & Confidence */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.8)]" />
          <span className="truncate font-mono text-[12px] font-semibold text-white">
            {candidate.shortBadge || `${candidate.rows}×${candidate.cols}`}
          </span>
        </div>
        <span className="shrink-0 rounded-md bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-300 tabular-nums">
          {confPct}% conf
        </span>
      </div>

      {/* Proof & Encoding pills */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {hasHeaderProof ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-emerald-400/30 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
            <CheckCircle2 className="h-3 w-3" />
            Header Proof
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-slate-300">
            <Layers className="h-3 w-3" />
            {candidate.evidence}
          </span>
        )}
        <span className="rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
          {candidate.isFloat ? 'Float32' : endianLabel}
          {candidate.signed ? ' ±' : ''}
        </span>
        <span className="rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-400 tabular-nums">
          {byteSize} B
        </span>
      </div>

      {/* Thermal Heatmap / Sparkline Canvas */}
      <div className="mb-2.5 overflow-hidden rounded-lg border border-white/10 bg-[#0d1016]">
        <canvas ref={canvasRef} className="block" />
      </div>

      {/* Min / Max / Avg stats */}
      <div className="mb-2 grid grid-cols-3 gap-1.5 rounded-lg bg-white/[0.04] px-2 py-1.5 font-mono text-[10px] tabular-nums">
        <div>
          <div className="text-[9px] uppercase tracking-wider text-slate-500">Min</div>
          <div className="font-semibold text-sky-300">
            {formatNum(stats.min, candidate.isFloat ?? false)}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-slate-500">Avg</div>
          <div className="font-semibold text-slate-200">
            {formatNum(stats.avg, candidate.isFloat ?? false)}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-slate-500">Max</div>
          <div className="font-semibold text-amber-300">
            {formatNum(stats.max, candidate.isFloat ?? false)}
          </div>
        </div>
      </div>

      {/* Addresses & Diff footer */}
      <div className="space-y-1 font-mono text-[10px] text-slate-400 tabular-nums">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1 text-slate-400">
            <Compass className="h-3 w-3 text-sky-400" />
            Data
          </span>
          <span className="text-slate-200">{formatHex(candidate.address)}</span>
        </div>
        {(candidate.xAxisAddress != null || candidate.yAxisAddress != null) && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-teal-300/90">
              X: {candidate.xAxisAddress != null ? formatHex(candidate.xAxisAddress) : '—'}
            </span>
            <span className="text-teal-300/90">
              Y: {candidate.yAxisAddress != null ? formatHex(candidate.yAxisAddress) : '—'}
            </span>
          </div>
        )}
        {compareBin && (
          <div className="flex items-center justify-between border-t border-white/10 pt-1">
            <span className="inline-flex items-center gap-1 text-slate-400">
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
    </div>
  );
};
