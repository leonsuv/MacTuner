import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layers, RotateCcw, Box } from 'lucide-react';
import { Cell, cellKey } from '@mactuner/core';

export interface Surface3DCanvasProps {
  values: (number | null)[][];
  compareValues?: (number | null)[][] | null;
  xLabels: string[];
  yLabels: string[];
  units?: string;
  decimals?: number;
  hoveredCell: Cell | null;
  selectedKeys?: Set<string>;
  onHoverCell?: (cell: Cell | null) => void;
  onSelectCell?: (cell: Cell) => void;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface ProjectedPoint {
  sx: number;
  sy: number;
  depth: number;
}

interface QuadFace {
  r: number;
  c: number;
  pts: [ProjectedPoint, ProjectedPoint, ProjectedPoint, ProjectedPoint];
  depth: number;
  t: number;
  isSelected: boolean;
  isHovered: boolean;
}

/** Smooth thermal color ramp: blue -> cyan -> green -> yellow -> orange -> red */
function thermalRgb(tRaw: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, Number.isFinite(tRaw) ? tRaw : 0.5));
  const stops: [number, number, number][] = [
    [30, 80, 210],   // 0.00 deep blue
    [20, 184, 218],  // 0.22 cyan
    [34, 197, 94],   // 0.45 green
    [234, 179, 8],   // 0.68 yellow
    [249, 115, 22],  // 0.85 orange
    [239, 68, 68],   // 1.00 red
  ];
  const scaled = t * (stops.length - 1);
  const idx = Math.min(stops.length - 2, Math.floor(scaled));
  const frac = scaled - idx;
  const a = stops[idx];
  const b = stops[idx + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
  ];
}

function formatNum(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(Math.max(0, Math.min(4, decimals)));
}

const DEFAULT_YAW = -0.72;
const DEFAULT_PITCH = 0.54;
const DEFAULT_ZOOM = 1.0;

export const Surface3DCanvas: React.FC<Surface3DCanvasProps> = ({
  values,
  compareValues = null,
  xLabels,
  yLabels,
  units = '',
  decimals = 1,
  hoveredCell,
  selectedKeys,
  onHoverCell,
  onSelectCell,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 480, h: 280 });
  const [yaw, setYaw] = useState<number>(DEFAULT_YAW);
  const [pitch, setPitch] = useState<number>(DEFAULT_PITCH);
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);
  const [showCompare, setShowCompare] = useState<boolean>(true);

  const dragRef = useRef<{
    active: boolean;
    moved: boolean;
    startX: number;
    startY: number;
    startYaw: number;
    startPitch: number;
  }>({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    startYaw: DEFAULT_YAW,
    startPitch: DEFAULT_PITCH,
  });

  // Store projected vertices for pointer picking
  const projectedGridRef = useRef<{ r: number; c: number; sx: number; sy: number }[]>([]);

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

  const { minVal, maxVal, spanVal } = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
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
      return { minVal: 0, maxVal: 1, spanVal: 1 };
    }
    const span = max - min;
    return { minVal: min, maxVal: max, spanVal: span > 1e-12 ? span : 1 };
  }, [values, compareValues, showCompare, rows, cols]);

  const projectPoint = useCallback(
    (p: Vec3, width: number, height: number): ProjectedPoint => {
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const cosP = Math.cos(pitch);
      const sinP = Math.sin(pitch);

      // Rotate around Y (vertical axis in 3D space is p.y)
      const rx = p.x * cosY - p.z * sinY;
      const rz1 = p.x * sinY + p.z * cosY;

      // Rotate around X (pitch)
      const ry = p.y * cosP - rz1 * sinP;
      const rz = p.y * sinP + rz1 * cosP;

      const fov = 3.6;
      const dist = 3.35 / Math.max(0.45, Math.min(2.6, zoom));
      const persp = fov / Math.max(0.4, dist + rz);
      const scale = Math.min(width, height) * 0.34 * persp;

      return {
        sx: width * 0.5 + rx * scale,
        sy: height * 0.54 - ry * scale,
        depth: rz,
      };
    },
    [yaw, pitch, zoom],
  );

  // Main render loop (runs whenever state or hoveredCell changes)
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

    // Background subtle radial glow
    ctx.clearRect(0, 0, W, H);
    const bgGrad = ctx.createRadialGradient(W * 0.5, H * 0.45, 10, W * 0.5, H * 0.5, Math.max(W, H) * 0.65);
    bgGrad.addColorStop(0, 'rgba(37, 137, 255, 0.06)');
    bgGrad.addColorStop(1, 'rgba(13, 16, 22, 0)');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    if (rows === 0 || cols === 0) {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No table data', W / 2, H / 2);
      return;
    }

    const xExtent = 1.05;
    const zExtent = 1.05;
    const yBase = -0.52;
    const yHeight = 0.96;

    const toNormX = (c: number) => (cols > 1 ? (c / (cols - 1)) * 2 - 1 : 0) * xExtent;
    const toNormZ = (r: number) => (rows > 1 ? (r / (rows - 1)) * 2 - 1 : 0) * zExtent;
    const toNormY = (v: number | null) => {
      if (v === null || !Number.isFinite(v)) return yBase;
      const t = (v - minVal) / spanVal;
      return yBase + t * yHeight;
    };

    // Draw base floor grid
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    const gridSteps = 4;
    for (let i = 0; i <= gridSteps; i++) {
      const f = (i / gridSteps) * 2 - 1;
      const a1 = projectPoint({ x: f * xExtent, y: yBase, z: -zExtent }, W, H);
      const b1 = projectPoint({ x: f * xExtent, y: yBase, z: zExtent }, W, H);
      ctx.beginPath();
      ctx.moveTo(a1.sx, a1.sy);
      ctx.lineTo(b1.sx, b1.sy);
      ctx.stroke();

      const a2 = projectPoint({ x: -xExtent, y: yBase, z: f * zExtent }, W, H);
      const b2 = projectPoint({ x: xExtent, y: yBase, z: f * zExtent }, W, H);
      ctx.beginPath();
      ctx.moveTo(a2.sx, a2.sy);
      ctx.lineTo(b2.sx, b2.sy);
      ctx.stroke();
    }

    // Draw Z (vertical) axis spine + ticks at back-left corner
    const zAxisBase = projectPoint({ x: -xExtent, y: yBase, z: -zExtent }, W, H);
    const zAxisTop = projectPoint({ x: -xExtent, y: yBase + yHeight, z: -zExtent }, W, H);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(zAxisBase.sx, zAxisBase.sy);
    ctx.lineTo(zAxisTop.sx, zAxisTop.sy);
    ctx.stroke();

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.75)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 3; i++) {
      const frac = i / 3;
      const pt = projectPoint({ x: -xExtent, y: yBase + frac * yHeight, z: -zExtent }, W, H);
      const val = minVal + frac * spanVal;
      ctx.fillText(formatNum(val, decimals), pt.sx - 6, pt.sy);
    }

    // X-axis tick labels (along front edge z = +zExtent)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTickCount = Math.min(cols, 4);
    for (let i = 0; i < xTickCount; i++) {
      const c = xTickCount === 1 ? 0 : Math.round((i / (xTickCount - 1)) * (cols - 1));
      const pt = projectPoint({ x: toNormX(c), y: yBase, z: zExtent + 0.16 }, W, H);
      ctx.fillText(xLabels[c] ?? String(c), pt.sx, pt.sy + 3);
    }

    // Y-axis tick labels (along right edge x = +xExtent)
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const yTickCount = Math.min(rows, 4);
    for (let i = 0; i < yTickCount; i++) {
      const r = yTickCount === 1 ? 0 : Math.round((i / (yTickCount - 1)) * (rows - 1));
      const pt = projectPoint({ x: xExtent + 0.16, y: yBase, z: toNormZ(r) }, W, H);
      ctx.fillText(yLabels[r] ?? String(r), pt.sx + 3, pt.sy);
    }
    ctx.restore();

    // Project all main surface vertices
    const proj: ProjectedPoint[][] = [];
    const pickList: { r: number; c: number; sx: number; sy: number }[] = [];
    for (let r = 0; r < rows; r++) {
      const rowArr: ProjectedPoint[] = [];
      for (let c = 0; c < cols; c++) {
        const pt = projectPoint({ x: toNormX(c), y: toNormY(values[r][c]), z: toNormZ(r) }, W, H);
        rowArr.push(pt);
        pickList.push({ r, c, sx: pt.sx, sy: pt.sy });
      }
      proj.push(rowArr);
    }
    projectedGridRef.current = pickList;

    // Build and depth-sort surface quads (Painter's algorithm)
    if (rows >= 2 && cols >= 2) {
      const faces: QuadFace[] = [];
      for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < cols - 1; c++) {
          const p00 = proj[r][c];
          const p01 = proj[r][c + 1];
          const p11 = proj[r + 1][c + 1];
          const p10 = proj[r + 1][c];

          const v00 = values[r][c] ?? minVal;
          const v01 = values[r][c + 1] ?? minVal;
          const v11 = values[r + 1][c + 1] ?? minVal;
          const v10 = values[r + 1][c] ?? minVal;
          const avg = (v00 + v01 + v11 + v10) * 0.25;
          const t = (avg - minVal) / spanVal;

          const isSelected = Boolean(
            selectedKeys &&
              (selectedKeys.has(cellKey({ r, c })) ||
                selectedKeys.has(cellKey({ r, c: c + 1 })) ||
                selectedKeys.has(cellKey({ r: r + 1, c })) ||
                selectedKeys.has(cellKey({ r: r + 1, c: c + 1 }))),
          );

          const isHovered = Boolean(
            hoveredCell &&
              hoveredCell.r >= r &&
              hoveredCell.r <= r + 1 &&
              hoveredCell.c >= c &&
              hoveredCell.c <= c + 1,
          );

          faces.push({
            r,
            c,
            pts: [p00, p01, p11, p10],
            depth: (p00.depth + p01.depth + p11.depth + p10.depth) * 0.25,
            t,
            isSelected,
            isHovered,
          });
        }
      }

      // Painter's sort: farthest depth first (larger depth = farther from camera)
      faces.sort((a, b) => b.depth - a.depth);

      for (const f of faces) {
        const [red, green, blue] = thermalRgb(f.t);
        ctx.beginPath();
        ctx.moveTo(f.pts[0].sx, f.pts[0].sy);
        ctx.lineTo(f.pts[1].sx, f.pts[1].sy);
        ctx.lineTo(f.pts[2].sx, f.pts[2].sy);
        ctx.lineTo(f.pts[3].sx, f.pts[3].sy);
        ctx.closePath();

        ctx.fillStyle = `rgba(${red}, ${green}, ${blue}, ${f.isHovered ? 0.92 : f.isSelected ? 0.86 : 0.74})`;
        ctx.fill();

        ctx.strokeStyle = f.isHovered
          ? 'rgba(56, 189, 248, 0.95)'
          : f.isSelected
            ? 'rgba(255, 255, 255, 0.55)'
            : 'rgba(13, 16, 22, 0.55)';
        ctx.lineWidth = f.isHovered ? 1.4 : 0.8;
        ctx.stroke();
      }
    } else {
      // 1D ribbon fallback (1×N or N×1)
      const isRow = rows === 1;
      const len = isRow ? cols : rows;
      for (let i = 0; i < len - 1; i++) {
        const r0 = isRow ? 0 : i;
        const c0 = isRow ? i : 0;
        const r1 = isRow ? 0 : i + 1;
        const c1 = isRow ? i + 1 : 0;
        const p0 = proj[r0][c0];
        const p1 = proj[r1][c1];
        const b0 = projectPoint({ x: toNormX(c0), y: yBase, z: toNormZ(r0) }, W, H);
        const b1 = projectPoint({ x: toNormX(c1), y: yBase, z: toNormZ(r1) }, W, H);

        const vAvg = ((values[r0][c0] ?? minVal) + (values[r1][c1] ?? minVal)) * 0.5;
        const [red, green, blue] = thermalRgb((vAvg - minVal) / spanVal);

        ctx.beginPath();
        ctx.moveTo(b0.sx, b0.sy);
        ctx.lineTo(p0.sx, p0.sy);
        ctx.lineTo(p1.sx, p1.sy);
        ctx.lineTo(b1.sx, b1.sy);
        ctx.closePath();
        ctx.fillStyle = `rgba(${red}, ${green}, ${blue}, 0.55)`;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(p0.sx, p0.sy);
        ctx.lineTo(p1.sx, p1.sy);
        ctx.strokeStyle = `rgb(${red}, ${green}, ${blue})`;
        ctx.lineWidth = 2.2;
        ctx.stroke();
      }
    }

    // Optional Comparison dashed wireframe overlay
    if (showCompare && compareValues && compareValues.length === rows) {
      ctx.save();
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.68)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);

      const cProj: ProjectedPoint[][] = [];
      for (let r = 0; r < rows; r++) {
        const rowArr: ProjectedPoint[] = [];
        for (let c = 0; c < cols; c++) {
          rowArr.push(
            projectPoint({ x: toNormX(c), y: toNormY(compareValues[r]?.[c] ?? null), z: toNormZ(r) }, W, H),
          );
        }
        cProj.push(rowArr);
      }

      for (let r = 0; r < rows; r++) {
        ctx.beginPath();
        for (let c = 0; c < cols; c++) {
          const pt = cProj[r][c];
          if (c === 0) ctx.moveTo(pt.sx, pt.sy);
          else ctx.lineTo(pt.sx, pt.sy);
        }
        ctx.stroke();
      }
      for (let c = 0; c < cols; c++) {
        ctx.beginPath();
        for (let r = 0; r < rows; r++) {
          const pt = cProj[r][c];
          if (r === 0) ctx.moveTo(pt.sx, pt.sy);
          else ctx.lineTo(pt.sx, pt.sy);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // Glowing cyan beacon at hoveredCell (3-Way Crosshair Sync)
    if (
      hoveredCell &&
      hoveredCell.r >= 0 &&
      hoveredCell.r < rows &&
      hoveredCell.c >= 0 &&
      hoveredCell.c < cols
    ) {
      const hr = hoveredCell.r;
      const hc = hoveredCell.c;
      const pt = proj[hr][hc];
      const basePt = projectPoint({ x: toNormX(hc), y: yBase, z: toNormZ(hr) }, W, H);

      ctx.save();
      // Drop line to base plane
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.65)';
      ctx.lineWidth = 1.25;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(basePt.sx, basePt.sy);
      ctx.lineTo(pt.sx, pt.sy);
      ctx.stroke();
      ctx.setLineDash([]);

      // Base ring
      ctx.beginPath();
      ctx.arc(basePt.sx, basePt.sy, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(34, 211, 238, 0.45)';
      ctx.fill();

      // Outer cyan halo
      const halo = ctx.createRadialGradient(pt.sx, pt.sy, 1, pt.sx, pt.sy, 14);
      halo.addColorStop(0, 'rgba(34, 211, 238, 0.95)');
      halo.addColorStop(0.45, 'rgba(34, 211, 238, 0.35)');
      halo.addColorStop(1, 'rgba(34, 211, 238, 0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(pt.sx, pt.sy, 14, 0, Math.PI * 2);
      ctx.fill();

      // Crisp beacon core
      ctx.beginPath();
      ctx.arc(pt.sx, pt.sy, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#22d3ee';
      ctx.fill();
      ctx.lineWidth = 1.75;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
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
    hoveredCell,
    selectedKeys,
    rows,
    cols,
    minVal,
    spanVal,
    projectPoint,
  ]);

  const pickCellAt = useCallback(
    (clientX: number, clientY: number): Cell | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      let best: Cell | null = null;
      let bestDistSq = 18 * 18;
      for (const pt of projectedGridRef.current) {
        const dx = pt.sx - x;
        const dy = pt.sy - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDistSq) {
          bestDistSq = d2;
          best = { r: pt.r, c: pt.c };
        }
      }
      return best;
    },
    [],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      active: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      startYaw: yaw,
      startPitch: pitch,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag.active) {
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
      setYaw(drag.startYaw + dx * 0.0085);
      setPitch(Math.max(-0.15, Math.min(1.42, drag.startPitch + dy * 0.0075)));
      return;
    }
    if (onHoverCell) {
      const picked = pickCellAt(e.clientX, e.clientY);
      if (
        picked?.r !== hoveredCell?.r ||
        picked?.c !== hoveredCell?.c
      ) {
        onHoverCell(picked);
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag.active && !drag.moved && onSelectCell) {
      const picked = pickCellAt(e.clientX, e.clientY);
      if (picked) onSelectCell(picked);
    }
    drag.active = false;
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    setZoom((z) => Math.max(0.5, Math.min(2.4, z * factor)));
  };

  const hoveredVal =
    hoveredCell && hoveredCell.r < rows && hoveredCell.c < cols
      ? values[hoveredCell.r]?.[hoveredCell.c] ?? null
      : null;

  return (
    <div className="flex flex-col h-full min-h-[240px] rounded-xl bg-[#141821] border border-white/10 overflow-hidden select-none">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 bg-white/[0.02]">
        <div className="flex items-center gap-2">
          <Box className="w-3.5 h-3.5 text-[#2589ff]" />
          <span className="text-xs font-semibold tracking-wide text-slate-200">3D Surface</span>
          <span className="text-[10px] font-mono text-slate-500 hidden xl:inline">
            Drag to orbit · Scroll to zoom
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {compareValues && (
            <button
              type="button"
              onClick={() => setShowCompare((v) => !v)}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
                showCompare
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                  : 'bg-white/[0.04] text-slate-400 border-white/10 hover:text-slate-200'
              }`}
              title="Toggle comparison wireframe overlay"
            >
              <Layers className="w-3 h-3" />
              Comparison
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setYaw(DEFAULT_YAW);
              setPitch(DEFAULT_PITCH);
              setZoom(DEFAULT_ZOOM);
            }}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-white/[0.04] text-slate-300 border border-white/10 hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
            title="Reset 3D camera"
          >
            <RotateCcw className="w-3 h-3" />
            Reset
          </button>
        </div>
      </div>

      {/* Canvas Viewport */}
      <div ref={containerRef} className="relative flex-1 min-h-0 w-full">
        <canvas
          ref={canvasRef}
          className="block w-full h-full cursor-grab active:cursor-grabbing"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={() => {
            dragRef.current.active = false;
            onHoverCell?.(null);
          }}
          onWheel={handleWheel}
        />

        {/* Live Crosshair Readout Pill */}
        {hoveredCell && hoveredVal !== null && (
          <div className="pointer-events-none absolute bottom-2.5 left-2.5 px-2.5 py-1 rounded-lg bg-[#0d1016]/90 border border-cyan-400/35 backdrop-blur-md shadow-lg flex items-center gap-2 text-[11px] font-mono tabular-nums">
            <span className="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_8px_#22d3ee]" />
            <span className="text-slate-400">
              Y:{yLabels[hoveredCell.r] ?? hoveredCell.r} · X:{xLabels[hoveredCell.c] ?? hoveredCell.c}
            </span>
            <span className="text-cyan-200 font-semibold">
              {formatNum(hoveredVal, decimals)}
              {units ? ` ${units}` : ''}
            </span>
          </div>
        )}

        {/* Range badge */}
        <div className="pointer-events-none absolute top-2 right-2.5 px-2 py-0.5 rounded bg-[#0d1016]/75 border border-white/10 text-[10px] font-mono tabular-nums text-slate-400">
          {formatNum(minVal, decimals)} – {formatNum(maxVal, decimals)}
          {units ? ` ${units}` : ''}
        </div>
      </div>
    </div>
  );
};

export default Surface3DCanvas;
