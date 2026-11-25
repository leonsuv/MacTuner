import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Minus,
  Plus,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import {
  layoutByteRange,
  type MapCandidate,
  type XDFDefinition,
  type XDFItem,
} from '@mactuner/core';
import { useI18n } from '../lib/i18n';

export type HexWordFormat =
  | 'u8'
  | 'u16le'
  | 'u16be'
  | 'u32le'
  | 'u32be'
  | 'f32le'
  | 'f32be';

export interface Waveform2DProps {
  bin: Uint8Array;
  compareBin: Uint8Array | null;
  windowStart: number;
  wordFormat: HexWordFormat;
  candidates: MapCandidate[];
  definition: XDFDefinition | null;
  selectedRange: [number, number] | null;
  onJumpAddress?: (address: number) => void;
  expanded?: boolean;
  compareShift?: number;
  onCompareShiftChange?: (shift: number) => void;
  onSelectRange?: (range: [number, number] | null) => void;
  onSelectXdfItem?: (id: number) => void;
  onSelectCandidate?: (candidate: MapCandidate) => void;
  signed?: boolean;
}

const ZOOM_STEPS = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384] as const;
const OVERVIEW_BINS = 320;

const f32Buf = new ArrayBuffer(4);
const f32View = new DataView(f32Buf);

export function wordFormatBytes(format: HexWordFormat): number {
  if (format === 'u8') return 1;
  if (format === 'u16le' || format === 'u16be') return 2;
  return 4;
}

function readSample(
  bytes: Uint8Array,
  offset: number,
  format: HexWordFormat,
  signed = false,
): number {
  if (offset < 0 || offset >= bytes.length) return 0;
  if (format === 'u8') {
    const v = bytes[offset];
    return signed && v >= 128 ? v - 256 : v;
  }
  if (format === 'u16le' || format === 'u16be') {
    if (offset + 1 >= bytes.length) return bytes[offset];
    const u =
      format === 'u16le'
        ? bytes[offset] | (bytes[offset + 1] << 8)
        : (bytes[offset] << 8) | bytes[offset + 1];
    return signed && u >= 32768 ? u - 65536 : u;
  }
  if (offset + 3 >= bytes.length) return 0;
  if (format === 'f32le' || format === 'f32be') {
    f32View.setUint8(0, bytes[offset]);
    f32View.setUint8(1, bytes[offset + 1]);
    f32View.setUint8(2, bytes[offset + 2]);
    f32View.setUint8(3, bytes[offset + 3]);
    const val = f32View.getFloat32(0, format === 'f32le');
    return Number.isFinite(val) ? val : 0;
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
  if (signed && u32 >= 0x80000000) return u32 - 0x100000000;
  return u32;
}

function formatSampleVal(v: number, format: HexWordFormat): string {
  if (!Number.isFinite(v)) return '—';
  if (format === 'f32le' || format === 'f32be') {
    return Math.abs(v) >= 1000 || (Math.abs(v) > 0 && Math.abs(v) < 0.01)
      ? v.toExponential(2)
      : v.toFixed(3);
  }
  return Math.round(v).toLocaleString();
}

function formatHexAddr(addr: number): string {
  return `0x${Math.max(0, addr).toString(16).toUpperCase().padStart(6, '0')}`;
}

interface HoverReadout {
  x: number;
  y: number;
  address: number;
  primary: number;
  compare: number | null;
  delta: number | null;
  label: string | null;
  labelKind: 'xdf' | 'cand' | null;
}

type EntropyKind = 0 | 1 | 2 | 3; // 0=empty, 1=ascii, 2=calib, 3=code

export const Waveform2D: React.FC<Waveform2DProps> = ({
  bin,
  compareBin,
  windowStart,
  wordFormat,
  candidates,
  definition,
  selectedRange,
  onJumpAddress,
  expanded = false,
  compareShift: controlledCompareShift,
  onCompareShiftChange,
  onSelectRange,
  onSelectXdfItem,
  onSelectCandidate,
  signed = false,
}) => {
  const { t } = useI18n();
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotHostRef = useRef<HTMLDivElement | null>(null);

  const [sampleCount, setSampleCount] = useState<number>(512);
  const [localCompareShift, setLocalCompareShift] = useState<number>(0);
  const [entropyMode, setEntropyMode] = useState<boolean>(false);
  const [hoverInfo, setHoverInfo] = useState<HoverReadout | null>(null);
  const dragStartAddrRef = useRef<number | null>(null);

  const compareShift = controlledCompareShift ?? localCompareShift;
  const setCompareShift = useCallback(
    (next: number) => {
      const clamped = Math.max(-4096, Math.min(4096, Math.round(next)));
      if (onCompareShiftChange) onCompareShiftChange(clamped);
      else setLocalCompareShift(clamped);
    },
    [onCompareShiftChange],
  );

  const stepBytes = wordFormatBytes(wordFormat);
  const windowBytes = sampleCount * stepBytes;
  const windowEnd = Math.min(bin.length, windowStart + windowBytes);

  // Precompute whole-binary overview (activity, diff density, and Shannon entropy classification)
  const overview = useMemo(() => {
    const activity = new Float32Array(OVERVIEW_BINS);
    const diffRatio = new Float32Array(OVERVIEW_BINS);
    const entropy = new Float32Array(OVERVIEW_BINS);
    const kind = new Uint8Array(OVERVIEW_BINS); // EntropyKind
    if (bin.length === 0) return { activity, diffRatio, entropy, kind };

    const chunkSize = Math.max(1, Math.floor(bin.length / OVERVIEW_BINS));
    const cmpLen = compareBin ? Math.min(bin.length, compareBin.length) : 0;
    const freq = new Uint16Array(256);

    for (let b = 0; b < OVERVIEW_BINS; b++) {
      const start = Math.floor((b / OVERVIEW_BINS) * bin.length);
      const end = Math.min(bin.length, start + chunkSize);
      const stride = Math.max(1, Math.floor((end - start) / 96));
      let diffs = 0;
      let deltaSum = 0;
      let samples = 0;
      let emptyCount = 0;
      let asciiCount = 0;
      let prev = bin[start] ?? 0;
      freq.fill(0);

      for (let i = start; i < end; i += stride) {
        const v = bin[i];
        freq[v]++;
        deltaSum += Math.abs(v - prev);
        prev = v;
        if (v === 0x00 || v === 0xff) emptyCount++;
        if ((v >= 0x20 && v <= 0x7e) || v === 0x09 || v === 0x0a) asciiCount++;
        const cmpIdx = i + compareShift;
        if (compareBin && cmpIdx >= 0 && cmpIdx < cmpLen && v !== compareBin[cmpIdx]) {
          diffs++;
        }
        samples++;
      }

      activity[b] = samples > 0 ? Math.min(1, deltaSum / (samples * 96)) : 0;
      diffRatio[b] = samples > 0 ? diffs / samples : 0;

      // Shannon entropy (0..8 bits)
      let H = 0;
      if (samples > 0) {
        for (let k = 0; k < 256; k++) {
          const c = freq[k];
          if (c > 0) {
            const p = c / samples;
            H -= p * Math.log2(p);
          }
        }
      }
      const normH = Math.min(1, H / 8);
      entropy[b] = normH;

      let kClass: EntropyKind = 2; // calibration
      if (samples === 0 || emptyCount / samples > 0.85 || H < 0.7) {
        kClass = 0; // empty
      } else if (asciiCount / samples > 0.72) {
        kClass = 1; // ASCII
      } else if (H >= 5.6) {
        kClass = 3; // code / compressed
      } else {
        kClass = 2; // calibration data
      }
      kind[b] = kClass;
    }

    return { activity, diffRatio, entropy, kind };
  }, [bin, compareBin, compareShift]);

  // Compute dynamic value bounds for the active window (needed for f32 / u32 / signed)
  const plotBounds = useMemo(() => {
    const count = Math.min(
      sampleCount,
      Math.max(0, Math.floor((bin.length - windowStart) / stepBytes)),
    );
    if (wordFormat === 'u8') {
      return signed ? { min: -128, max: 127 } : { min: 0, max: 255 };
    }
    if (wordFormat === 'u16le' || wordFormat === 'u16be') {
      return signed ? { min: -32768, max: 32767 } : { min: 0, max: 65535 };
    }
    let min = Infinity;
    let max = -Infinity;
    const stride = Math.max(1, Math.floor(count / 512));
    for (let i = 0; i < count; i += stride) {
      const off = windowStart + i * stepBytes;
      const v = readSample(bin, off, wordFormat, signed);
      if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (compareBin) {
        const cv = readSample(compareBin, off + compareShift, wordFormat, signed);
        if (Number.isFinite(cv)) {
          if (cv < min) min = cv;
          if (cv > max) max = cv;
        }
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
      return { min: 0, max: 1 };
    }
    return { min, max };
  }, [bin, compareBin, compareShift, sampleCount, windowStart, stepBytes, wordFormat, signed]);

  const findAnnotationAt = useCallback(
    (addr: number): { xdf: XDFItem | null; cand: MapCandidate | null } => {
      let xdf: XDFItem | null = null;
      if (definition) {
        for (const item of definition.items) {
          const [s, e] = layoutByteRange(item.data);
          if (addr >= s && addr < e) {
            xdf = item;
            break;
          }
        }
      }
      let cand: MapCandidate | null = null;
      for (const c of candidates) {
        const eb = Math.max(1, Math.floor(c.bits / 8));
        if (addr >= c.address && addr < c.address + c.rows * c.cols * eb) {
          cand = c;
          break;
        }
      }
      return { xdf, cand };
    },
    [definition, candidates],
  );

  // Render main 2D waveform canvas
  useEffect(() => {
    const canvas = waveCanvasRef.current;
    const host = plotHostRef.current;
    if (!canvas || !host) return;

    const draw = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(200, Math.floor(rect.width));
      const height = expanded ? Math.max(220, Math.floor(rect.height)) : 124;
      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Recessed Obsidian well
      ctx.fillStyle = '#101115';
      ctx.fillRect(0, 0, width, height);

      const padTop = 18;
      const padBot = 10;
      const plotH = Math.max(24, height - padTop - padBot);

      // Subtle horizontal gridlines
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.045)';
      ctx.lineWidth = 1;
      for (let g = 0; g <= 4; g++) {
        const y = Math.round(padTop + (plotH * g) / 4) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      // Subtle vertical quarter ticks
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.028)';
      for (let q = 1; q < 4; q++) {
        const x = Math.round((width * q) / 4) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, padTop);
        ctx.lineTo(x, padTop + plotH);
        ctx.stroke();
      }

      const addrToX = (addr: number) =>
        ((addr - windowStart) / Math.max(1, windowBytes)) * width;

      // 1. Shaded XDF defined map bands
      if (definition) {
        for (const item of definition.items) {
          const [s, e] = layoutByteRange(item.data);
          if (e <= windowStart || s >= windowEnd) continue;
          const x0 = Math.max(0, addrToX(s));
          const x1 = Math.min(width, addrToX(e));
          const boxW = Math.max(2, x1 - x0);
          ctx.fillStyle = 'rgba(10, 132, 255, 0.12)';
          ctx.fillRect(x0, padTop, boxW, plotH);
          ctx.strokeStyle = 'rgba(10, 132, 255, 0.52)';
          ctx.lineWidth = 1;
          ctx.strokeRect(x0 + 0.5, padTop + 0.5, Math.max(1, boxW - 1), plotH - 1);

          if (boxW > 42) {
            ctx.fillStyle = 'rgba(186, 230, 253, 0.9)';
            ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.fillText(item.title.slice(0, 22), x0 + 4, padTop - 5);
          }
        }
      }

      // 2. Shaded detected MapCandidate bands
      for (const c of candidates) {
        const eb = Math.max(1, Math.floor(c.bits / 8));
        const s = c.address;
        const e = s + c.rows * c.cols * eb;
        if (e <= windowStart || s >= windowEnd) continue;
        const x0 = Math.max(0, addrToX(s));
        const x1 = Math.min(width, addrToX(e));
        const boxW = Math.max(2, x1 - x0);
        ctx.fillStyle = 'rgba(245, 158, 11, 0.11)';
        ctx.fillRect(x0, padTop, boxW, plotH);
        ctx.save();
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.65)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(x0 + 0.5, padTop + 0.5, Math.max(1, boxW - 1), plotH - 1);
        ctx.restore();

        if (boxW > 34) {
          ctx.fillStyle = 'rgba(252, 211, 77, 0.92)';
          ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.fillText(`${c.rows}×${c.cols}`, x0 + 4, padTop + 11);
        }
      }

      // 3. Active selection range band
      if (selectedRange && selectedRange[1] > selectedRange[0]) {
        const [s, e] = selectedRange;
        if (e > windowStart && s < windowEnd) {
          const x0 = Math.max(0, addrToX(s));
          const x1 = Math.min(width, addrToX(e));
          ctx.fillStyle = 'rgba(255, 255, 255, 0.09)';
          ctx.fillRect(x0, padTop, Math.max(2, x1 - x0), plotH);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
          ctx.lineWidth = 1;
          ctx.strokeRect(x0 + 0.5, padTop + 0.5, Math.max(1, x1 - x0 - 1), plotH - 1);
        }
      }

      const count = Math.min(
        sampleCount,
        Math.max(0, Math.floor((bin.length - windowStart) / stepBytes)),
      );
      if (count <= 0) return;

      const span = plotBounds.max - plotBounds.min || 1;
      const valToY = (v: number) => {
        const t = Math.max(0, Math.min(1, (v - plotBounds.min) / span));
        return padTop + (1 - t) * plotH;
      };

      // Downsample cleanly to at most width*1.5 points for crisp 60fps rendering even at 16384 pts
      const drawSteps = Math.min(count, Math.max(256, Math.floor(width * 1.5)));
      const pX = new Float32Array(drawSteps);
      const pY = new Float32Array(drawSteps);
      const cY = compareBin ? new Float32Array(drawSteps) : null;

      for (let i = 0; i < drawSteps; i++) {
        const sampleIdx =
          drawSteps === 1 ? 0 : Math.floor((i / (drawSteps - 1)) * (count - 1));
        const off = windowStart + sampleIdx * stepBytes;
        const x = (sampleIdx / Math.max(1, sampleCount - 1)) * width;
        const pv = readSample(bin, off, wordFormat, signed);
        pX[i] = x;
        pY[i] = valToY(pv);
        if (cY && compareBin) {
          const cv = readSample(compareBin, off + compareShift, wordFormat, signed);
          cY[i] = valToY(cv);
        }
      }

      // 4. Coral (+) / Cyan (-) shaded delta fill polygon between primary & compare traces
      if (cY && drawSteps > 1) {
        for (let i = 0; i < drawSteps - 1; i++) {
          const x0 = pX[i];
          const x1 = pX[i + 1];
          const py0 = pY[i];
          const py1 = pY[i + 1];
          const cy0 = cY[i];
          const cy1 = cY[i + 1];
          const diffAvg = (cy0 - py0 + (cy1 - py1)) * 0.5; // smaller Y = higher value
          if (Math.abs(diffAvg) < 0.5) continue;

          ctx.fillStyle =
            diffAvg > 0
              ? 'rgba(244, 63, 94, 0.28)' // Coral: Primary > Compare (+)
              : 'rgba(34, 211, 238, 0.24)'; // Cyan: Primary < Compare (-)
          ctx.beginPath();
          ctx.moveTo(x0, py0);
          ctx.lineTo(x1, py1);
          ctx.lineTo(x1, cy1);
          ctx.lineTo(x0, cy0);
          ctx.closePath();
          ctx.fill();
        }
      }

      // 5. Warm amber comparison overlay trace
      if (cY) {
        ctx.save();
        ctx.strokeStyle = '#f59e0b';
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        for (let i = 0; i < drawSteps; i++) {
          if (i === 0) ctx.moveTo(pX[i], cY[i]);
          else ctx.lineTo(pX[i], cY[i]);
        }
        ctx.stroke();
        ctx.restore();
      }

      // 6. Primary binary area gradient + luminous #38bdf8 waveform
      const areaGrad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
      areaGrad.addColorStop(0, 'rgba(56, 189, 248, 0.22)');
      areaGrad.addColorStop(0.65, 'rgba(10, 132, 255, 0.06)');
      areaGrad.addColorStop(1, 'rgba(10, 132, 255, 0.0)');

      ctx.beginPath();
      for (let i = 0; i < drawSteps; i++) {
        if (i === 0) ctx.moveTo(pX[i], pY[i]);
        else ctx.lineTo(pX[i], pY[i]);
      }
      ctx.lineTo(pX[drawSteps - 1], padTop + plotH);
      ctx.lineTo(pX[0], padTop + plotH);
      ctx.closePath();
      ctx.fillStyle = areaGrad;
      ctx.fill();

      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < drawSteps; i++) {
        if (i === 0) ctx.moveTo(pX[i], pY[i]);
        else ctx.lineTo(pX[i], pY[i]);
      }
      ctx.shadowColor = 'rgba(56, 189, 248, 0.45)';
      ctx.shadowBlur = 6;
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      // 7. Crosshair overlay when hovering
      if (hoverInfo) {
        const hx = Math.max(0, Math.min(width, hoverInfo.x));
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(Math.round(hx) + 0.5, padTop);
        ctx.lineTo(Math.round(hx) + 0.5, padTop + plotH);
        ctx.stroke();
        ctx.restore();

        const py = valToY(hoverInfo.primary);
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(hx, py, 3, 0, Math.PI * 2);
        ctx.fill();

        if (hoverInfo.compare !== null) {
          const cy = valToY(hoverInfo.compare);
          ctx.fillStyle = '#f59e0b';
          ctx.beginPath();
          ctx.arc(hx, cy, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(host);
    return () => ro.disconnect();
  }, [
    bin,
    compareBin,
    compareShift,
    windowStart,
    windowEnd,
    windowBytes,
    sampleCount,
    wordFormat,
    stepBytes,
    plotBounds,
    candidates,
    definition,
    selectedRange,
    expanded,
    signed,
    hoverInfo,
  ]);

  // Render sleek entropy & diff overview mini-bar
  useEffect(() => {
    const canvas = overviewCanvasRef.current;
    const host = containerRef.current;
    if (!canvas || !host) return;

    const drawOverview = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(200, Math.floor(rect.width));
      const height = 18;
      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.fillStyle = '#0c0d10';
      ctx.fillRect(0, 0, width, height);

      const barW = width / OVERVIEW_BINS;
      for (let i = 0; i < OVERVIEW_BINS; i++) {
        const x = i * barW;
        if (entropyMode) {
          const k = overview.kind[i] as EntropyKind;
          const h = Math.max(3, overview.entropy[i] * (height - 2));
          ctx.fillStyle =
            k === 3
              ? 'rgba(129, 140, 248, 0.78)' // Code (Indigo)
              : k === 2
                ? 'rgba(52, 211, 153, 0.78)' // Calibration (Emerald)
                : k === 1
                  ? 'rgba(251, 191, 36, 0.85)' // ASCII (Amber)
                  : 'rgba(63, 63, 70, 0.45)'; // Empty (Zinc)
          ctx.fillRect(x, height - h, Math.max(1, barW - 0.3), h);
        } else {
          const actH = Math.max(1.5, overview.activity[i] * (height - 4));
          ctx.fillStyle = 'rgba(161, 161, 170, 0.22)';
          ctx.fillRect(x, height - actH, Math.max(1, barW - 0.5), actH);

          if (overview.diffRatio[i] > 0) {
            const dh = Math.max(4, Math.min(height, overview.diffRatio[i] * height * 2.5));
            ctx.fillStyle = 'rgba(245, 158, 11, 0.88)';
            ctx.fillRect(x, height - dh, Math.max(1.5, barW), dh);
          }
        }
      }

      // Apple Blue viewport indicator
      if (bin.length > 0) {
        const vx0 = (windowStart / bin.length) * width;
        const vw = Math.max(8, (windowBytes / bin.length) * width);
        ctx.fillStyle = 'rgba(10, 132, 255, 0.28)';
        ctx.fillRect(vx0, 0, vw, height);
        ctx.strokeStyle = '#0a84ff';
        ctx.lineWidth = 1.25;
        ctx.strokeRect(vx0 + 0.5, 0.5, Math.max(6, vw - 1), height - 1);
      }
    };

    drawOverview();
    const ro = new ResizeObserver(drawOverview);
    ro.observe(host);
    return () => ro.disconnect();
  }, [overview, bin.length, windowStart, windowBytes, entropyMode]);

  // Mouse handlers for waveform canvas (hover crosshair, drag-to-select, wheel zoom, double-click)
  const clientXToAddr = useCallback(
    (clientX: number, rect: DOMRect) => {
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      const raw = windowStart + Math.floor(ratio * sampleCount) * stepBytes;
      return Math.max(0, Math.min(Math.max(0, bin.length - stepBytes), raw));
    },
    [windowStart, sampleCount, stepBytes, bin.length],
  );

  const handleWaveMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const addr = clientXToAddr(e.clientX, rect);
    const primary = readSample(bin, addr, wordFormat, signed);
    const compare =
      compareBin && addr + compareShift >= 0 && addr + compareShift < compareBin.length
        ? readSample(compareBin, addr + compareShift, wordFormat, signed)
        : null;
    const { xdf, cand } = findAnnotationAt(addr);
    setHoverInfo({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      address: addr,
      primary,
      compare,
      delta: compare !== null ? primary - compare : null,
      label: xdf ? xdf.title : cand ? `${cand.rows}×${cand.cols} (${Math.round(cand.confidence * 100)}%)` : null,
      labelKind: xdf ? 'xdf' : cand ? 'cand' : null,
    });

    if (dragStartAddrRef.current !== null && onSelectRange) {
      const a = Math.min(dragStartAddrRef.current, addr);
      const b = Math.min(bin.length, Math.max(dragStartAddrRef.current, addr) + stepBytes);
      onSelectRange([a, b]);
    }
  };

  const handleWaveMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const addr = clientXToAddr(e.clientX, rect);
    dragStartAddrRef.current = addr;
    if (onSelectRange) {
      onSelectRange([addr, Math.min(bin.length, addr + stepBytes)]);
    }
  };

  useEffect(() => {
    const onUp = () => {
      dragStartAddrRef.current = null;
    };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, []);

  const handleWaveDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const addr = clientXToAddr(e.clientX, rect);
    const { xdf, cand } = findAnnotationAt(addr);
    if (xdf && onSelectXdfItem) {
      onSelectXdfItem(xdf.id);
    } else if (cand) {
      if (onSelectCandidate) {
        onSelectCandidate(cand);
      } else if (onSelectRange) {
        const eb = Math.max(1, Math.floor(cand.bits / 8));
        onSelectRange([cand.address, Math.min(bin.length, cand.address + cand.rows * cand.cols * eb)]);
      }
    } else if (onJumpAddress) {
      onJumpAddress(addr);
    }
  };

  const zoomBy = useCallback((dir: -1 | 1) => {
    setSampleCount((prev) => {
      const idx = ZOOM_STEPS.findIndex((s) => s >= prev);
      const cur = idx === -1 ? ZOOM_STEPS.length - 1 : idx;
      const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, cur + dir));
      return ZOOM_STEPS[next];
    });
  }, []);

  const handleWaveWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (Math.abs(e.deltaY) < 4) return;
    e.preventDefault();
    zoomBy(e.deltaY > 0 ? 1 : -1);
  };

  const panWindow = (dir: -1 | 1) => {
    if (!onJumpAddress) return;
    const delta = Math.max(stepBytes, Math.floor(windowBytes * 0.5)) * dir;
    onJumpAddress(Math.max(0, Math.min(Math.max(0, bin.length - stepBytes), windowStart + delta)));
  };

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
      className={`flex flex-col border-t border-white/[0.065] bg-[#101115] select-none ${
        expanded ? 'min-h-0 flex-1' : 'shrink-0'
      }`}
    >
      {/* Mini header strip with Zoom, Pan, Sync Slider, and Entropy Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.065] bg-[#17181d] px-3 py-1 text-[10px]">
        <div className="flex flex-wrap items-center gap-2 font-mono text-zinc-400 tabular-nums">
          <span className="font-sans text-[11px] font-medium text-zinc-200">{t('2D Waveform')}</span>
          <span className="text-zinc-400">
            {formatHexAddr(windowStart)} – {formatHexAddr(windowEnd)}
          </span>

          {/* Zoom (- / +) */}
          <div className="inline-flex items-center rounded-md border border-white/[0.065] bg-[#101115] p-0.5">
            <button
              type="button"
              onClick={() => zoomBy(-1)}
              disabled={sampleCount <= ZOOM_STEPS[0]}
              title={t('Zoom In')}
              className="rounded p-0.5 text-zinc-400 hover:bg-white/[0.08] hover:text-white disabled:opacity-30 cursor-pointer"
            >
              <Plus className="h-3 w-3" />
            </button>
            <span className="px-1.5 text-[10px] text-zinc-300">{sampleCount} pts</span>
            <button
              type="button"
              onClick={() => zoomBy(1)}
              disabled={sampleCount >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
              title={t('Zoom Out')}
              className="rounded p-0.5 text-zinc-400 hover:bg-white/[0.08] hover:text-white disabled:opacity-30 cursor-pointer"
            >
              <Minus className="h-3 w-3" />
            </button>
          </div>

          {/* Pan (< / >) */}
          {onJumpAddress ? (
            <div className="inline-flex items-center rounded-md border border-white/[0.065] bg-[#101115] p-0.5">
              <button
                type="button"
                onClick={() => panWindow(-1)}
                title={t('Pan Left')}
                className="rounded p-0.5 text-zinc-400 hover:bg-white/[0.08] hover:text-white cursor-pointer"
              >
                <ChevronLeft className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => panWindow(1)}
                title={t('Pan Right')}
                className="rounded p-0.5 text-zinc-400 hover:bg-white/[0.08] hover:text-white cursor-pointer"
              >
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          ) : null}

          {/* Manual Compare Sync slider */}
          {compareBin ? (
            <div className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.065] bg-[#101115] px-1.5 py-0.5">
              <span className="text-[9.5px] text-zinc-500">{t('Sync')}</span>
              <input
                type="range"
                min={-4096}
                max={4096}
                step={stepBytes}
                value={Math.max(-4096, Math.min(4096, compareShift))}
                onChange={(e) => setCompareShift(Number(e.target.value))}
                className="h-1 w-20 accent-[#0a84ff] cursor-pointer"
                title={t('Manual Compare Sync Offset (-4096..+4096 B)')}
              />
              <span
                className={`w-12 text-right text-[9.5px] ${
                  compareShift !== 0 ? 'font-semibold text-amber-300' : 'text-zinc-400'
                }`}
              >
                {compareShift >= 0 ? `+${compareShift}` : compareShift}B
              </span>
              {compareShift !== 0 ? (
                <button
                  type="button"
                  onClick={() => setCompareShift(0)}
                  title={t('Reset sync offset to 0')}
                  className="rounded px-1 text-[9.5px] text-zinc-400 hover:bg-white/[0.08] hover:text-white cursor-pointer"
                >
                  <RotateCcw className="h-2.5 w-2.5" />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2.5 text-[10px] text-zinc-400">
          <span className="inline-flex items-center gap-1">
            <span className="h-[2px] w-2.5 rounded-full bg-[#38bdf8]" />
            BIN
          </span>
          {compareBin ? (
            <>
              <span className="inline-flex items-center gap-1">
                <span className="h-0 w-2.5 border-t-[1.5px] border-dashed border-[#f59e0b]" />
                {t('Cmp')}
              </span>
              <span className="inline-flex items-center gap-1 text-rose-300/90">
                <span className="h-2 w-2 rounded-[2px] bg-rose-500/45" />+
              </span>
              <span className="inline-flex items-center gap-1 text-cyan-300/90">
                <span className="h-2 w-2 rounded-[2px] bg-cyan-400/45" />−
              </span>
            </>
          ) : null}

          <button
            type="button"
            onClick={() => setEntropyMode((v) => !v)}
            title={t('Toggle Entropy Map vs Activity/Diff Overview')}
            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
              entropyMode
                ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                : 'border-white/[0.065] bg-[#101115] text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Sparkles className="h-2.5 w-2.5" />
            {t('Entropy')}
          </button>
        </div>
      </div>

      {/* Recessed waveform canvas + Crosshair Hover HUD */}
      <div
        ref={plotHostRef}
        className={`relative w-full ${expanded ? 'min-h-[220px] flex-1' : 'h-[124px]'}`}
      >
        <canvas
          ref={waveCanvasRef}
          onMouseMove={handleWaveMouseMove}
          onMouseDown={handleWaveMouseDown}
          onDoubleClick={handleWaveDoubleClick}
          onWheel={handleWaveWheel}
          onMouseLeave={() => setHoverInfo(null)}
          className="block h-full w-full cursor-crosshair"
        />

        {hoverInfo ? (
          <div
            style={{
              left: Math.min(
                (plotHostRef.current?.clientWidth ?? 600) - 240,
                Math.max(8, hoverInfo.x + 12),
              ),
              top: 6,
            }}
            className="pointer-events-none absolute z-20 flex items-center gap-2 rounded-lg border border-white/[0.1] bg-[#17181d]/92 px-2 py-1 font-mono text-[10px] text-zinc-200 shadow-lg backdrop-blur-md tabular-nums"
          >
            <span className="font-semibold text-sky-300">{formatHexAddr(hoverInfo.address)}</span>
            <span>
              P:<strong className="ml-0.5 text-zinc-100">{formatSampleVal(hoverInfo.primary, wordFormat)}</strong>
            </span>
            {hoverInfo.compare !== null ? (
              <>
                <span>
                  C:<strong className="ml-0.5 text-amber-300">{formatSampleVal(hoverInfo.compare, wordFormat)}</strong>
                </span>
                <span
                  className={
                    hoverInfo.delta && hoverInfo.delta > 0
                      ? 'font-semibold text-rose-300'
                      : hoverInfo.delta && hoverInfo.delta < 0
                        ? 'font-semibold text-cyan-300'
                        : 'text-zinc-500'
                  }
                >
                  Δ{hoverInfo.delta !== null && hoverInfo.delta > 0 ? '+' : ''}
                  {hoverInfo.delta !== null ? formatSampleVal(hoverInfo.delta, wordFormat) : '0'}
                </span>
              </>
            ) : null}
            {hoverInfo.label ? (
              <span
                className={`max-w-[130px] truncate rounded px-1 py-0.2 font-sans text-[9.5px] font-medium ${
                  hoverInfo.labelKind === 'xdf'
                    ? 'bg-[#0a84ff]/20 text-sky-200'
                    : 'bg-amber-500/20 text-amber-200'
                }`}
              >
                {hoverInfo.label}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Sleek entropy & diff overview mini-bar */}
      <div className="relative border-t border-white/[0.065] bg-[#0c0d10]">
        <canvas
          ref={overviewCanvasRef}
          onClick={handleOverviewClick}
          title={
            entropyMode
              ? 'Entropy Overview: Indigo=Code · Emerald=Calibration · Amber=ASCII · Dark=Empty — click to jump'
              : 'Binary activity & diff overview — click anywhere to jump'
          }
          className="block w-full cursor-pointer"
        />
        {entropyMode ? (
          <div className="pointer-events-none absolute right-2 top-0.5 flex items-center gap-2 rounded bg-[#0c0d10]/80 px-1.5 text-[9px] text-zinc-400">
            <span className="text-indigo-300">{t('Code')}</span>
            <span className="text-emerald-300">{t('Calibration')}</span>
            <span className="text-amber-300">ASCII</span>
            <span className="text-zinc-500">{t('Empty')}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
};
