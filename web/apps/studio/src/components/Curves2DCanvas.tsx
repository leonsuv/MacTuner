import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Binary,
  Check,
  Eye,
  Grid,
  Layers,
  Lock,
  RotateCcw,
  Settings2,
  Sparkles,
} from 'lucide-react';
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
  onEditCell?: (cell: Cell, newValue: number) => void;
  isLocked?: boolean;
  /** Optional live datalog active cell crosshair indicator */
  datalogActiveCell?: Cell | null;
  /** Optional callbacks for right-click context menu */
  onSelectAll?: () => void;
  onSmoothSelection?: () => void;
  onResetToOriginal?: () => void;
  onJumpToHex?: () => void;
  onOpenXdfEditor?: () => void;
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

/** Trace a smooth Catmull-Rom spline through 2D points */
function traceSmoothPath(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[]) {
  if (pts.length === 0) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) return;
  if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
    return;
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }
}

interface CurveDragState {
  cell: Cell;
  startVal: number;
  liveVal: number;
  lockedMinY: number;
  lockedMaxY: number;
  lockedSpanY: number;
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
  onEditCell,
  isLocked = false,
  datalogActiveCell = null,
  onSelectAll,
  onSmoothSelection,
  onResetToOriginal,
  onJumpToHex,
  onOpenXdfEditor,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 480, h: 240 });
  const [showAll, setShowAll] = useState<boolean>(false);
  const [mode, setMode] = useState<PlotMode>('curves');
  const [showCompare, setShowCompare] = useState<boolean>(true);
  const [dragState, setDragState] = useState<CurveDragState | null>(null);
  const [nearDraggable, setNearDraggable] = useState<boolean>(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const canEdit = Boolean(onEditCell && !isLocked);

  const plottedPtsRef = useRef<{ r: number; c: number; sx: number; sy: number }[]>([]);
  const plotBoundsRef = useRef<{ padT: number; plotH: number; minY: number; maxY: number; spanY: number }>({
    padT: 16,
    plotH: 198,
    minY: 0,
    maxY: 1,
    spanY: 1,
  });

  // Close context menu on outside click or Escape
  useEffect(() => {
    if (!contextMenu) return;
    const onDown = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  // Cancel active drag on Escape or if editing becomes disabled
  useEffect(() => {
    if (!canEdit && dragState) setDragState(null);
  }, [canEdit, dragState]);

  useEffect(() => {
    if (!dragState) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDragState(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dragState]);

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
    const pad = rawSpan > 1e-9 ? rawSpan * 0.09 : Math.max(1, Math.abs(min) * 0.1);
    const lo = min - pad;
    const hi = max + pad;
    return { minY: lo, maxY: hi, spanY: hi - lo };
  }, [activeIndices, mode, rows, cols, values, compareValues, showCompare]);

  const effectiveMinY = dragState ? dragState.lockedMinY : minY;
  const effectiveMaxY = dragState ? dragState.lockedMaxY : maxY;
  const effectiveSpanY = dragState ? dragState.lockedSpanY : spanY;

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
      ctx.fillStyle = 'rgba(161, 161, 170, 0.6)';
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No curve data', W / 2, H / 2);
      return;
    }

    const padL = 52;
    const padR = 16;
    const padT = 16;
    const padB = 26;
    const plotW = Math.max(20, W - padL - padR);
    const plotH = Math.max(20, H - padT - padB);

    plotBoundsRef.current = {
      padT,
      plotH,
      minY: effectiveMinY,
      maxY: effectiveMaxY,
      spanY: effectiveSpanY,
    };

    const getCellVal = (r: number, c: number): number | null | undefined => {
      if (dragState && dragState.cell.r === r && dragState.cell.c === c) {
        return dragState.liveVal;
      }
      return values[r]?.[c];
    };

    const xFor = (i: number) =>
      axisLen > 1 ? padL + (i / (axisLen - 1)) * plotW : padL + plotW * 0.5;
    const yFor = (v: number) => padT + (1 - (v - effectiveMinY) / effectiveSpanY) * plotH;

    // Grid lines & Y-axis ticks
    ctx.save();
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const frac = i / yTicks;
      const py = padT + frac * plotH;
      const val = effectiveMaxY - frac * effectiveSpanY;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.045)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(padL + plotW, py);
      ctx.stroke();

      ctx.fillStyle = 'rgba(161, 161, 170, 0.72)';
      ctx.fillText(formatNum(val, decimals), padL - 7, py);
    }

    // Vertical grid lines & X-axis ticks
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTickCount = Math.min(axisLen, Math.max(2, Math.floor(plotW / 64)));
    for (let i = 0; i < xTickCount; i++) {
      const idx = xTickCount === 1 ? 0 : Math.round((i / (xTickCount - 1)) * (axisLen - 1));
      const px = xFor(idx);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, padT);
      ctx.lineTo(px, padT + plotH);
      ctx.stroke();

      ctx.fillStyle = 'rgba(161, 161, 170, 0.72)';
      ctx.fillText(axisLabels[idx] ?? String(idx), px, padT + plotH + 7);
    }

    // Plot border axes
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();
    ctx.restore();

    const pickList: { r: number; c: number; sx: number; sy: number }[] = [];

    // Draw comparison dashed smooth curves first
    if (showCompare && compareValues) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.25;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      activeIndices.forEach((sIdx, seriesPos) => {
        const color = SERIES_COLORS[seriesPos % SERIES_COLORS.length];
        ctx.strokeStyle = `${color}66`;
        let seg: { x: number; y: number }[] = [];
        const flush = () => {
          if (seg.length >= 2) {
            ctx.beginPath();
            traceSmoothPath(ctx, seg);
            ctx.stroke();
          }
          seg = [];
        };
        for (let i = 0; i < axisLen; i++) {
          const r = isCurves ? sIdx : i;
          const c = isCurves ? i : sIdx;
          const v = compareValues[r]?.[c];
          if (v === null || v === undefined || !Number.isFinite(v)) {
            flush();
            continue;
          }
          seg.push({ x: xFor(i), y: yFor(v) });
        }
        flush();
      });
      ctx.restore();
    }

    const activeCell = dragState ? dragState.cell : hoveredCell;

    // Draw primary smooth series
    activeIndices.forEach((sIdx, seriesPos) => {
      const color = SERIES_COLORS[seriesPos % SERIES_COLORS.length];
      const isHoveredSeries =
        activeCell !== null && (isCurves ? activeCell.r === sIdx : activeCell.c === sIdx);

      const segments: { x: number; y: number }[][] = [];
      let curSeg: { x: number; y: number }[] = [];
      for (let i = 0; i < axisLen; i++) {
        const r = isCurves ? sIdx : i;
        const c = isCurves ? i : sIdx;
        const v = getCellVal(r, c);
        if (v === null || v === undefined || !Number.isFinite(v)) {
          if (curSeg.length > 0) {
            segments.push(curSeg);
            curSeg = [];
          }
          continue;
        }
        const px = xFor(i);
        const py = yFor(v);
        pickList.push({ r, c, sx: px, sy: py });
        curSeg.push({ x: px, y: py });
      }
      if (curSeg.length > 0) segments.push(curSeg);

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Subtle luminous area fill under hovered series (or sole series)
      if ((isHoveredSeries || activeIndices.length === 1) && segments.length > 0) {
        for (const seg of segments) {
          if (seg.length < 2) continue;
          const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
          grad.addColorStop(0, `${color}28`);
          grad.addColorStop(1, `${color}00`);
          ctx.beginPath();
          traceSmoothPath(ctx, seg);
          ctx.lineTo(seg[seg.length - 1].x, padT + plotH);
          ctx.lineTo(seg[0].x, padT + plotH);
          ctx.closePath();
          ctx.fillStyle = grad;
          ctx.fill();
        }
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = isHoveredSeries ? 2.5 : activeIndices.length > 10 ? 1.25 : 1.9;
      ctx.globalAlpha = activeCell && !isHoveredSeries && activeIndices.length > 3 ? 0.42 : 0.96;

      for (const seg of segments) {
        if (seg.length < 2) continue;
        ctx.beginPath();
        traceSmoothPath(ctx, seg);
        ctx.stroke();
      }

      // Refined draggable data nodes
      if ((axisLen <= 24 && activeIndices.length <= 8) || (canEdit && isHoveredSeries)) {
        ctx.fillStyle = color;
        for (const seg of segments) {
          for (const pt of seg) {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, isHoveredSeries ? 3.1 : 2.0, 0, Math.PI * 2);
            ctx.fill();
            if (canEdit && isHoveredSeries) {
              ctx.lineWidth = 1;
              ctx.strokeStyle = 'rgba(15, 16, 20, 0.75)';
              ctx.stroke();
            }
          }
        }
      }
      ctx.restore();
    });

    plottedPtsRef.current = pickList;

    // Live Datalog Crosshair Indicator
    if (
      datalogActiveCell &&
      datalogActiveCell.r >= 0 &&
      datalogActiveCell.r < rows &&
      datalogActiveCell.c >= 0 &&
      datalogActiveCell.c < cols
    ) {
      const dlAxisIdx = isCurves ? datalogActiveCell.c : datalogActiveCell.r;
      const dlVal = getCellVal(datalogActiveCell.r, datalogActiveCell.c);
      const dlPx = xFor(dlAxisIdx);

      ctx.save();
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.55)';
      ctx.lineWidth = 1.25;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(dlPx, padT);
      ctx.lineTo(dlPx, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      if (dlVal !== null && dlVal !== undefined && Number.isFinite(dlVal)) {
        const dlPy = yFor(dlVal);
        ctx.strokeStyle = 'rgba(52, 211, 153, 0.35)';
        ctx.beginPath();
        ctx.moveTo(padL, dlPy);
        ctx.lineTo(padL + plotW, dlPy);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(dlPx, dlPy, 11, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(16, 185, 129, 0.25)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(dlPx, dlPy, 4.4, 0, Math.PI * 2);
        ctx.fillStyle = '#10b981';
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
      ctx.restore();
    }

    // Crosshair synced to activeCell (dragged or hovered)
    if (
      activeCell &&
      activeCell.r >= 0 &&
      activeCell.r < rows &&
      activeCell.c >= 0 &&
      activeCell.c < cols
    ) {
      const axisIdx = isCurves ? activeCell.c : activeCell.r;
      const val = getCellVal(activeCell.r, activeCell.c);
      const px = xFor(axisIdx);
      const isDraggingCell = Boolean(dragState);

      ctx.save();
      ctx.strokeStyle = isDraggingCell ? 'rgba(245, 158, 11, 0.45)' : 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(px, padT);
      ctx.lineTo(px, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      if (val !== null && val !== undefined && Number.isFinite(val)) {
        const py = yFor(val);

        ctx.strokeStyle = isDraggingCell ? 'rgba(245, 158, 11, 0.35)' : 'rgba(255, 255, 255, 0.14)';
        ctx.beginPath();
        ctx.moveTo(padL, py);
        ctx.lineTo(padL + plotW, py);
        ctx.stroke();

        // If dragging, also show ghost anchor of start value
        if (dragState) {
          const startPy = yFor(dragState.startVal);
          ctx.beginPath();
          ctx.arc(px, startPy, 3.2, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(px, py, isDraggingCell ? 11 : 9, 0, Math.PI * 2);
        ctx.fillStyle = isDraggingCell ? 'rgba(245, 158, 11, 0.32)' : 'rgba(10, 132, 255, 0.28)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(px, py, isDraggingCell ? 4.8 : 4.0, 0, Math.PI * 2);
        ctx.fillStyle = isDraggingCell ? '#f59e0b' : '#0a84ff';
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
    datalogActiveCell,
    dragState,
    canEdit,
    rows,
    cols,
    effectiveMinY,
    effectiveMaxY,
    effectiveSpanY,
  ]);

  const findNearestPoint = useCallback((clientX: number, clientY: number, maxDist: number): Cell | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    let best: Cell | null = null;
    let bestDistSq = maxDist * maxDist;
    for (const pt of plottedPtsRef.current) {
      const dx = pt.sx - x;
      const dy = pt.sy - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        best = { r: pt.r, c: pt.c };
      }
    }
    return best;
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (contextMenu) setContextMenu(null);
      if (!canEdit || e.button !== 0) return;
      const hit = findNearestPoint(e.clientX, e.clientY, 20);
      if (!hit) return;
      const startVal = values[hit.r]?.[hit.c];
      if (startVal === null || startVal === undefined || !Number.isFinite(startVal)) return;

      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const b = plotBoundsRef.current;
      setDragState({
        cell: hit,
        startVal,
        liveVal: startVal,
        lockedMinY: b.minY,
        lockedMaxY: b.maxY,
        lockedSpanY: b.spanY,
      });
      onHoverCell?.(hit);
    },
    [canEdit, findNearestPoint, values, onHoverCell, contextMenu],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      if (dragState) {
        const rect = canvas.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const { padT, plotH } = plotBoundsRef.current;
        const frac = Math.max(-0.2, Math.min(1.2, (y - padT) / Math.max(1, plotH)));
        const nextVal = dragState.lockedMaxY - frac * dragState.lockedSpanY;
        if (Number.isFinite(nextVal)) {
          setDragState((prev) => (prev ? { ...prev, liveVal: nextVal } : null));
        }
        return;
      }

      const best = findNearestPoint(e.clientX, e.clientY, 28);
      if (canEdit) {
        const closeHit = findNearestPoint(e.clientX, e.clientY, 18);
        setNearDraggable(closeHit !== null);
      } else if (nearDraggable) {
        setNearDraggable(false);
      }

      if (onHoverCell && (best?.r !== hoveredCell?.r || best?.c !== hoveredCell?.c)) {
        onHoverCell(best);
      }
    },
    [dragState, findNearestPoint, canEdit, nearDraggable, onHoverCell, hoveredCell],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!dragState) return;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      if (onEditCell && Math.abs(dragState.liveVal - dragState.startVal) > 1e-9) {
        onEditCell(dragState.cell, dragState.liveVal);
      }
      setDragState(null);
    },
    [dragState, onEditCell],
  );

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const menuW = 200;
    const menuH = 220;
    const x = Math.min(e.clientX, window.innerWidth - menuW - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuH - 8);
    setContextMenu({ x: Math.max(8, x), y: Math.max(8, y) });
  }, []);

  const displayCell = dragState ? dragState.cell : hoveredCell;
  const hoveredVal = dragState
    ? dragState.liveVal
    : displayCell && displayCell.r < rows && displayCell.c < cols
      ? values[displayCell.r]?.[displayCell.c] ?? null
      : null;
  const hoveredCmp =
    displayCell && compareValues && displayCell.r < rows && displayCell.c < cols
      ? compareValues[displayCell.r]?.[displayCell.c] ?? null
      : null;

  const isCurves = mode === 'curves';
  const legendLabels = isCurves ? yLabels : xLabels;

  return (
    <div className="flex flex-col h-full min-h-[240px] rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden select-none">
      {/* Clean Airy Header */}
      <div className="flex items-center justify-between gap-3 px-3.5 py-2 border-b border-white/[0.065]">
        <div className="flex items-center gap-2 min-w-0">
          <Activity className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
          <span className="text-xs font-semibold tracking-[-0.01em] text-zinc-100 shrink-0">
            2D Curves
          </span>
          {datalogActiveCell && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-[10px] font-mono text-emerald-300 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              LOG
            </span>
          )}
          {dragState ? (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-[10.5px] font-mono font-semibold tabular-nums text-amber-300 truncate">
              {yLabels[dragState.cell.r] ?? dragState.cell.r} × {xLabels[dragState.cell.c] ?? dragState.cell.c} →{' '}
              {formatNum(dragState.liveVal, decimals)}
              {units ? ` ${units}` : ''}
              <span className="text-amber-200/80">
                ({dragState.liveVal >= dragState.startVal ? '+' : ''}
                {formatNum(dragState.liveVal - dragState.startVal, decimals)})
              </span>
            </span>
          ) : isLocked ? (
            <span className="inline-flex items-center gap-1 text-[10.5px] text-amber-400/80 shrink-0">
              <Lock className="w-3 h-3" />
              Locked
            </span>
          ) : canEdit ? (
            <span className="text-[10.5px] text-zinc-500 hidden xl:inline truncate">
              Drag points vertically to edit
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Curves / Slices segmented pill */}
          <div className="inline-flex rounded-md bg-white/[0.05] p-0.5">
            <button
              type="button"
              onClick={() => setMode('curves')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all cursor-pointer ${
                mode === 'curves'
                  ? 'bg-[#0a84ff] text-white shadow-[0_1px_5px_rgba(10,132,255,0.35)]'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Curves
            </button>
            <button
              type="button"
              onClick={() => setMode('slices')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all cursor-pointer ${
                mode === 'slices'
                  ? 'bg-[#0a84ff] text-white shadow-[0_1px_5px_rgba(10,132,255,0.35)]'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Slices
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
              showAll
                ? 'bg-white/[0.12] text-zinc-100'
                : 'bg-white/[0.045] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200'
            }`}
          >
            <Eye className="w-3 h-3" />
            All
          </button>

          {compareValues && (
            <button
              type="button"
              onClick={() => setShowCompare((v) => !v)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                showCompare
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-white/[0.045] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200'
              }`}
              title="Toggle dashed comparison curves"
            >
              <Layers className="w-3 h-3" />
              Cmp
            </button>
          )}
        </div>
      </div>

      {/* Canvas Well */}
      <div ref={containerRef} className="relative flex-1 min-h-0 w-full bg-[#0f1014]">
        <canvas
          ref={canvasRef}
          className={`block w-full h-full ${
            dragState || nearDraggable ? 'cursor-ns-resize' : 'cursor-crosshair'
          }`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onContextMenu={handleContextMenu}
          onPointerCancel={() => setDragState(null)}
          onPointerLeave={() => {
            if (!dragState) {
              setNearDraggable(false);
              onHoverCell?.(null);
            }
          }}
        />

        {/* Floating crosshair readout */}
        {displayCell && hoveredVal !== null && (
          <div className="pointer-events-none absolute top-2.5 right-2.5 px-2.5 py-1 rounded-lg bg-[#121317]/90 border border-white/[0.08] backdrop-blur-md shadow-lg flex items-center gap-2 text-[11px] font-mono tabular-nums">
            <span
              className={`w-2 h-2 rounded-full ${
                dragState
                  ? 'bg-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.85)]'
                  : 'bg-[#0a84ff] shadow-[0_0_8px_rgba(10,132,255,0.8)]'
              }`}
            />
            <span className="text-zinc-400">
              {yLabels[displayCell.r] ?? displayCell.r} × {xLabels[displayCell.c] ?? displayCell.c}
            </span>
            <span className="text-zinc-100 font-semibold">
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
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-white/[0.065] bg-[#121317] overflow-x-auto">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500 shrink-0 mr-1">
          {isCurves ? 'Rows' : 'Cols'}
        </span>
        {activeIndices.slice(0, 12).map((idx, pos) => {
          const color = SERIES_COLORS[pos % SERIES_COLORS.length];
          const isHovered =
            hoveredCell !== null && (isCurves ? hoveredCell.r === idx : hoveredCell.c === idx);
          return (
            <span
              key={idx}
              className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-md text-[10px] font-mono tabular-nums shrink-0 transition-colors ${
                isHovered
                  ? 'bg-white/[0.1] text-white'
                  : 'bg-white/[0.03] text-zinc-400'
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
              {legendLabels[idx] ?? String(idx)}
            </span>
          );
        })}
        {activeIndices.length > 12 && (
          <span className="text-[10px] font-mono text-zinc-500 shrink-0">
            +{activeIndices.length - 12}
          </span>
        )}
      </div>

      {/* Right-Click Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          className="fixed z-50 w-48 rounded-xl glass-popover py-1.5 text-xs text-zinc-200 shadow-2xl"
        >
          <button
            type="button"
            onClick={() => {
              setShowAll((v) => !v);
              setContextMenu(null);
            }}
            className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-white/[0.08] text-left cursor-pointer"
          >
            <span className="inline-flex items-center gap-2">
              <Eye className="w-3.5 h-3.5 text-zinc-400" />
              Show All Curves
            </span>
            {showAll && <Check className="w-3.5 h-3.5 text-[#0a84ff]" />}
          </button>

          {onSelectAll && (
            <button
              type="button"
              onClick={() => {
                onSelectAll();
                setContextMenu(null);
              }}
              className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-white/[0.08] text-left cursor-pointer"
            >
              <span className="inline-flex items-center gap-2">
                <Grid className="w-3.5 h-3.5 text-zinc-400" />
                Select All
              </span>
              <span className="text-[10px] font-mono text-zinc-500">⌘A</span>
            </button>
          )}

          {onSmoothSelection && (
            <button
              type="button"
              disabled={isLocked || selectedKeys.size < 2}
              onClick={() => {
                onSmoothSelection();
                setContextMenu(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/[0.08] disabled:opacity-40 disabled:cursor-not-allowed text-left cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-zinc-400" />
              Smooth Selection
            </button>
          )}

          {onResetToOriginal && (
            <button
              type="button"
              disabled={isLocked || !compareValues}
              onClick={() => {
                onResetToOriginal();
                setContextMenu(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/[0.08] disabled:opacity-40 disabled:cursor-not-allowed text-left text-amber-300 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset to Original
            </button>
          )}

          {(onJumpToHex || onOpenXdfEditor) && (
            <div className="my-1 border-t border-white/[0.08]" />
          )}

          {onJumpToHex && (
            <button
              type="button"
              onClick={() => {
                onJumpToHex();
                setContextMenu(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/[0.08] text-left cursor-pointer"
            >
              <Binary className="w-3.5 h-3.5 text-zinc-400" />
              Show in Hex
            </button>
          )}

          {onOpenXdfEditor && (
            <button
              type="button"
              onClick={() => {
                onOpenXdfEditor();
                setContextMenu(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/[0.08] text-left cursor-pointer"
            >
              <Settings2 className="w-3.5 h-3.5 text-zinc-400" />
              Edit in XDF…
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default Curves2DCanvas;
