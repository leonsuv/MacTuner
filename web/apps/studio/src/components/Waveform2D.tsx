import React, { useEffect, useMemo, useRef } from 'react';
import {
  layoutByteRange,
  type MapCandidate,
  type XDFDefinition,
} from '@mactuner/core';

export type HexWordFormat = 'u8' | 'u16le' | 'u16be';

export interface Waveform2DProps {
  bin: Uint8Array;
  compareBin: Uint8Array | null;
  windowStart: number;
  wordFormat: HexWordFormat;
  candidates: MapCandidate[];
  definition: XDFDefinition | null;
  selectedRange: [number, number] | null;
  onJumpAddress?: (address: number) => void;
}

const SAMPLE_COUNT = 512;
const OVERVIEW_BINS = 320;

function readSample(bytes: Uint8Array, offset: number, format: HexWordFormat): number {
  if (offset < 0 || offset >= bytes.length) return 0;
  if (format === 'u8') return bytes[offset];
  if (offset + 1 >= bytes.length) return bytes[offset];
  return format === 'u16le'
    ? bytes[offset] | (bytes[offset + 1] << 8)
    : (bytes[offset] << 8) | bytes[offset + 1];
}

export const Waveform2D: React.FC<Waveform2DProps> = ({
  bin,
  compareBin,
  windowStart,
  wordFormat,
  candidates,
  definition,
  selectedRange,
  onJumpAddress,
}) => {
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const stepBytes = wordFormat === 'u8' ? 1 : 2;
  const maxVal = wordFormat === 'u8' ? 255 : 65535;
  const windowBytes = SAMPLE_COUNT * stepBytes;
  const windowEnd = Math.min(bin.length, windowStart + windowBytes);

  // Precompute whole-binary overview (entropy/activity + diff density) once per bin/compareBin change
  const overview = useMemo(() => {
    const activity = new Float32Array(OVERVIEW_BINS);
    const diffRatio = new Float32Array(OVERVIEW_BINS);
    if (bin.length === 0) return { activity, diffRatio };

    const chunkSize = Math.max(1, Math.floor(bin.length / OVERVIEW_BINS));
    const cmpLen = compareBin ? Math.min(bin.length, compareBin.length) : 0;

    for (let b = 0; b < OVERVIEW_BINS; b++) {
      const start = Math.floor((b / OVERVIEW_BINS) * bin.length);
      const end = Math.min(bin.length, start + chunkSize);
      const stride = Math.max(1, Math.floor((end - start) / 64));
      let diffs = 0;
      let deltaSum = 0;
      let samples = 0;
      let prev = bin[start] ?? 0;

      for (let i = start; i < end; i += stride) {
        const v = bin[i];
        deltaSum += Math.abs(v - prev);
        prev = v;
        if (compareBin && i < cmpLen && v !== compareBin[i]) {
          diffs++;
        }
        samples++;
      }

      activity[b] = samples > 0 ? Math.min(1, deltaSum / (samples * 96)) : 0;
      diffRatio[b] = samples > 0 ? diffs / samples : 0;
    }

    return { activity, diffRatio };
  }, [bin, compareBin]);

  // Render main 2D waveform canvas
  useEffect(() => {
    const canvas = waveCanvasRef.current;
    const host = containerRef.current;
    if (!canvas || !host) return;

    const draw = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(200, Math.floor(rect.width));
      const height = 112;
      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Background
      ctx.fillStyle = '#0d1016';
      ctx.fillRect(0, 0, width, height);

      const padTop = 18;
      const padBot = 10;
      const plotH = height - padTop - padBot;

      // Horizontal grid lines
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.055)';
      ctx.lineWidth = 1;
      for (let g = 0; g <= 4; g++) {
        const y = Math.round(padTop + (plotH * g) / 4) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      const addrToX = (addr: number) =>
        ((addr - windowStart) / Math.max(1, windowBytes)) * width;

      // 1. Highlight XDF items in view
      if (definition) {
        for (const item of definition.items) {
          const [s, e] = layoutByteRange(item.data);
          if (e <= windowStart || s >= windowEnd) continue;
          const x0 = Math.max(0, addrToX(s));
          const x1 = Math.min(width, addrToX(e));
          const boxW = Math.max(2, x1 - x0);
          ctx.fillStyle = 'rgba(37, 137, 255, 0.14)';
          ctx.fillRect(x0, padTop, boxW, plotH);
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
          ctx.lineWidth = 1;
          ctx.strokeRect(x0 + 0.5, padTop + 0.5, Math.max(1, boxW - 1), plotH - 1);

          if (boxW > 42) {
            ctx.fillStyle = 'rgba(186, 230, 253, 0.9)';
            ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.fillText(item.title.slice(0, 18), x0 + 4, padTop - 5);
          }
        }
      }

      // 2. Highlight detected MapCandidates in view
      for (const c of candidates) {
        const eb = Math.max(1, Math.floor(c.bits / 8));
        const s = c.address;
        const e = s + c.rows * c.cols * eb;
        if (e <= windowStart || s >= windowEnd) continue;
        const x0 = Math.max(0, addrToX(s));
        const x1 = Math.min(width, addrToX(e));
        const boxW = Math.max(2, x1 - x0);
        ctx.fillStyle = 'rgba(245, 158, 11, 0.13)';
        ctx.fillRect(x0, padTop, boxW, plotH);
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.65)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, padTop + 0.5, Math.max(1, boxW - 1), plotH - 1);

        if (boxW > 34) {
          ctx.fillStyle = 'rgba(252, 211, 77, 0.92)';
          ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.fillText(`${c.rows}×${c.cols}`, x0 + 4, padTop + 11);
        }
      }

      // 3. Highlight active selection range
      if (selectedRange && selectedRange[1] > selectedRange[0]) {
        const [s, e] = selectedRange;
        if (e > windowStart && s < windowEnd) {
          const x0 = Math.max(0, addrToX(s));
          const x1 = Math.min(width, addrToX(e));
          ctx.fillStyle = 'rgba(255, 255, 255, 0.09)';
          ctx.fillRect(x0, padTop, Math.max(2, x1 - x0), plotH);
        }
      }

      const count = Math.min(
        SAMPLE_COUNT,
        Math.max(0, Math.floor((bin.length - windowStart) / stepBytes)),
      );
      if (count <= 0) return;

      // 4. Compare binary trace (amber/orange dashed)
      if (compareBin) {
        ctx.save();
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.88)';
        ctx.lineWidth = 1.25;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        for (let i = 0; i < count; i++) {
          const off = windowStart + i * stepBytes;
          const v = readSample(compareBin, off, wordFormat);
          const x = (i / Math.max(1, SAMPLE_COUNT - 1)) * width;
          const y = padTop + (1 - v / maxVal) * plotH;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
      }

      // 5. Primary binary area gradient + crisp sky-blue line
      const areaGrad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
      areaGrad.addColorStop(0, 'rgba(37, 137, 255, 0.24)');
      areaGrad.addColorStop(1, 'rgba(37, 137, 255, 0.01)');

      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const off = windowStart + i * stepBytes;
        const v = readSample(bin, off, wordFormat);
        const x = (i / Math.max(1, SAMPLE_COUNT - 1)) * width;
        const y = padTop + (1 - v / maxVal) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const lastX = ((count - 1) / Math.max(1, SAMPLE_COUNT - 1)) * width;
      ctx.lineTo(lastX, padTop + plotH);
      ctx.lineTo(0, padTop + plotH);
      ctx.closePath();
      ctx.fillStyle = areaGrad;
      ctx.fill();

      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const off = windowStart + i * stepBytes;
        const v = readSample(bin, off, wordFormat);
        const x = (i / Math.max(1, SAMPLE_COUNT - 1)) * width;
        const y = padTop + (1 - v / maxVal) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(host);
    return () => ro.disconnect();
  }, [bin, compareBin, windowStart, windowEnd, windowBytes, wordFormat, stepBytes, maxVal, candidates, definition, selectedRange]);

  // Render bottom overview entropy/diff bar
  useEffect(() => {
    const canvas = overviewCanvasRef.current;
    const host = containerRef.current;
    if (!canvas || !host) return;

    const drawOverview = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(200, Math.floor(rect.width));
      const height = 20;
      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.fillStyle = '#090c11';
      ctx.fillRect(0, 0, width, height);

      const barW = width / OVERVIEW_BINS;
      for (let i = 0; i < OVERVIEW_BINS; i++) {
        const x = i * barW;
        const actH = Math.max(2, overview.activity[i] * (height - 4));
        ctx.fillStyle = 'rgba(148, 163, 184, 0.25)';
        ctx.fillRect(x, height - actH, Math.max(1, barW - 0.5), actH);

        if (overview.diffRatio[i] > 0) {
          const dh = Math.max(4, Math.min(height, overview.diffRatio[i] * height * 2.5));
          ctx.fillStyle = 'rgba(245, 158, 11, 0.85)';
          ctx.fillRect(x, height - dh, Math.max(1.5, barW), dh);
        }
      }

      // Current viewport indicator
      if (bin.length > 0) {
        const vx0 = (windowStart / bin.length) * width;
        const vw = Math.max(6, (windowBytes / bin.length) * width);
        ctx.fillStyle = 'rgba(37, 137, 255, 0.28)';
        ctx.fillRect(vx0, 0, vw, height);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.25;
        ctx.strokeRect(vx0 + 0.5, 0.5, Math.max(4, vw - 1), height - 1);
      }
    };

    drawOverview();
    const ro = new ResizeObserver(drawOverview);
    ro.observe(host);
    return () => ro.disconnect();
  }, [overview, bin.length, windowStart, windowBytes]);

  const handleOverviewClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onJumpAddress || bin.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    const target = Math.floor(ratio * bin.length);
    onJumpAddress(target);
  };

  return (
    <div
      ref={containerRef}
      className="flex shrink-0 flex-col border-t border-white/10 bg-[#0d1016] select-none"
    >
      {/* Mini header strip */}
      <div className="flex items-center justify-between border-b border-white/5 bg-[#141821]/80 px-3 py-1 text-[10px]">
        <div className="flex items-center gap-3 font-mono text-slate-400 tabular-nums">
          <span className="font-semibold text-slate-200">2D Waveform</span>
          <span>
            0x{windowStart.toString(16).toUpperCase().padStart(6, '0')} – 0x
            {windowEnd.toString(16).toUpperCase().padStart(6, '0')}
          </span>
          <span className="text-slate-500">({SAMPLE_COUNT} pts)</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-slate-400">
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-3 rounded-full bg-sky-400" />
            BIN
          </span>
          {compareBin ? (
            <span className="inline-flex items-center gap-1">
              <span className="h-0.5 w-3 border-t-2 border-dashed border-amber-400" />
              Compare
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-xs border border-amber-400/80 bg-amber-500/20" />
            Detected
          </span>
        </div>
      </div>

      {/* Main waveform canvas */}
      <canvas ref={waveCanvasRef} className="block w-full" />

      {/* Mini entropy & diff overview bar */}
      <div className="relative border-t border-white/10">
        <canvas
          ref={overviewCanvasRef}
          onClick={handleOverviewClick}
          title="Click anywhere to jump in binary (amber = diffs)"
          className="block w-full cursor-pointer"
        />
      </div>
    </div>
  );
};
