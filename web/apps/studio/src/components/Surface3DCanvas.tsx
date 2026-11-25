import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Layers, Lock, MoveVertical, RotateCcw } from 'lucide-react';
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
  onEditCell?: (cell: Cell, newValue: number) => void;
  isLocked?: boolean;
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
  shade: number;
  isSelected: boolean;
  isHovered: boolean;
}

/** Luminous jewel-tile thermal ramp matching MapEditorView */
const THERMAL_STOPS: [number, number, number][] = [
  [43, 100, 232],  // #2b64e8
  [23, 168, 201],  // #17a8c9
  [39, 176, 92],   // #27b05c
  [217, 164, 22],  // #d9a416
  [235, 110, 31],  // #eb6e1f
  [224, 60, 72],   // #e03c48
];

function thermalRgb(tRaw: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, Number.isFinite(tRaw) ? tRaw : 0.5));
  const scaled = t * (THERMAL_STOPS.length - 1);
  const idx = Math.min(THERMAL_STOPS.length - 2, Math.floor(scaled));
  const frac = scaled - idx;
  const a = THERMAL_STOPS[idx];
  const b = THERMAL_STOPS[idx + 1];
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

// Key light direction (normalized) for luminous 3D shading
const LIGHT_DIR: Vec3 = { x: -0.35, y: 0.85, z: -0.39 };

interface PointDragState {
  cell: Cell;
  startY: number;
  startVal: number;
  liveVal: number;
  lockedMin: number;
  lockedMax: number;
  lockedSpan: number;
}

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
  onEditCell,
  isLocked = false,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 480, h: 280 });
  const [yaw, setYaw] = useState<number>(DEFAULT_YAW);
  const [pitch, setPitch] = useState<number>(DEFAULT_PITCH);
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);
  const [showCompare, setShowCompare] = useState<boolean>(true);
  const [editMode, setEditMode] = useState<boolean>(false);
  const [pointDrag, setPointDrag] = useState<PointDragState | null>(null);

  const canEdit = Boolean(onEditCell && !isLocked);

  useEffect(() => {
    if (!canEdit) {
      setEditMode(false);
      setPointDrag(null);
    }
  }, [canEdit]);

  useEffect(() => {
    if (!pointDrag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPointDrag(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pointDrag]);

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

      const rx = p.x * cosY - p.z * sinY;
      const rz1 = p.x * sinY + p.z * cosY;

      const ry = p.y * cosP + rz1 * sinP;
      const rz = -p.y * sinP + rz1 * cosP;

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

  const effMinVal = pointDrag ? pointDrag.lockedMin : minVal;
  const effMaxVal = pointDrag ? pointDrag.lockedMax : maxVal;
  const effSpanVal = pointDrag ? pointDrag.lockedSpan : spanVal;

  // Main render loop
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

    // Neutral obsidian canvas well with very subtle studio vignette
    ctx.clearRect(0, 0, W, H);
    const bgGrad = ctx.createRadialGradient(
      W * 0.5,
      H * 0.42,
      12,
      W * 0.5,
      H * 0.5,
      Math.max(W, H) * 0.68,
    );
    bgGrad.addColorStop(0, 'rgba(255, 255, 255, 0.025)');
    bgGrad.addColorStop(1, 'rgba(15, 16, 20, 0)');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    if (rows === 0 || cols === 0) {
      ctx.fillStyle = 'rgba(161, 161, 170, 0.6)';
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No table data', W / 2, H / 2);
      return;
    }

    const xExtent = 1.05;
    const zExtent = 1.05;
    const yBase = -0.52;
    const yHeight = 0.96;

    const getVal = (r: number, c: number): number | null => {
      if (pointDrag && pointDrag.cell.r === r && pointDrag.cell.c === c) {
        return pointDrag.liveVal;
      }
      return values[r]?.[c] ?? null;
    };

    const toNormX = (c: number) => (cols > 1 ? (c / (cols - 1)) * 2 - 1 : 0) * xExtent;
    const toNormZ = (r: number) => (rows > 1 ? (r / (rows - 1)) * 2 - 1 : 0) * zExtent;
    const toNormY = (v: number | null) => {
      if (v === null || !Number.isFinite(v)) return yBase;
      const t = (v - effMinVal) / effSpanVal;
      return yBase + t * yHeight;
    };

    // Base floor grid
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
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

    // Z (vertical) axis spine + ticks
    const zAxisBase = projectPoint({ x: -xExtent, y: yBase, z: -zExtent }, W, H);
    const zAxisTop = projectPoint({ x: -xExtent, y: yBase + yHeight, z: -zExtent }, W, H);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(zAxisBase.sx, zAxisBase.sy);
    ctx.lineTo(zAxisTop.sx, zAxisTop.sy);
    ctx.stroke();

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(161, 161, 170, 0.72)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 3; i++) {
      const frac = i / 3;
      const pt = projectPoint({ x: -xExtent, y: yBase + frac * yHeight, z: -zExtent }, W, H);
      const val = effMinVal + frac * effSpanVal;
      ctx.fillText(formatNum(val, decimals), pt.sx - 6, pt.sy);
    }

    // X-axis tick labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTickCount = Math.min(cols, 4);
    for (let i = 0; i < xTickCount; i++) {
      const c = xTickCount === 1 ? 0 : Math.round((i / (xTickCount - 1)) * (cols - 1));
      const pt = projectPoint({ x: toNormX(c), y: yBase, z: zExtent + 0.16 }, W, H);
      ctx.fillText(xLabels[c] ?? String(c), pt.sx, pt.sy + 3);
    }

    // Y-axis tick labels
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const yTickCount = Math.min(rows, 4);
    for (let i = 0; i < yTickCount; i++) {
      const r = yTickCount === 1 ? 0 : Math.round((i / (yTickCount - 1)) * (rows - 1));
      const pt = projectPoint({ x: xExtent + 0.16, y: yBase, z: toNormZ(r) }, W, H);
      ctx.fillText(yLabels[r] ?? String(r), pt.sx + 3, pt.sy);
    }
    ctx.restore();

    // Project all main surface vertices and store world coords for normal lighting
    const world: Vec3[][] = [];
    const proj: ProjectedPoint[][] = [];
    const pickList: { r: number; c: number; sx: number; sy: number }[] = [];
    for (let r = 0; r < rows; r++) {
      const wRow: Vec3[] = [];
      const rowArr: ProjectedPoint[] = [];
      for (let c = 0; c < cols; c++) {
        const wPt: Vec3 = { x: toNormX(c), y: toNormY(getVal(r, c)), z: toNormZ(r) };
        wRow.push(wPt);
        const pt = projectPoint(wPt, W, H);
        rowArr.push(pt);
        pickList.push({ r, c, sx: pt.sx, sy: pt.sy });
      }
      world.push(wRow);
      proj.push(rowArr);
    }
    projectedGridRef.current = pickList;

    const activeHover = pointDrag ? pointDrag.cell : hoveredCell;

    // Build and depth-sort surface quads with directional shading
    if (rows >= 2 && cols >= 2) {
      const faces: QuadFace[] = [];
      for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < cols - 1; c++) {
          const p00 = proj[r][c];
          const p01 = proj[r][c + 1];
          const p11 = proj[r + 1][c + 1];
          const p10 = proj[r + 1][c];

          const w00 = world[r][c];
          const w01 = world[r][c + 1];
          const w10 = world[r + 1][c];

          // Compute 3D surface normal via cross product (u × v)
          const ux = w01.x - w00.x;
          const uy = w01.y - w00.y;
          const uz = w01.z - w00.z;
          const vx = w10.x - w00.x;
          const vy = w10.y - w00.y;
          const vz = w10.z - w00.z;

          let nx = uy * vz - uz * vy;
          let ny = uz * vx - ux * vz;
          let nz = ux * vy - uy * vx;
          if (ny < 0) {
            nx = -nx;
            ny = -ny;
            nz = -nz;
          }
          const nLen = Math.hypot(nx, ny, nz) || 1;
          const ndotl = Math.max(0, (nx * LIGHT_DIR.x + ny * LIGHT_DIR.y + nz * LIGHT_DIR.z) / nLen);
          // Luminous ambient + directional boost (0.76 .. 1.18)
          const shade = 0.76 + ndotl * 0.42;

          const v00 = getVal(r, c) ?? effMinVal;
          const v01 = getVal(r, c + 1) ?? effMinVal;
          const v11 = getVal(r + 1, c + 1) ?? effMinVal;
          const v10 = getVal(r + 1, c) ?? effMinVal;
          const avg = (v00 + v01 + v11 + v10) * 0.25;
          const t = (avg - effMinVal) / effSpanVal;

          const isSelected = Boolean(
            selectedKeys &&
              (selectedKeys.has(cellKey({ r, c })) ||
                selectedKeys.has(cellKey({ r, c: c + 1 })) ||
                selectedKeys.has(cellKey({ r: r + 1, c })) ||
                selectedKeys.has(cellKey({ r: r + 1, c: c + 1 }))),
          );

          const isHovered = Boolean(
            activeHover &&
              activeHover.r >= r &&
              activeHover.r <= r + 1 &&
              activeHover.c >= c &&
              activeHover.c <= c + 1,
          );

          faces.push({
            r,
            c,
            pts: [p00, p01, p11, p10],
            depth: (p00.depth + p01.depth + p11.depth + p10.depth) * 0.25,
            t,
            shade,
            isSelected,
            isHovered,
          });
        }
      }

      faces.sort((a, b) => b.depth - a.depth);

      for (const f of faces) {
        const [baseR, baseG, baseB] = thermalRgb(f.t);
        const red = Math.min(255, Math.round(baseR * f.shade));
        const green = Math.min(255, Math.round(baseG * f.shade));
        const blue = Math.min(255, Math.round(baseB * f.shade));

        ctx.beginPath();
        ctx.moveTo(f.pts[0].sx, f.pts[0].sy);
        ctx.lineTo(f.pts[1].sx, f.pts[1].sy);
        ctx.lineTo(f.pts[2].sx, f.pts[2].sy);
        ctx.lineTo(f.pts[3].sx, f.pts[3].sy);
        ctx.closePath();

        ctx.fillStyle = `rgba(${red}, ${green}, ${blue}, ${
          f.isHovered ? 0.96 : f.isSelected ? 0.94 : 0.88
        })`;
        ctx.fill();

        ctx.strokeStyle = f.isHovered
          ? 'rgba(255, 255, 255, 0.92)'
          : f.isSelected
            ? 'rgba(255, 255, 255, 0.65)'
            : 'rgba(15, 16, 20, 0.35)';
        ctx.lineWidth = f.isHovered ? 1.4 : f.isSelected ? 1.1 : 0.7;
        ctx.stroke();
      }
    } else {
      // 1D ribbon fallback
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

        const vAvg = ((getVal(r0, c0) ?? effMinVal) + (getVal(r1, c1) ?? effMinVal)) * 0.5;
        const [red, green, blue] = thermalRgb((vAvg - effMinVal) / effSpanVal);

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
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.65)';
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

    // Draggable vertex handles when in Edit Points mode
    if (canEdit && editMode) {
      ctx.save();
      const dense = rows * cols > 320;
      const handleR = dense ? 2.1 : 2.8;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const pt = proj[r][c];
          const isDragged = pointDrag?.cell.r === r && pointDrag?.cell.c === c;
          ctx.beginPath();
          ctx.arc(pt.sx, pt.sy, isDragged ? 5 : handleR, 0, Math.PI * 2);
          ctx.fillStyle = isDragged ? '#f59e0b' : 'rgba(255, 255, 255, 0.9)';
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(12, 13, 16, 0.75)';
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // Glowing beacon at activeHover (3-Way Crosshair Sync or Active Vertex Drag)
    if (
      activeHover &&
      activeHover.r >= 0 &&
      activeHover.r < rows &&
      activeHover.c >= 0 &&
      activeHover.c < cols
    ) {
      const hr = activeHover.r;
      const hc = activeHover.c;
      const pt = proj[hr][hc];
      const basePt = projectPoint({ x: toNormX(hc), y: yBase, z: toNormZ(hr) }, W, H);
      const isDraggingVertex = Boolean(pointDrag);

      ctx.save();
      ctx.strokeStyle = isDraggingVertex ? 'rgba(245, 158, 11, 0.7)' : 'rgba(255, 255, 255, 0.5)';
      ctx.lineWidth = isDraggingVertex ? 1.5 : 1.15;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(basePt.sx, basePt.sy);
      ctx.lineTo(pt.sx, pt.sy);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.arc(basePt.sx, basePt.sy, 2.8, 0, Math.PI * 2);
      ctx.fillStyle = isDraggingVertex ? 'rgba(245, 158, 11, 0.65)' : 'rgba(255, 255, 255, 0.4)';
      ctx.fill();

      const halo = ctx.createRadialGradient(pt.sx, pt.sy, 1, pt.sx, pt.sy, isDraggingVertex ? 16 : 14);
      halo.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
      halo.addColorStop(
        0.45,
        isDraggingVertex ? 'rgba(245, 158, 11, 0.55)' : 'rgba(10, 132, 255, 0.45)',
      );
      halo.addColorStop(1, isDraggingVertex ? 'rgba(245, 158, 11, 0)' : 'rgba(10, 132, 255, 0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(pt.sx, pt.sy, isDraggingVertex ? 16 : 14, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(pt.sx, pt.sy, isDraggingVertex ? 5.0 : 4.2, 0, Math.PI * 2);
      ctx.fillStyle = isDraggingVertex ? '#f59e0b' : '#0a84ff';
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
    effMinVal,
    effSpanVal,
    projectPoint,
    canEdit,
    editMode,
    pointDrag,
  ]);

  const pickCellAt = useCallback((clientX: number, clientY: number, maxRadius = 18): Cell | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: Cell | null = null;
    let bestDistSq = maxRadius * maxRadius;
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
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const wantsPointEdit = canEdit && e.button === 0 && (editMode || e.altKey);
    if (wantsPointEdit) {
      const picked = pickCellAt(e.clientX, e.clientY, 24);
      if (picked) {
        const startVal = values[picked.r]?.[picked.c];
        if (startVal !== null && startVal !== undefined && Number.isFinite(startVal)) {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          setPointDrag({
            cell: picked,
            startY: e.clientY,
            startVal,
            liveVal: startVal,
            lockedMin: minVal,
            lockedMax: maxVal,
            lockedSpan: spanVal,
          });
          onHoverCell?.(picked);
          onSelectCell?.(picked);
          return;
        }
      }
    }

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
    if (pointDrag) {
      const dy = pointDrag.startY - e.clientY;
      const fine = e.shiftKey ? 0.2 : 1.0;
      const sensitivity = (Math.max(pointDrag.lockedSpan, 1) / Math.max(110, size.h * 0.48)) * fine;
      const nextVal = pointDrag.startVal + dy * sensitivity;
      if (Number.isFinite(nextVal)) {
        setPointDrag((prev) => (prev ? { ...prev, liveVal: nextVal } : null));
      }
      return;
    }

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
      const picked = pickCellAt(e.clientX, e.clientY, editMode ? 22 : 18);
      if (picked?.r !== hoveredCell?.r || picked?.c !== hoveredCell?.c) {
        onHoverCell(picked);
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointDrag) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      if (onEditCell && Math.abs(pointDrag.liveVal - pointDrag.startVal) > 1e-9) {
        onEditCell(pointDrag.cell, pointDrag.liveVal);
      }
      setPointDrag(null);
      return;
    }

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

  const displayCell = pointDrag ? pointDrag.cell : hoveredCell;
  const hoveredVal = pointDrag
    ? pointDrag.liveVal
    : displayCell && displayCell.r < rows && displayCell.c < cols
      ? values[displayCell.r]?.[displayCell.c] ?? null
      : null;

  return (
    <div className="flex flex-col h-full min-h-[240px] rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden select-none">
      {/* Clean Airy Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-white/[0.065]">
        <div className="flex items-center gap-2 min-w-0">
          <Box className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
          <span className="text-xs font-semibold tracking-[-0.01em] text-zinc-100 whitespace-nowrap shrink-0">
            3D Surface
          </span>
          {pointDrag ? (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-[10.5px] font-mono font-semibold tabular-nums text-amber-300 truncate">
              {yLabels[pointDrag.cell.r] ?? pointDrag.cell.r} × {xLabels[pointDrag.cell.c] ?? pointDrag.cell.c} →{' '}
              {formatNum(pointDrag.liveVal, decimals)}
              {units ? ` ${units}` : ''}
              <span className="text-amber-200/80">
                ({pointDrag.liveVal >= pointDrag.startVal ? '+' : ''}
                {formatNum(pointDrag.liveVal - pointDrag.startVal, decimals)})
              </span>
            </span>
          ) : isLocked ? (
            <span className="inline-flex items-center gap-1 text-[10.5px] text-amber-400/80 shrink-0">
              <Lock className="w-3 h-3" />
              Locked
            </span>
          ) : (
            <span className="text-[10.5px] text-zinc-500 hidden 2xl:inline truncate">
              {editMode && canEdit
                ? 'Drag vertex · Shift = fine'
                : canEdit
                  ? 'Orbit · ⌥+Drag edit'
                  : 'Drag to orbit'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {canEdit && (
            <button
              type="button"
              onClick={() => setEditMode((v) => !v)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-all cursor-pointer ${
                editMode
                  ? 'bg-[#0a84ff] text-white shadow-[0_1px_6px_rgba(10,132,255,0.4)]'
                  : 'bg-white/[0.045] text-zinc-300 hover:bg-white/[0.09] hover:text-white'
              }`}
              title="Toggle 3D vertex drag editing (or hold Option/Alt + drag)"
            >
              <MoveVertical className="w-3 h-3" />
              Points
            </button>
          )}
          {compareValues && (
            <button
              type="button"
              onClick={() => setShowCompare((v) => !v)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                showCompare
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-white/[0.045] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200'
              }`}
              title="Toggle comparison wireframe overlay"
            >
              <Layers className="w-3 h-3" />
              Compare
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setYaw(DEFAULT_YAW);
              setPitch(DEFAULT_PITCH);
              setZoom(DEFAULT_ZOOM);
            }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-white/[0.045] text-zinc-300 hover:bg-white/[0.09] hover:text-white transition-colors cursor-pointer"
            title="Reset 3D camera"
          >
            <RotateCcw className="w-3 h-3" />
            Reset
          </button>
        </div>
      </div>

      {/* Canvas Well */}
      <div ref={containerRef} className="relative flex-1 min-h-0 w-full bg-[#0f1014]">
        <canvas
          ref={canvasRef}
          className={`block w-full h-full ${
            pointDrag || (editMode && canEdit)
              ? 'cursor-ns-resize'
              : 'cursor-grab active:cursor-grabbing'
          }`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => {
            dragRef.current.active = false;
            setPointDrag(null);
          }}
          onPointerLeave={() => {
            dragRef.current.active = false;
            if (!pointDrag) onHoverCell?.(null);
          }}
          onWheel={handleWheel}
        />

        {/* Live Crosshair Readout Pill */}
        {displayCell && hoveredVal !== null && (
          <div className="pointer-events-none absolute bottom-2.5 left-2.5 px-2.5 py-1 rounded-lg bg-[#121317]/90 border border-white/[0.08] backdrop-blur-md shadow-lg flex items-center gap-2 text-[11px] font-mono tabular-nums">
            <span
              className={`w-2 h-2 rounded-full ${
                pointDrag
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
          </div>
        )}

        {/* Range badge */}
        <div className="pointer-events-none absolute top-2.5 right-2.5 px-2 py-0.5 rounded-md bg-[#121317]/80 border border-white/[0.065] text-[10px] font-mono tabular-nums text-zinc-400">
          {formatNum(effMinVal, decimals)} – {formatNum(effMaxVal, decimals)}
          {units ? ` ${units}` : ''}
        </div>
      </div>
    </div>
  );
};

export default Surface3DCanvas;
