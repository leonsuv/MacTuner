import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  Binary,
  ChevronDown,
  FunctionSquare,
  Lock,
  Minus,
  Plus,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Spline,
  Undo2,
  Unlock,
} from 'lucide-react';
import {
  Axis,
  BinCodec,
  Cell,
  Expr,
  InterpolationMode,
  Patch,
  TableOps,
  XDFItem,
  cellKey,
  cellOffset,
  elementBytes,
  layoutTypeDescription,
  parseCellKey,
  scalingDisplay,
  scalingFormat,
  scalingRawFor,
  scalingRawStep,
  scalingValue,
} from '@mactuner/core';
import { Surface3DCanvas } from './Surface3DCanvas';
import { Curves2DCanvas } from './Curves2DCanvas';

export interface MapEditorViewProps {
  item: XDFItem;
  bin: Uint8Array;
  compareBin: Uint8Array | null;
  onApplyPatches: (patches: Patch[], label: string) => void;
  onJumpToHex: (address: number) => void;
  onResetMap: (item: XDFItem) => void;
  categoryName?: string;
  isLocked?: boolean;
  onToggleLock?: () => void;
  onOpenXdfEditor?: () => void;
}

type ViewMode = 'bin' | 'compare' | 'delta' | 'deltaPct';
type OpenMenu = 'interpolate' | 'fill' | 'formula' | 'rescale' | null;

/** Iconic vibrant jewel-tile thermal ramp (#2b64e8 -> #17a8c9 -> #27b05c -> #d9a416 -> #eb6e1f -> #e03c48) */
const THERMAL_STOPS: [number, number, number][] = [
  [43, 100, 232],  // #2b64e8 cobalt blue
  [23, 168, 201],  // #17a8c9 electric cyan
  [39, 176, 92],   // #27b05c emerald green
  [217, 164, 22],  // #d9a416 warm gold
  [235, 110, 31],  // #eb6e1f vivid orange
  [224, 60, 72],   // #e03c48 crimson red
];

function thermalTileBg(tRaw: number): string {
  const t = Math.max(0, Math.min(1, Number.isFinite(tRaw) ? tRaw : 0.5));
  const scaled = t * (THERMAL_STOPS.length - 1);
  const idx = Math.min(THERMAL_STOPS.length - 2, Math.floor(scaled));
  const frac = scaled - idx;
  const a = THERMAL_STOPS[idx];
  const b = THERMAL_STOPS[idx + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * frac);
  const g = Math.round(a[1] + (b[1] - a[1]) * frac);
  const bl = Math.round(a[2] + (b[2] - a[2]) * frac);
  return `rgba(${r}, ${g}, ${bl}, 0.92)`;
}

function deltaTileBg(delta: number, maxAbs: number): string {
  if (!Number.isFinite(delta) || Math.abs(delta) <= 1e-9) {
    return '#1a1b20';
  }
  const intensity = Math.min(1, Math.abs(delta) / Math.max(1e-9, maxAbs));
  const alpha = 0.72 + intensity * 0.24;
  return delta > 0
    ? `rgba(217, 56, 72, ${alpha.toFixed(3)})` // #d93848 crimson
    : `rgba(37, 117, 232, ${alpha.toFixed(3)})`; // #2575e8 cobalt
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Piecewise linear interpolation for axis rescaling */
function sample1D(xs: number[], ys: (number | null)[], targetX: number): number | null {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const y = ys[i];
    if (Number.isFinite(x) && y !== null && Number.isFinite(y)) {
      pts.push({ x, y });
    }
  }
  if (pts.length === 0) return null;
  if (pts.length === 1) return pts[0].y;

  const ascending = pts[pts.length - 1].x >= pts[0].x;
  const sorted = ascending ? pts : [...pts].reverse();

  if (targetX <= sorted[0].x) return sorted[0].y;
  if (targetX >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y;

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (targetX >= a.x && targetX <= b.x) {
      const span = b.x - a.x;
      if (Math.abs(span) <= 1e-12) return a.y;
      const t = (targetX - a.x) / span;
      return a.y + (b.y - a.y) * t;
    }
  }
  return sorted[sorted.length - 1].y;
}

const FORMULA_PRESETS = [
  { label: '+5%', expr: 'X * 1.05' },
  { label: '-5%', expr: 'X * 0.95' },
  { label: '+50', expr: 'X + 50' },
  { label: 'Blend 50%', expr: '(X + CMP) / 2' },
];

export const MapEditorView: React.FC<MapEditorViewProps> = ({
  item,
  bin,
  compareBin,
  onApplyPatches,
  onJumpToHex,
  onResetMap,
  categoryName,
  isLocked = false,
  onToggleLock,
  onOpenXdfEditor,
}) => {
  const rows = item.data.rows;
  const cols = item.data.cols;
  const totalCells = rows * cols;

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [anchorCell, setAnchorCell] = useState<Cell | null>(null);
  const [hoveredCell, setHoveredCell] = useState<Cell | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('bin');
  const [directInput, setDirectInput] = useState<string>('');
  const [percentInput, setPercentInput] = useState<string>('5');
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);

  // Formula popover state
  const [formulaText, setFormulaText] = useState<string>('X * 1.05');

  // Rescale Axis popover state
  const [rescaleAxisTarget, setRescaleAxisTarget] = useState<'x' | 'y'>('x');
  const [rescaleStart, setRescaleStart] = useState<string>('');
  const [rescaleEnd, setRescaleEnd] = useState<string>('');
  const [rescaleInterpolate, setRescaleInterpolate] = useState<boolean>(true);

  const isDraggingRef = useRef<boolean>(false);
  const dragAnchorRef = useRef<Cell | null>(null);
  const directInputRef = useRef<HTMLInputElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  // Reset selection when switching maps
  useEffect(() => {
    setSelectedKeys(new Set());
    setAnchorCell(null);
    setHoveredCell(null);
    setDirectInput('');
    setOpenMenu(null);
  }, [item.id]);

  // If compareBin is removed while in a comparison mode, fall back to 'bin'
  useEffect(() => {
    if (!compareBin && viewMode !== 'bin') {
      setViewMode('bin');
    }
  }, [compareBin, viewMode]);

  // Close dropdown menus when clicking outside
  useEffect(() => {
    if (!openMenu) return;
    const onDocDown = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    window.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  // End drag selection on global mouseup
  useEffect(() => {
    const onUp = () => {
      isDraggingRef.current = false;
    };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, []);

  // Decode X and Y axes
  const { xLabels, yLabels, xValues, yValues, hasEditableX, hasEditableY } = useMemo(() => {
    if (item.itemKind.kind === 'table') {
      return {
        xLabels: BinCodec.axisLabels(item.itemKind.x, cols, bin),
        yLabels: BinCodec.axisLabels(item.itemKind.y, rows, bin),
        xValues: BinCodec.axisValues(item.itemKind.x, cols, bin),
        yValues: BinCodec.axisValues(item.itemKind.y, rows, bin),
        hasEditableX: item.itemKind.x.source.kind === 'data' && cols >= 2,
        hasEditableY: item.itemKind.y.source.kind === 'data' && rows >= 2,
      };
    }
    return {
      xLabels: Array.from({ length: cols }, (_, i) => String(i)),
      yLabels: Array.from({ length: rows }, (_, i) => String(i)),
      xValues: Array.from({ length: cols }, (_, i) => i),
      yValues: Array.from({ length: rows }, (_, i) => i),
      hasEditableX: false,
      hasEditableY: false,
    };
  }, [item, bin, rows, cols]);

  const canRescaleAxis = hasEditableX || hasEditableY;

  // Populate rescale bounds when opening popover or switching X/Y target
  const syncRescaleBounds = useCallback(
    (target: 'x' | 'y') => {
      const vals = target === 'x' ? xValues : yValues;
      if (vals.length >= 2) {
        const axis: Axis | null =
          item.itemKind.kind === 'table'
            ? target === 'x'
              ? item.itemKind.x
              : item.itemKind.y
            : null;
        setRescaleStart(axis ? scalingFormat(axis.scaling, vals[0]) : String(vals[0]));
        setRescaleEnd(
          axis ? scalingFormat(axis.scaling, vals[vals.length - 1]) : String(vals[vals.length - 1]),
        );
      }
    },
    [xValues, yValues, item],
  );

  const handleToggleRescale = () => {
    if (openMenu === 'rescale') {
      setOpenMenu(null);
      return;
    }
    const defaultTarget: 'x' | 'y' = hasEditableX ? 'x' : 'y';
    setRescaleAxisTarget(defaultTarget);
    syncRescaleBounds(defaultTarget);
    setOpenMenu('rescale');
  };

  // Decode table raw & scaled values + comparison values + changed flags
  const tableData = useMemo(() => {
    const rawGrid: (number | null)[][] = [];
    const valGrid: (number | null)[][] = [];
    const cmpRawGrid: (number | null)[][] | null = compareBin ? [] : null;
    const cmpValGrid: (number | null)[][] | null = compareBin ? [] : null;
    const changedSet = new Set<string>();

    let minVal = Infinity;
    let maxVal = -Infinity;
    let minCmp = Infinity;
    let maxCmp = -Infinity;
    let maxAbsDelta = 0;
    let maxAbsDeltaPct = 0;

    for (let r = 0; r < rows; r++) {
      const rRow: (number | null)[] = [];
      const vRow: (number | null)[] = [];
      const crRow: (number | null)[] = [];
      const cvRow: (number | null)[] = [];

      for (let c = 0; c < cols; c++) {
        const cell: Cell = { r, c };
        const raw = BinCodec.raw(item.data, cell, bin);
        const val = raw !== null ? scalingValue(item.scaling, raw) : null;
        rRow.push(raw);
        vRow.push(val);

        if (val !== null && Number.isFinite(val)) {
          if (val < minVal) minVal = val;
          if (val > maxVal) maxVal = val;
        }

        if (compareBin) {
          const craw = BinCodec.raw(item.data, cell, compareBin);
          const cval = craw !== null ? scalingValue(item.scaling, craw) : null;
          crRow.push(craw);
          cvRow.push(cval);

          if (cval !== null && Number.isFinite(cval)) {
            if (cval < minCmp) minCmp = cval;
            if (cval > maxCmp) maxCmp = cval;
          }

          if (raw !== null && craw !== null && raw !== craw) {
            changedSet.add(cellKey(cell));
          }
          if (val !== null && cval !== null && Number.isFinite(val) && Number.isFinite(cval)) {
            const d = val - cval;
            const ad = Math.abs(d);
            if (ad > maxAbsDelta) maxAbsDelta = ad;
            if (Math.abs(cval) > 1e-9) {
              const pct = Math.abs((d / cval) * 100);
              if (pct > maxAbsDeltaPct) maxAbsDeltaPct = pct;
            }
          }
        }
      }

      rawGrid.push(rRow);
      valGrid.push(vRow);
      cmpRawGrid?.push(crRow);
      cmpValGrid?.push(cvRow);
    }

    return {
      rawGrid,
      valGrid,
      cmpRawGrid,
      cmpValGrid,
      changedSet,
      minVal: Number.isFinite(minVal) ? minVal : 0,
      maxVal: Number.isFinite(maxVal) ? maxVal : 1,
      minCmp: Number.isFinite(minCmp) ? minCmp : 0,
      maxCmp: Number.isFinite(maxCmp) ? maxCmp : 1,
      maxAbsDelta: maxAbsDelta > 1e-9 ? maxAbsDelta : 1,
      maxAbsDeltaPct: maxAbsDeltaPct > 1e-9 ? maxAbsDeltaPct : 1,
    };
  }, [item, bin, compareBin, rows, cols]);

  // Close open edit popovers if map becomes locked
  useEffect(() => {
    if (isLocked) setOpenMenu(null);
  }, [isLocked]);

  // Build patches from a map of cellKey -> engineering value
  const commitEngineeringValues = useCallback(
    (updates: Map<string, number>, label: string) => {
      if (isLocked) return;
      const patches: Patch[] = [];
      const n = elementBytes(item.data);

      for (const [key, engVal] of updates.entries()) {
        if (!Number.isFinite(engVal)) continue;
        const cell = parseCellKey(key);
        if (cell.r < 0 || cell.r >= rows || cell.c < 0 || cell.c >= cols) continue;

        const raw = scalingRawFor(item.scaling, engVal, item.data);
        if (raw === null) continue;

        const offset = cellOffset(item.data, cell);
        if (offset < 0 || offset + n > bin.length) continue;

        const oldBytes = bin.slice(offset, offset + n);
        const nextBytes = BinCodec.encode(item.data, raw);
        if (!bytesEqual(oldBytes, nextBytes)) {
          patches.push({ offset, old: oldBytes, next: nextBytes });
        }
      }

      if (patches.length > 0) {
        onApplyPatches(patches, label);
      }
    },
    [isLocked, item, bin, rows, cols, onApplyPatches],
  );

  // Interactive 2D/3D single-cell edit handler
  const handleEditCell = useCallback(
    (cell: Cell, newValue: number) => {
      if (isLocked || viewMode === 'compare' || !Number.isFinite(newValue)) return;
      const key = cellKey(cell);
      const yLbl = yLabels[cell.r] ?? String(cell.r);
      const xLbl = xLabels[cell.c] ?? String(cell.c);
      const formatted = scalingFormat(item.scaling, newValue);
      commitEngineeringValues(new Map([[key, newValue]]), `Edit [${yLbl} × ${xLbl}] → ${formatted}`);
      setAnchorCell(cell);
      setSelectedKeys(new Set([key]));
      setDirectInput(formatted);
    },
    [isLocked, viewMode, yLabels, xLabels, item.scaling, commitEngineeringValues],
  );

  // Selection helpers
  const buildRectSelection = useCallback((a: Cell, b: Cell): Set<string> => {
    const r0 = Math.min(a.r, b.r);
    const r1 = Math.max(a.r, b.r);
    const c0 = Math.min(a.c, b.c);
    const c1 = Math.max(a.c, b.c);
    const next = new Set<string>();
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        next.add(cellKey({ r, c }));
      }
    }
    return next;
  }, []);

  const handleCellMouseDown = (cell: Cell, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const key = cellKey(cell);

    if (e.shiftKey && anchorCell) {
      setSelectedKeys(buildRectSelection(anchorCell, cell));
      return;
    }

    if (e.metaKey || e.ctrlKey) {
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      setAnchorCell(cell);
      return;
    }

    isDraggingRef.current = true;
    dragAnchorRef.current = cell;
    setAnchorCell(cell);
    setSelectedKeys(new Set([key]));

    const val = tableData.valGrid[cell.r]?.[cell.c];
    if (val !== null && val !== undefined) {
      setDirectInput(scalingFormat(item.scaling, val));
    }
  };

  const handleCellMouseEnter = (cell: Cell) => {
    setHoveredCell(cell);
    if (isDraggingRef.current && dragAnchorRef.current) {
      setSelectedKeys(buildRectSelection(dragAnchorRef.current, cell));
    }
  };

  const handleCellDoubleClick = (cell: Cell) => {
    const val = tableData.valGrid[cell.r]?.[cell.c];
    if (val !== null && val !== undefined) {
      setDirectInput(scalingFormat(item.scaling, val));
    }
    directInputRef.current?.focus();
    directInputRef.current?.select();
  };

  const selectRow = (r: number) => {
    const next = new Set<string>();
    for (let c = 0; c < cols; c++) next.add(cellKey({ r, c }));
    setSelectedKeys(next);
    setAnchorCell({ r, c: 0 });
  };

  const selectCol = (c: number) => {
    const next = new Set<string>();
    for (let r = 0; r < rows; r++) next.add(cellKey({ r, c }));
    setSelectedKeys(next);
    setAnchorCell({ r: 0, c });
  };

  const selectAll = () => {
    const next = new Set<string>();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) next.add(cellKey({ r, c }));
    }
    setSelectedKeys(next);
    setAnchorCell({ r: 0, c: 0 });
  };

  // Edit operations
  const handleSetDirect = useCallback(() => {
    if (selectedKeys.size === 0) return;
    const parsed = parseFloat(directInput.replace(',', '.'));
    if (!Number.isFinite(parsed)) return;
    const updates = new Map<string, number>();
    for (const k of selectedKeys) updates.set(k, parsed);
    commitEngineeringValues(updates, `Set ${selectedKeys.size} cell(s) to ${parsed}`);
  }, [selectedKeys, directInput, commitEngineeringValues]);

  const handleStep = useCallback(
    (direction: 1 | -1) => {
      if (selectedKeys.size === 0) return;
      const step = scalingRawStep(item.scaling);
      const updates = new Map<string, number>();
      for (const k of selectedKeys) {
        const cell = parseCellKey(k);
        const cur = tableData.valGrid[cell.r]?.[cell.c];
        if (cur !== null && cur !== undefined && Number.isFinite(cur)) {
          updates.set(k, cur + direction * step);
        }
      }
      commitEngineeringValues(updates, `${direction > 0 ? '+' : '-'}${step} step`);
    },
    [selectedKeys, item.scaling, tableData.valGrid, commitEngineeringValues],
  );

  const handlePercent = useCallback(
    (direction: 1 | -1) => {
      if (selectedKeys.size === 0) return;
      const pct = parseFloat(percentInput.replace(',', '.'));
      if (!Number.isFinite(pct) || pct === 0) return;
      const factor = 1 + (direction * pct) / 100;
      const updates = new Map<string, number>();
      for (const k of selectedKeys) {
        const cell = parseCellKey(k);
        const cur = tableData.valGrid[cell.r]?.[cell.c];
        if (cur !== null && cur !== undefined && Number.isFinite(cur)) {
          updates.set(k, cur * factor);
        }
      }
      commitEngineeringValues(updates, `${direction > 0 ? '+' : '-'}${pct}%`);
    },
    [selectedKeys, percentInput, tableData.valGrid, commitEngineeringValues],
  );

  // Parsed formula + live preview on anchor/first selected cell
  const parsedFormula = useMemo(() => Expr.parse(formulaText), [formulaText]);

  const formulaPreview = useMemo(() => {
    if (!parsedFormula) return null;
    const sampleCell =
      anchorCell ??
      (selectedKeys.size > 0 ? parseCellKey(Array.from(selectedKeys)[0]) : { r: 0, c: 0 });
    const cur = tableData.valGrid[sampleCell.r]?.[sampleCell.c];
    if (cur === null || cur === undefined || !Number.isFinite(cur)) return null;
    const cmp = tableData.cmpValGrid?.[sampleCell.r]?.[sampleCell.c] ?? cur;
    const res = parsedFormula.eval({
      X: cur,
      CMP: cmp,
      AX: xValues[sampleCell.c] ?? sampleCell.c,
      AY: yValues[sampleCell.r] ?? sampleCell.r,
      R: sampleCell.r,
      C: sampleCell.c,
    });
    if (!Number.isFinite(res)) return null;
    return {
      before: scalingFormat(item.scaling, cur),
      after: scalingFormat(item.scaling, res),
    };
  }, [parsedFormula, anchorCell, selectedKeys, tableData, xValues, yValues, item.scaling]);

  const handleApplyFormula = useCallback(() => {
    if (!parsedFormula || selectedKeys.size === 0) return;
    const updates = new Map<string, number>();
    for (const k of selectedKeys) {
      const cell = parseCellKey(k);
      const cur = tableData.valGrid[cell.r]?.[cell.c];
      if (cur === null || cur === undefined || !Number.isFinite(cur)) continue;
      const cmp = tableData.cmpValGrid?.[cell.r]?.[cell.c] ?? cur;
      const res = parsedFormula.eval({
        X: cur,
        CMP: cmp,
        AX: xValues[cell.c] ?? cell.c,
        AY: yValues[cell.r] ?? cell.r,
        R: cell.r,
        C: cell.c,
      });
      if (Number.isFinite(res)) {
        updates.set(k, res);
      }
    }
    commitEngineeringValues(updates, `Formula: ${formulaText.trim()}`);
    setOpenMenu(null);
  }, [parsedFormula, selectedKeys, tableData, xValues, yValues, commitEngineeringValues, formulaText]);

  // Rescale Axis handler
  const handleApplyRescale = useCallback(() => {
    if (isLocked) return;
    if (item.itemKind.kind !== 'table') return;
    const axis = rescaleAxisTarget === 'x' ? item.itemKind.x : item.itemKind.y;
    if (axis.source.kind !== 'data') return;

    const startVal = parseFloat(rescaleStart.replace(',', '.'));
    const endVal = parseFloat(rescaleEnd.replace(',', '.'));
    if (!Number.isFinite(startVal) || !Number.isFinite(endVal)) return;

    const count = rescaleAxisTarget === 'x' ? cols : rows;
    if (count < 2) return;

    const axisLayout = axis.source.layout;
    const axisElemBytes = elementBytes(axisLayout);
    const newAxisVals: number[] = [];
    const patches: Patch[] = [];

    for (let i = 0; i < count; i++) {
      const frac = i / (count - 1);
      const nextVal = startVal + (endVal - startVal) * frac;
      newAxisVals.push(nextVal);

      const raw = scalingRawFor(axis.scaling, nextVal, axisLayout);
      if (raw === null) continue;
      const axisCell: Cell = axisLayout.rows > 1 ? { r: i, c: 0 } : { r: 0, c: i };
      const offset = cellOffset(axisLayout, axisCell);
      if (offset < 0 || offset + axisElemBytes > bin.length) continue;

      const oldBytes = bin.slice(offset, offset + axisElemBytes);
      const nextBytes = BinCodec.encode(axisLayout, raw);
      if (!bytesEqual(oldBytes, nextBytes)) {
        patches.push({ offset, old: oldBytes, next: nextBytes });
      }
    }

    // Optionally resample table data along the rescaled axis to preserve calibration shape
    if (rescaleInterpolate) {
      const dataElemBytes = elementBytes(item.data);
      if (rescaleAxisTarget === 'x') {
        for (let r = 0; r < rows; r++) {
          const oldRow = tableData.valGrid[r];
          for (let c = 0; c < cols; c++) {
            const resampled = sample1D(xValues, oldRow, newAxisVals[c]);
            if (resampled === null || !Number.isFinite(resampled)) continue;
            const raw = scalingRawFor(item.scaling, resampled, item.data);
            if (raw === null) continue;
            const offset = cellOffset(item.data, { r, c });
            if (offset < 0 || offset + dataElemBytes > bin.length) continue;
            const oldBytes = bin.slice(offset, offset + dataElemBytes);
            const nextBytes = BinCodec.encode(item.data, raw);
            if (!bytesEqual(oldBytes, nextBytes)) {
              patches.push({ offset, old: oldBytes, next: nextBytes });
            }
          }
        }
      } else {
        for (let c = 0; c < cols; c++) {
          const oldCol = Array.from({ length: rows }, (_, r) => tableData.valGrid[r]?.[c] ?? null);
          for (let r = 0; r < rows; r++) {
            const resampled = sample1D(yValues, oldCol, newAxisVals[r]);
            if (resampled === null || !Number.isFinite(resampled)) continue;
            const raw = scalingRawFor(item.scaling, resampled, item.data);
            if (raw === null) continue;
            const offset = cellOffset(item.data, { r, c });
            if (offset < 0 || offset + dataElemBytes > bin.length) continue;
            const oldBytes = bin.slice(offset, offset + dataElemBytes);
            const nextBytes = BinCodec.encode(item.data, raw);
            if (!bytesEqual(oldBytes, nextBytes)) {
              patches.push({ offset, old: oldBytes, next: nextBytes });
            }
          }
        }
      }
    }

    if (patches.length > 0) {
      onApplyPatches(
        patches,
        `Rescale ${rescaleAxisTarget.toUpperCase()} axis (${startVal} → ${endVal})`,
      );
    }
    setOpenMenu(null);
  }, [
    item,
    rescaleAxisTarget,
    rescaleStart,
    rescaleEnd,
    rescaleInterpolate,
    cols,
    rows,
    bin,
    tableData.valGrid,
    xValues,
    yValues,
    onApplyPatches,
    isLocked,
  ]);

  const handleRestoreOriginal = useCallback(() => {
    if (isLocked || !compareBin || selectedKeys.size === 0) return;
    const patches: Patch[] = [];
    const n = elementBytes(item.data);

    for (const k of selectedKeys) {
      const cell = parseCellKey(k);
      const offset = cellOffset(item.data, cell);
      if (offset < 0 || offset + n > bin.length || offset + n > compareBin.length) continue;
      const oldBytes = bin.slice(offset, offset + n);
      const nextBytes = compareBin.slice(offset, offset + n);
      if (!bytesEqual(oldBytes, nextBytes)) {
        patches.push({ offset, old: oldBytes, next: nextBytes });
      }
    }
    if (patches.length > 0) {
      onApplyPatches(patches, `Restore ${patches.length} original cell(s)`);
    }
  }, [isLocked, compareBin, selectedKeys, item.data, bin, onApplyPatches]);

  const handleSmooth = useCallback(() => {
    if (selectedKeys.size < 2) return;
    const updates = TableOps.smooth(
      selectedKeys,
      (cell) => tableData.valGrid[cell.r]?.[cell.c] ?? null,
      (cell) => xValues[cell.c] ?? cell.c,
      (cell) => yValues[cell.r] ?? cell.r,
    );
    commitEngineeringValues(updates, `Smooth ${selectedKeys.size} cells`);
  }, [selectedKeys, tableData.valGrid, xValues, yValues, commitEngineeringValues]);

  const handleInterpolate = useCallback(
    (mode: InterpolationMode) => {
      setOpenMenu(null);
      if (selectedKeys.size < 2) return;
      const updates = TableOps.interpolate(
        selectedKeys,
        mode,
        (cell) => tableData.valGrid[cell.r]?.[cell.c] ?? null,
        (cell) => xValues[cell.c] ?? cell.c,
        (cell) => yValues[cell.r] ?? cell.r,
      );
      commitEngineeringValues(updates, `Interpolate (${mode})`);
    },
    [selectedKeys, tableData.valGrid, xValues, yValues, commitEngineeringValues],
  );

  const handleFill = useCallback(
    (dir: 'down' | 'up' | 'right' | 'left') => {
      setOpenMenu(null);
      if (selectedKeys.size < 2) return;
      const updates = TableOps.fill(
        selectedKeys,
        dir,
        (cell) => tableData.valGrid[cell.r]?.[cell.c] ?? null,
      );
      commitEngineeringValues(updates, `Fill ${dir}`);
    },
    [selectedKeys, tableData.valGrid, commitEngineeringValues],
  );

  // Keyboard shortcuts: Cmd/Ctrl+C (TSV copy), Cmd/Ctrl+V (TSV paste), Escape
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (isInput) return;

      if (e.key === 'Escape') {
        setSelectedKeys(new Set());
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && selectedKeys.size > 0) {
        e.preventDefault();
        const cells = Array.from(selectedKeys, parseCellKey);
        const r0 = Math.min(...cells.map((c) => c.r));
        const r1 = Math.max(...cells.map((c) => c.r));
        const c0 = Math.min(...cells.map((c) => c.c));
        const c1 = Math.max(...cells.map((c) => c.c));

        const tsvRows: string[][] = [];
        for (let r = r0; r <= r1; r++) {
          const rowOut: string[] = [];
          for (let c = c0; c <= c1; c++) {
            const raw = tableData.rawGrid[r]?.[c];
            rowOut.push(raw !== null && raw !== undefined ? scalingDisplay(item.scaling, raw, item.data) : '');
          }
          tsvRows.push(rowOut);
        }
        const text = TableOps.tsv(tsvRows);
        navigator.clipboard?.writeText(text).catch(() => {});
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l' && onToggleLock) {
        e.preventDefault();
        onToggleLock();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && selectedKeys.size > 0 && !isLocked) {
        e.preventDefault();
        navigator.clipboard
          ?.readText()
          .then((text) => {
            if (!text) return;
            const grid = TableOps.parseGrid(text);
            if (grid.length === 0) return;

            const cells = Array.from(selectedKeys, parseCellKey);
            const r0 = Math.min(...cells.map((c) => c.r));
            const c0 = Math.min(...cells.map((c) => c.c));

            const updates = new Map<string, number>();
            for (let dr = 0; dr < grid.length; dr++) {
              for (let dc = 0; dc < grid[dr].length; dc++) {
                const r = r0 + dr;
                const c = c0 + dc;
                if (r >= rows || c >= cols) continue;
                const parsed = parseFloat(grid[dr][dc].replace(',', '.'));
                if (Number.isFinite(parsed)) {
                  updates.set(cellKey({ r, c }), parsed);
                }
              }
            }
            commitEngineeringValues(updates, `Paste ${updates.size} cell(s)`);
          })
          .catch(() => {});
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedKeys, tableData.rawGrid, item, rows, cols, commitEngineeringValues, isLocked, onToggleLock]);

  // Min / Max / Avg stats of current selection (or whole table if no selection)
  const stats = useMemo(() => {
    const vals: number[] = [];
    const useSel = selectedKeys.size > 0;
    const keys = useSel
      ? Array.from(selectedKeys)
      : Array.from({ length: totalCells }, (_, idx) =>
          cellKey({ r: Math.floor(idx / cols), c: idx % cols }),
        );

    for (const k of keys) {
      const { r, c } = parseCellKey(k);
      const cur = tableData.valGrid[r]?.[c] ?? null;
      const cmp = tableData.cmpValGrid?.[r]?.[c] ?? null;
      let v: number | null = cur;
      if (viewMode === 'compare') v = cmp;
      else if (viewMode === 'delta') v = cur !== null && cmp !== null ? cur - cmp : null;
      else if (viewMode === 'deltaPct') {
        v = cur !== null && cmp !== null && Math.abs(cmp) > 1e-9 ? ((cur - cmp) / cmp) * 100 : null;
      }
      if (v !== null && Number.isFinite(v)) vals.push(v);
    }

    if (vals.length === 0) return { min: null, max: null, avg: null, scoped: useSel };
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const v of vals) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    return { min, max, avg: sum / vals.length, scoped: useSel };
  }, [selectedKeys, totalCells, cols, tableData, viewMode]);

  const hasSelection = selectedKeys.size > 0;
  const hasMultiSelection = selectedKeys.size >= 2;
  const canEditSelection = hasSelection && !isLocked;
  const canEditMulti = hasMultiSelection && !isLocked;
  const changedCount = tableData.changedSet.size;
  const hexAddr = `0x${item.data.address.toString(16).toUpperCase().padStart(6, '0')}`;
  const badgeLabel =
    categoryName ??
    (item.itemKind.kind === 'table'
      ? 'Map Table'
      : item.itemKind.kind === 'flag'
        ? 'Flag'
        : 'Constant');

  const toolBtnActive =
    'bg-white/[0.06] text-zinc-200 hover:bg-white/[0.11] hover:text-white cursor-pointer';
  const toolBtnDisabled =
    'bg-transparent text-zinc-600 cursor-not-allowed opacity-50';

  return (
    <div className="flex flex-col h-full w-full bg-[#0c0d10] text-zinc-100 overflow-hidden">
      {/* Top Header */}
      <div className="shrink-0 px-4 py-2.5 border-b border-white/[0.065] bg-[#121317]/90 backdrop-blur-xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider bg-white/[0.06] text-zinc-400">
                {badgeLabel}
              </span>
              <h1 className="text-[15px] font-semibold tracking-[-0.015em] text-zinc-100 truncate">
                {item.title}
              </h1>
              {isLocked && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-semibold bg-amber-500/15 border border-amber-500/30 text-amber-300">
                  <Lock className="w-3 h-3" />
                  Locked
                </span>
              )}
              {compareBin && (
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-mono tabular-nums ${
                    changedCount > 0
                      ? 'bg-amber-500/12 text-amber-300'
                      : 'bg-white/[0.045] text-zinc-500'
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      changedCount > 0 ? 'bg-amber-400' : 'bg-zinc-600'
                    }`}
                  />
                  {changedCount} of {totalCells} changed
                </span>
              )}
            </div>

            {/* Metadata Strip */}
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] font-mono tabular-nums text-zinc-500">
              <span className="text-zinc-300">{hexAddr}</span>
              <span className="text-zinc-700">·</span>
              <span>
                {rows}×{cols}
              </span>
              <span className="text-zinc-700">·</span>
              <span>{layoutTypeDescription(item.data)}</span>
              {item.scaling.units && (
                <>
                  <span className="text-zinc-700">·</span>
                  <span className="text-zinc-300">{item.scaling.units}</span>
                </>
              )}
              {item.scaling.equation && item.scaling.equation !== 'X' && (
                <>
                  <span className="text-zinc-700">·</span>
                  <span className="text-zinc-500 truncate max-w-[260px]" title={item.scaling.equation}>
                    f(X) = {item.scaling.equation}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Right Action Buttons */}
          <div className="flex items-center gap-1.5 shrink-0">
            {onToggleLock && (
              <button
                type="button"
                onClick={onToggleLock}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  isLocked
                    ? 'bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25'
                    : 'bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200'
                }`}
                title={isLocked ? 'Unlock map for editing (⌘L)' : 'Lock map against accidental edits (⌘L)'}
              >
                {isLocked ? (
                  <Lock className="w-3.5 h-3.5 text-amber-300" />
                ) : (
                  <Unlock className="w-3.5 h-3.5 text-zinc-400" />
                )}
                {isLocked ? 'Locked' : 'Lock'}
              </button>
            )}
            {onOpenXdfEditor && (
              <button
                type="button"
                onClick={onOpenXdfEditor}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200 transition-colors cursor-pointer"
                title="Edit XDF map definition & scaling"
              >
                <Settings2 className="w-3.5 h-3.5 text-zinc-400" />
                Edit XDF
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                onJumpToHex(anchorCell ? cellOffset(item.data, anchorCell) : item.data.address)
              }
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200 transition-colors cursor-pointer"
              title="Inspect map bytes in Hex Editor"
            >
              <Binary className="w-3.5 h-3.5 text-zinc-400" />
              Hex
            </button>
            <button
              type="button"
              onClick={() => {
                if (!isLocked) onResetMap(item);
              }}
              disabled={isLocked || !compareBin || changedCount === 0}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                !isLocked && compareBin && changedCount > 0
                  ? 'bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 cursor-pointer'
                  : 'bg-white/[0.03] text-zinc-600 cursor-not-allowed opacity-50'
              }`}
              title={isLocked ? 'Unlock map to reset' : 'Reset entire map to comparison BIN'}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset
            </button>
          </div>
        </div>
      </div>

      {/* Frameless Edit Toolbar */}
      <div
        ref={toolbarRef}
        className="shrink-0 px-4 py-1.5 border-b border-white/[0.065] bg-[#101115] flex flex-wrap items-center gap-1.5"
      >
        {/* Direct Value + Set */}
        <div className="flex items-center gap-1">
          <input
            ref={directInputRef}
            type="text"
            disabled={isLocked}
            value={directInput}
            onChange={(e) => setDirectInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isLocked) handleSetDirect();
            }}
            placeholder={isLocked ? 'Locked' : 'Value'}
            className="w-20 px-2 py-1 rounded-md bg-[#17181d] border border-white/[0.065] focus:border-[#0a84ff] focus:outline-none disabled:opacity-45 disabled:cursor-not-allowed text-xs font-mono tabular-nums text-zinc-100 placeholder:text-zinc-600 transition-colors"
          />
          <button
            type="button"
            disabled={!canEditSelection}
            onClick={handleSetDirect}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              canEditSelection
                ? 'bg-[#0a84ff] hover:bg-[#1e8fff] text-white shadow-[0_1px_6px_rgba(10,132,255,0.35)] cursor-pointer'
                : toolBtnDisabled
            }`}
          >
            Set
          </button>
        </div>

        <div className="h-4 w-px bg-white/[0.065] mx-0.5" />

        {/* Step - / + */}
        <div className="flex items-center rounded-md bg-white/[0.04] p-0.5 gap-0.5">
          <button
            type="button"
            disabled={!canEditSelection}
            onClick={() => handleStep(-1)}
            className={`p-1 rounded transition-colors ${
              canEditSelection ? 'text-zinc-200 hover:bg-white/[0.09] hover:text-white cursor-pointer' : 'text-zinc-600 cursor-not-allowed'
            }`}
            title={`Decrement by ${scalingRawStep(item.scaling)}`}
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            disabled={!canEditSelection}
            onClick={() => handleStep(1)}
            className={`p-1 rounded transition-colors ${
              canEditSelection ? 'text-zinc-200 hover:bg-white/[0.09] hover:text-white cursor-pointer' : 'text-zinc-600 cursor-not-allowed'
            }`}
            title={`Increment by ${scalingRawStep(item.scaling)}`}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Percentage -% / +% */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={!canEditSelection}
            onClick={() => handlePercent(-1)}
            className={`px-2 py-1 rounded-md text-xs font-mono font-medium transition-colors ${
              canEditSelection ? toolBtnActive : toolBtnDisabled
            }`}
            title="Decrease selected cells by percentage"
          >
            -%
          </button>
          <input
            type="text"
            disabled={isLocked}
            value={percentInput}
            onChange={(e) => setPercentInput(e.target.value)}
            className="w-11 px-1.5 py-1 rounded-md bg-[#17181d] border border-white/[0.065] focus:border-[#0a84ff] focus:outline-none disabled:opacity-45 disabled:cursor-not-allowed text-xs font-mono tabular-nums text-center text-zinc-100"
            title="Percentage delta"
          />
          <button
            type="button"
            disabled={!canEditSelection}
            onClick={() => handlePercent(1)}
            className={`px-2 py-1 rounded-md text-xs font-mono font-medium transition-colors ${
              canEditSelection ? toolBtnActive : toolBtnDisabled
            }`}
            title="Increase selected cells by percentage"
          >
            +%
          </button>
        </div>

        {/* Formula (fx) Popover */}
        <div className="relative">
          <button
            type="button"
            disabled={!canEditSelection}
            onClick={() => setOpenMenu((m) => (m === 'formula' ? null : 'formula'))}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              openMenu === 'formula'
                ? 'bg-[#0a84ff] text-white cursor-pointer'
                : canEditSelection
                  ? toolBtnActive
                  : toolBtnDisabled
            }`}
            title="Apply mathematical formula (e.g. X * 1.05, clamp(X + 50, 0, 3500))"
          >
            <FunctionSquare className="w-3.5 h-3.5" />
            <span>fx</span>
          </button>

          {openMenu === 'formula' && (
            <div className="absolute left-0 top-full mt-1.5 z-30 w-80 rounded-xl glass-popover p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold tracking-tight text-zinc-100">
                  Apply Formula
                </span>
                <span className="text-[10px] font-mono text-zinc-500">
                  X · CMP · AX · AY · R · C
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  autoFocus
                  value={formulaText}
                  onChange={(e) => setFormulaText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && parsedFormula) handleApplyFormula();
                  }}
                  placeholder="clamp(X * 1.05, 0, 3500)"
                  className="flex-1 px-2.5 py-1.5 rounded-lg bg-[#101115] border border-white/[0.08] focus:border-[#0a84ff] focus:outline-none text-xs font-mono text-zinc-100 placeholder:text-zinc-600"
                />
                <button
                  type="button"
                  disabled={!parsedFormula || !hasSelection}
                  onClick={handleApplyFormula}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#0a84ff] hover:bg-[#1e8fff] disabled:opacity-40 text-white transition-colors cursor-pointer"
                >
                  Apply
                </button>
              </div>

              <div className="flex items-center justify-between text-[11px] font-mono">
                {parsedFormula ? (
                  formulaPreview ? (
                    <span className="text-zinc-400">
                      Preview:{' '}
                      <span className="text-zinc-300">{formulaPreview.before}</span>
                      {' → '}
                      <span className="text-emerald-400 font-semibold">{formulaPreview.after}</span>
                    </span>
                  ) : (
                    <span className="text-zinc-500">Ready ({selectedKeys.size} cells)</span>
                  )
                ) : (
                  <span className="text-rose-400">Invalid expression syntax</span>
                )}
              </div>

              <div className="flex flex-wrap gap-1 pt-1 border-t border-white/[0.065]">
                {FORMULA_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setFormulaText(p.expr)}
                    className="px-2 py-0.5 rounded-md text-[10.5px] font-mono bg-white/[0.05] hover:bg-white/[0.1] text-zinc-300 hover:text-white transition-colors cursor-pointer"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Original */}
        <button
          type="button"
          disabled={!canEditSelection || !compareBin}
          onClick={handleRestoreOriginal}
          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
            canEditSelection && compareBin
              ? 'bg-amber-500/12 text-amber-300 hover:bg-amber-500/22 cursor-pointer'
              : toolBtnDisabled
          }`}
          title="Restore selected cells from comparison BIN"
        >
          <Undo2 className="w-3.5 h-3.5" />
          Original
        </button>

        <div className="h-4 w-px bg-white/[0.065] mx-0.5" />

        {/* Smooth */}
        <button
          type="button"
          disabled={!canEditMulti}
          onClick={handleSmooth}
          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
            canEditMulti ? toolBtnActive : toolBtnDisabled
          }`}
          title="Smooth selected cells (axis-aware 1D/2D)"
        >
          <Sparkles className="w-3.5 h-3.5" />
          Smooth
        </button>

        {/* Interpolate Dropdown */}
        <div className="relative">
          <button
            type="button"
            disabled={!canEditMulti}
            onClick={() => setOpenMenu((m) => (m === 'interpolate' ? null : 'interpolate'))}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              openMenu === 'interpolate'
                ? 'bg-white/[0.12] text-white cursor-pointer'
                : canEditMulti
                  ? toolBtnActive
                  : toolBtnDisabled
            }`}
          >
            <Spline className="w-3.5 h-3.5" />
            Interpolate
            <ChevronDown className="w-3 h-3 opacity-60" />
          </button>
          {openMenu === 'interpolate' && (
            <div className="absolute left-0 top-full mt-1.5 z-30 w-36 rounded-xl glass-popover py-1">
              {(
                [
                  ['horizontal', 'Horizontal'],
                  ['vertical', 'Vertical'],
                  ['bilinear', 'Bilinear'],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => handleInterpolate(m)}
                  className="w-full text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Fill Dropdown */}
        <div className="relative">
          <button
            type="button"
            disabled={!canEditMulti}
            onClick={() => setOpenMenu((m) => (m === 'fill' ? null : 'fill'))}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              openMenu === 'fill'
                ? 'bg-white/[0.12] text-white cursor-pointer'
                : canEditMulti
                  ? toolBtnActive
                  : toolBtnDisabled
            }`}
          >
            <ArrowDownToLine className="w-3.5 h-3.5" />
            Fill
            <ChevronDown className="w-3 h-3 opacity-60" />
          </button>
          {openMenu === 'fill' && (
            <div className="absolute left-0 top-full mt-1.5 z-30 w-32 rounded-xl glass-popover py-1">
              {(
                [
                  ['down', 'Down'],
                  ['up', 'Up'],
                  ['right', 'Right'],
                  ['left', 'Left'],
                ] as const
              ).map(([dir, label]) => (
                <button
                  key={dir}
                  type="button"
                  onClick={() => handleFill(dir)}
                  className="w-full text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Rescale Axis Popover */}
        <div className="relative">
          <button
            type="button"
            disabled={!canRescaleAxis || isLocked}
            onClick={handleToggleRescale}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              openMenu === 'rescale'
                ? 'bg-[#0a84ff] text-white cursor-pointer'
                : canRescaleAxis && !isLocked
                  ? toolBtnActive
                  : toolBtnDisabled
            }`}
            title="Rescale X or Y axis breakpoints and optionally resample map values"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Rescale Axis
          </button>

          {openMenu === 'rescale' && (
            <div className="absolute left-0 top-full mt-1.5 z-30 w-72 rounded-xl glass-popover p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold tracking-tight text-zinc-100">
                  Rescale Breakpoints
                </span>
                <div className="inline-flex rounded-md bg-white/[0.05] p-0.5">
                  <button
                    type="button"
                    disabled={!hasEditableX}
                    onClick={() => {
                      setRescaleAxisTarget('x');
                      syncRescaleBounds('x');
                    }}
                    className={`px-2 py-0.5 rounded text-[10.5px] font-medium transition-colors ${
                      rescaleAxisTarget === 'x'
                        ? 'bg-[#0a84ff] text-white'
                        : hasEditableX
                          ? 'text-zinc-400 hover:text-zinc-200 cursor-pointer'
                          : 'text-zinc-600 cursor-not-allowed'
                    }`}
                  >
                    X Axis
                  </button>
                  <button
                    type="button"
                    disabled={!hasEditableY}
                    onClick={() => {
                      setRescaleAxisTarget('y');
                      syncRescaleBounds('y');
                    }}
                    className={`px-2 py-0.5 rounded text-[10.5px] font-medium transition-colors ${
                      rescaleAxisTarget === 'y'
                        ? 'bg-[#0a84ff] text-white'
                        : hasEditableY
                          ? 'text-zinc-400 hover:text-zinc-200 cursor-pointer'
                          : 'text-zinc-600 cursor-not-allowed'
                    }`}
                  >
                    Y Axis
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="block text-[10px] uppercase tracking-wider text-zinc-500">
                    Start
                  </span>
                  <input
                    type="text"
                    value={rescaleStart}
                    onChange={(e) => setRescaleStart(e.target.value)}
                    className="w-full px-2 py-1 rounded-lg bg-[#101115] border border-white/[0.08] focus:border-[#0a84ff] focus:outline-none text-xs font-mono tabular-nums text-zinc-100"
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-[10px] uppercase tracking-wider text-zinc-500">
                    End
                  </span>
                  <input
                    type="text"
                    value={rescaleEnd}
                    onChange={(e) => setRescaleEnd(e.target.value)}
                    className="w-full px-2 py-1 rounded-lg bg-[#101115] border border-white/[0.08] focus:border-[#0a84ff] focus:outline-none text-xs font-mono tabular-nums text-zinc-100"
                  />
                </label>
              </div>

              <label className="flex items-center gap-2 text-[11px] text-zinc-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={rescaleInterpolate}
                  onChange={(e) => setRescaleInterpolate(e.target.checked)}
                  className="rounded accent-[#0a84ff]"
                />
                <span>Resample map values to preserve shape</span>
              </label>

              <div className="flex justify-end gap-1.5 pt-1 border-t border-white/[0.065]">
                <button
                  type="button"
                  onClick={() => setOpenMenu(null)}
                  className="px-2.5 py-1 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.05] transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleApplyRescale}
                  className="px-3 py-1 rounded-lg text-xs font-medium bg-[#0a84ff] hover:bg-[#1e8fff] text-white transition-colors cursor-pointer"
                >
                  Rescale
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Selected Cell Count (pushed right on wide screens) */}
        <span className="ml-auto text-[11px] font-mono tabular-nums text-zinc-500">
          {hasSelection ? (
            <span className="text-zinc-300">
              {selectedKeys.size} {selectedKeys.size === 1 ? 'cell' : 'cells'}
            </span>
          ) : (
            '0 selected'
          )}
        </span>
      </div>

      {/* Comparison Mode Bar + Selection Stats */}
      <div className="shrink-0 px-4 py-1.5 border-b border-white/[0.065] bg-[#0c0d10] flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center rounded-lg bg-white/[0.045] p-0.5">
          {(
            [
              ['bin', 'BIN', false],
              ['compare', 'Comparison', true],
              ['delta', 'Δ', true],
              ['deltaPct', 'Δ %', true],
            ] as const
          ).map(([modeKey, label, needsCmp]) => {
            const disabled = needsCmp && !compareBin;
            const active = viewMode === modeKey;
            return (
              <button
                key={modeKey}
                type="button"
                disabled={disabled}
                onClick={() => setViewMode(modeKey)}
                className={`px-2.5 py-0.5 rounded-md text-[11px] font-medium transition-all ${
                  active
                    ? 'bg-[#0a84ff] text-white shadow-[0_1px_6px_rgba(10,132,255,0.35)]'
                    : disabled
                      ? 'text-zinc-600 cursor-not-allowed'
                      : 'text-zinc-400 hover:text-zinc-200 cursor-pointer'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Min / Max / Avg Summary */}
        <div className="flex items-center gap-3.5 text-[11px] font-mono tabular-nums text-zinc-500">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">
            {stats.scoped ? 'Selection' : 'Table'}
          </span>
          <span>
            min{' '}
            <strong className="text-zinc-200 font-semibold">
              {stats.min !== null ? scalingFormat(item.scaling, stats.min) : '—'}
              {viewMode === 'deltaPct' && stats.min !== null ? '%' : ''}
            </strong>
          </span>
          <span>
            max{' '}
            <strong className="text-zinc-200 font-semibold">
              {stats.max !== null ? scalingFormat(item.scaling, stats.max) : '—'}
              {viewMode === 'deltaPct' && stats.max !== null ? '%' : ''}
            </strong>
          </span>
          <span>
            avg{' '}
            <strong className="text-zinc-100 font-semibold">
              {stats.avg !== null ? scalingFormat(item.scaling, stats.avg) : '—'}
              {viewMode === 'deltaPct' && stats.avg !== null ? '%' : ''}
            </strong>
          </span>
        </div>
      </div>

      {/* Main Body: Iconic Jewel-Tile Thermal Heatmap + Bottom Split Visualizations */}
      <div className="flex-1 min-h-0 flex flex-col gap-3 p-3 overflow-hidden">
        {/* Jewel-Tile Thermal Heatmap Container */}
        <div
          className="flex-[1.15] min-h-[180px] rounded-xl bg-[#121317] border border-white/[0.065] p-2 overflow-auto select-none"
          onMouseLeave={() => setHoveredCell(null)}
        >
          <table className="border-separate border-spacing-[2.5px] w-max min-w-full text-[11px] font-mono tabular-nums">
            <thead className="sticky top-0 z-20">
              <tr>
                <th
                  onClick={selectAll}
                  className="sticky left-0 z-30 px-2.5 py-1.5 bg-[#121317] rounded-[5px] text-[10px] font-semibold text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] cursor-pointer text-center min-w-[54px] transition-colors"
                  title="Select all cells"
                >
                  Y \ X
                </th>
                {xLabels.map((lbl, c) => (
                  <th
                    key={c}
                    onClick={() => selectCol(c)}
                    className={`px-2 py-1.5 rounded-[5px] font-medium cursor-pointer transition-colors min-w-[56px] text-right ${
                      hoveredCell?.c === c
                        ? 'bg-white/[0.09] text-white'
                        : 'bg-[#121317] text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.05]'
                    }`}
                    title={`Select column ${lbl}`}
                  >
                    {lbl}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rows }, (_, r) => (
                <tr key={r}>
                  <th
                    onClick={() => selectRow(r)}
                    className={`sticky left-0 z-10 px-2.5 py-1 rounded-[5px] font-medium cursor-pointer transition-colors text-right ${
                      hoveredCell?.r === r
                        ? 'bg-white/[0.09] text-white'
                        : 'bg-[#121317] text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.05]'
                    }`}
                    title={`Select row ${yLabels[r] ?? r}`}
                  >
                    {yLabels[r] ?? r}
                  </th>
                  {Array.from({ length: cols }, (_, c) => {
                    const cell: Cell = { r, c };
                    const key = cellKey(cell);
                    const isSelected = selectedKeys.has(key);
                    const isHovered = hoveredCell?.r === r && hoveredCell?.c === c;
                    const isChanged = tableData.changedSet.has(key);

                    const raw = tableData.rawGrid[r]?.[c] ?? null;
                    const val = tableData.valGrid[r]?.[c] ?? null;
                    const craw = tableData.cmpRawGrid?.[r]?.[c] ?? null;
                    const cval = tableData.cmpValGrid?.[r]?.[c] ?? null;

                    let displayText = '—';
                    let bg = '#1a1b20';
                    let isMutedZero = false;
                    let isColoredTile = false;

                    if (viewMode === 'bin') {
                      if (raw !== null && val !== null) {
                        displayText = scalingDisplay(item.scaling, raw, item.data);
                        const span = tableData.maxVal - tableData.minVal;
                        const t = span > 1e-12 ? (val - tableData.minVal) / span : 0.5;
                        bg = thermalTileBg(t);
                        isColoredTile = true;
                      }
                    } else if (viewMode === 'compare') {
                      if (craw !== null && cval !== null) {
                        displayText = scalingDisplay(item.scaling, craw, item.data);
                        const span = tableData.maxCmp - tableData.minCmp;
                        const t = span > 1e-12 ? (cval - tableData.minCmp) / span : 0.5;
                        bg = thermalTileBg(t);
                        isColoredTile = true;
                      }
                    } else if (viewMode === 'delta') {
                      if (val !== null && cval !== null) {
                        const d = val - cval;
                        const isZero = Math.abs(d) <= 1e-9;
                        if (isZero) {
                          displayText = '·';
                          bg = '#1a1b20';
                          isMutedZero = true;
                        } else {
                          displayText = `${d > 0 ? '+' : ''}${scalingFormat(item.scaling, d)}`;
                          bg = deltaTileBg(d, tableData.maxAbsDelta);
                          isColoredTile = true;
                        }
                      }
                    } else if (viewMode === 'deltaPct') {
                      if (val !== null && cval !== null) {
                        const d = val - cval;
                        if (Math.abs(d) <= 1e-9) {
                          displayText = '·';
                          bg = '#1a1b20';
                          isMutedZero = true;
                        } else if (Math.abs(cval) > 1e-9) {
                          const pct = (d / cval) * 100;
                          displayText = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
                          bg = deltaTileBg(pct, tableData.maxAbsDeltaPct);
                          isColoredTile = true;
                        } else {
                          displayText = '∞';
                          bg = deltaTileBg(d, 1);
                          isColoredTile = true;
                        }
                      }
                    }

                    const tileStyle: React.CSSProperties = {
                      backgroundColor: bg,
                      ...(isColoredTile
                        ? {
                            textShadow: '0 1px 2px rgba(0, 0, 0, 0.45)',
                            boxShadow: isSelected
                              ? undefined
                              : 'inset 0 1px 0 rgba(255, 255, 255, 0.14)',
                          }
                        : {}),
                    };

                    return (
                      <td
                        key={c}
                        onMouseDown={(e) => handleCellMouseDown(cell, e)}
                        onMouseEnter={() => handleCellMouseEnter(cell)}
                        onDoubleClick={() => handleCellDoubleClick(cell)}
                        style={tileStyle}
                        className={`relative px-2 py-1 rounded-[5px] cursor-cell transition-[box-shadow,filter] ${
                          isMutedZero
                            ? 'text-center text-zinc-600 font-normal'
                            : 'text-right text-white font-semibold'
                        } ${
                          isSelected
                            ? 'ring-2 ring-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)] z-[5]'
                            : isHovered
                              ? 'ring-1 ring-white/75 brightness-110 z-[6]'
                              : ''
                        }`}
                      >
                        {isChanged && (
                          <span
                            className="pointer-events-none absolute top-[3px] right-[3px] w-[5px] h-[5px] rounded-full bg-amber-300 shadow-[0_0_4px_rgba(0,0,0,0.75)]"
                            title="Modified from comparison BIN"
                          />
                        )}
                        {displayText}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Bottom Split Pane: 3D Surface (left) & 2D Curves (right) */}
        <div className="flex-1 min-h-[240px] grid grid-cols-1 lg:grid-cols-2 gap-3 overflow-hidden">
          <Surface3DCanvas
            values={viewMode === 'compare' && tableData.cmpValGrid ? tableData.cmpValGrid : tableData.valGrid}
            compareValues={viewMode === 'compare' ? tableData.valGrid : tableData.cmpValGrid}
            xLabels={xLabels}
            yLabels={yLabels}
            units={item.scaling.units}
            decimals={item.scaling.decimals}
            hoveredCell={hoveredCell}
            selectedKeys={selectedKeys}
            onHoverCell={setHoveredCell}
            onSelectCell={(cell) => {
              setAnchorCell(cell);
              setSelectedKeys(new Set([cellKey(cell)]));
            }}
            onEditCell={isLocked || viewMode === 'compare' ? undefined : handleEditCell}
            isLocked={isLocked || viewMode === 'compare'}
          />
          <Curves2DCanvas
            values={viewMode === 'compare' && tableData.cmpValGrid ? tableData.cmpValGrid : tableData.valGrid}
            compareValues={viewMode === 'compare' ? tableData.valGrid : tableData.cmpValGrid}
            xLabels={xLabels}
            yLabels={yLabels}
            xValues={xValues}
            units={item.scaling.units}
            decimals={item.scaling.decimals}
            selectedKeys={selectedKeys}
            hoveredCell={hoveredCell}
            onHoverCell={setHoveredCell}
            onEditCell={isLocked || viewMode === 'compare' ? undefined : handleEditCell}
            isLocked={isLocked || viewMode === 'compare'}
          />
        </div>
      </div>
    </div>
  );
};

export default MapEditorView;
