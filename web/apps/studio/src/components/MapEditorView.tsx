import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  Binary,
  ChevronDown,
  Minus,
  Plus,
  RotateCcw,
  Sparkles,
  Spline,
  Undo2,
} from 'lucide-react';
import {
  BinCodec,
  Cell,
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
}

type ViewMode = 'bin' | 'compare' | 'delta' | 'deltaPct';

/** Smooth thermal gradient (blue -> cyan -> green -> yellow -> orange -> red) */
function thermalCellBg(tRaw: number): string {
  const t = Math.max(0, Math.min(1, Number.isFinite(tRaw) ? tRaw : 0.5));
  const stops: [number, number, number][] = [
    [30, 80, 210],   // blue
    [20, 184, 218],  // cyan
    [34, 197, 94],   // green
    [234, 179, 8],   // yellow
    [249, 115, 22],  // orange
    [239, 68, 68],   // red
  ];
  const scaled = t * (stops.length - 1);
  const idx = Math.min(stops.length - 2, Math.floor(scaled));
  const frac = scaled - idx;
  const a = stops[idx];
  const b = stops[idx + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * frac);
  const g = Math.round(a[1] + (b[1] - a[1]) * frac);
  const bl = Math.round(a[2] + (b[2] - a[2]) * frac);
  return `rgba(${r}, ${g}, ${bl}, 0.56)`;
}

function deltaCellBg(delta: number, maxAbs: number): string {
  if (!Number.isFinite(delta) || Math.abs(delta) <= 1e-9) {
    return 'rgba(255, 255, 255, 0.025)';
  }
  const intensity = Math.min(1, Math.abs(delta) / Math.max(1e-9, maxAbs));
  const alpha = 0.26 + intensity * 0.52;
  return delta > 0 ? `rgba(239, 68, 68, ${alpha.toFixed(3)})` : `rgba(37, 137, 255, ${alpha.toFixed(3)})`;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export const MapEditorView: React.FC<MapEditorViewProps> = ({
  item,
  bin,
  compareBin,
  onApplyPatches,
  onJumpToHex,
  onResetMap,
  categoryName,
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
  const [openMenu, setOpenMenu] = useState<'interpolate' | 'fill' | null>(null);

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
  const { xLabels, yLabels, xValues, yValues } = useMemo(() => {
    if (item.itemKind.kind === 'table') {
      return {
        xLabels: BinCodec.axisLabels(item.itemKind.x, cols, bin),
        yLabels: BinCodec.axisLabels(item.itemKind.y, rows, bin),
        xValues: BinCodec.axisValues(item.itemKind.x, cols, bin),
        yValues: BinCodec.axisValues(item.itemKind.y, rows, bin),
      };
    }
    return {
      xLabels: Array.from({ length: cols }, (_, i) => String(i)),
      yLabels: Array.from({ length: rows }, (_, i) => String(i)),
      xValues: Array.from({ length: cols }, (_, i) => i),
      yValues: Array.from({ length: rows }, (_, i) => i),
    };
  }, [item, bin, rows, cols]);

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

  // Build patches from a map of cellKey -> engineering value
  const commitEngineeringValues = useCallback(
    (updates: Map<string, number>, label: string) => {
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
    [item, bin, rows, cols, onApplyPatches],
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

  const handleRestoreOriginal = useCallback(() => {
    if (!compareBin || selectedKeys.size === 0) return;
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
  }, [compareBin, selectedKeys, item.data, bin, onApplyPatches]);

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

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && selectedKeys.size > 0) {
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
  }, [selectedKeys, tableData.rawGrid, item, rows, cols, commitEngineeringValues]);

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
  const changedCount = tableData.changedSet.size;
  const hexAddr = `0x${item.data.address.toString(16).toUpperCase().padStart(6, '0')}`;
  const badgeLabel =
    categoryName ??
    (item.itemKind.kind === 'table'
      ? 'Map Table'
      : item.itemKind.kind === 'flag'
        ? 'Flag'
        : 'Constant');

  const activeToolbarBtn =
    'bg-[#2589ff]/15 text-sky-200 border-[#2589ff]/40 hover:bg-[#2589ff]/25 hover:text-white cursor-pointer';
  const idleToolbarBtn =
    'bg-white/[0.03] text-slate-500 border-white/[0.08] cursor-not-allowed opacity-60';

  return (
    <div className="flex flex-col h-full w-full bg-[#0d1016] text-slate-100 overflow-hidden">
      {/* Top Header */}
      <div className="shrink-0 px-4 py-3 border-b border-white/10 bg-[#141821]/85 backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider bg-[#2589ff]/15 text-[#60a5fa] border border-[#2589ff]/30">
                {badgeLabel}
              </span>
              <h1 className="text-base font-semibold tracking-tight text-white truncate">
                {item.title}
              </h1>
              {compareBin && (
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-mono tabular-nums border ${
                    changedCount > 0
                      ? 'bg-[#f59e0b]/15 text-[#fbbf24] border-[#f59e0b]/40'
                      : 'bg-white/[0.04] text-slate-400 border-white/10'
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      changedCount > 0 ? 'bg-[#f59e0b]' : 'bg-slate-500'
                    }`}
                  />
                  {changedCount} of {totalCells} cells changed
                </span>
              )}
            </div>

            {/* Metadata Strip */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono tabular-nums text-slate-400">
              <span className="text-slate-300"># {hexAddr}</span>
              <span className="text-white/20">•</span>
              <span>
                {rows}×{cols}
              </span>
              <span className="text-white/20">•</span>
              <span>{layoutTypeDescription(item.data)}</span>
              {item.scaling.units && (
                <>
                  <span className="text-white/20">•</span>
                  <span className="text-sky-300/90">{item.scaling.units}</span>
                </>
              )}
              {item.scaling.equation && item.scaling.equation !== 'X' && (
                <>
                  <span className="text-white/20">•</span>
                  <span className="text-slate-400 truncate max-w-[260px]" title={item.scaling.equation}>
                    f(X) = {item.scaling.equation}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Right Action Buttons */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() =>
                onJumpToHex(anchorCell ? cellOffset(item.data, anchorCell) : item.data.address)
              }
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white/[0.05] hover:bg-white/[0.1] text-slate-200 border border-white/10 transition-colors cursor-pointer"
              title="Inspect map bytes in Hex Editor"
            >
              <Binary className="w-3.5 h-3.5 text-[#2589ff]" />
              Hex
            </button>
            <button
              type="button"
              onClick={() => onResetMap(item)}
              disabled={!compareBin || changedCount === 0}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                compareBin && changedCount > 0
                  ? 'bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 border-amber-500/35 cursor-pointer'
                  : 'bg-white/[0.03] text-slate-500 border-white/[0.08] cursor-not-allowed opacity-60'
              }`}
              title="Reset entire map to comparison BIN"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset
            </button>
          </div>
        </div>
      </div>

      {/* Edit Toolbar */}
      <div
        ref={toolbarRef}
        className="shrink-0 px-4 py-2 border-b border-white/10 bg-[#141821]/60 flex flex-wrap items-center gap-2"
      >
        {/* Direct Value + Set */}
        <div className="flex items-center gap-1">
          <input
            ref={directInputRef}
            type="text"
            value={directInput}
            onChange={(e) => setDirectInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSetDirect();
            }}
            placeholder="Value"
            className="w-24 px-2 py-1 rounded-md bg-[#0d1016] border border-white/10 focus:border-[#2589ff] focus:outline-none text-xs font-mono tabular-nums text-slate-100 placeholder:text-slate-500"
          />
          <button
            type="button"
            disabled={!hasSelection}
            onClick={handleSetDirect}
            className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
              hasSelection ? activeToolbarBtn : idleToolbarBtn
            }`}
          >
            Set
          </button>
        </div>

        <div className="h-4 w-px bg-white/10" />

        {/* Step - / + */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={!hasSelection}
            onClick={() => handleStep(-1)}
            className={`p-1.5 rounded-md border transition-colors ${
              hasSelection ? activeToolbarBtn : idleToolbarBtn
            }`}
            title={`Decrement by ${scalingRawStep(item.scaling)}`}
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            disabled={!hasSelection}
            onClick={() => handleStep(1)}
            className={`p-1.5 rounded-md border transition-colors ${
              hasSelection ? activeToolbarBtn : idleToolbarBtn
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
            disabled={!hasSelection}
            onClick={() => handlePercent(-1)}
            className={`px-2 py-1 rounded-md text-xs font-mono font-medium border transition-colors ${
              hasSelection ? activeToolbarBtn : idleToolbarBtn
            }`}
            title="Decrease selected cells by percentage"
          >
            -%
          </button>
          <input
            type="text"
            value={percentInput}
            onChange={(e) => setPercentInput(e.target.value)}
            className="w-12 px-1.5 py-1 rounded-md bg-[#0d1016] border border-white/10 focus:border-[#2589ff] focus:outline-none text-xs font-mono tabular-nums text-center text-slate-100"
            title="Percentage delta"
          />
          <button
            type="button"
            disabled={!hasSelection}
            onClick={() => handlePercent(1)}
            className={`px-2 py-1 rounded-md text-xs font-mono font-medium border transition-colors ${
              hasSelection ? activeToolbarBtn : idleToolbarBtn
            }`}
            title="Increase selected cells by percentage"
          >
            +%
          </button>
        </div>

        {/* Original */}
        <button
          type="button"
          disabled={!hasSelection || !compareBin}
          onClick={handleRestoreOriginal}
          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
            hasSelection && compareBin
              ? 'bg-amber-500/15 text-amber-200 border-amber-500/35 hover:bg-amber-500/25 cursor-pointer'
              : idleToolbarBtn
          }`}
          title="Restore selected cells from comparison BIN"
        >
          <Undo2 className="w-3.5 h-3.5" />
          Original
        </button>

        <div className="h-4 w-px bg-white/10" />

        {/* Selected Cell Count Badge */}
        <span
          className={`px-2 py-0.5 rounded-full text-[11px] font-mono tabular-nums border ${
            hasSelection
              ? 'bg-[#2589ff]/15 text-sky-300 border-[#2589ff]/35'
              : 'bg-white/[0.03] text-slate-500 border-white/10'
          }`}
        >
          {selectedKeys.size} {selectedKeys.size === 1 ? 'cell' : 'cells'}
        </span>

        {/* Smooth */}
        <button
          type="button"
          disabled={!hasMultiSelection}
          onClick={handleSmooth}
          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
            hasMultiSelection ? activeToolbarBtn : idleToolbarBtn
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
            disabled={!hasMultiSelection}
            onClick={() => setOpenMenu((m) => (m === 'interpolate' ? null : 'interpolate'))}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
              hasMultiSelection ? activeToolbarBtn : idleToolbarBtn
            }`}
          >
            <Spline className="w-3.5 h-3.5" />
            Interpolate
            <ChevronDown className="w-3 h-3 opacity-75" />
          </button>
          {openMenu === 'interpolate' && (
            <div className="absolute left-0 top-full mt-1.5 z-30 w-36 rounded-lg glass-popover py-1">
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
                  className="w-full text-left px-3 py-1.5 text-xs text-slate-200 hover:bg-[#2589ff]/20 hover:text-white transition-colors cursor-pointer"
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
            disabled={!hasMultiSelection}
            onClick={() => setOpenMenu((m) => (m === 'fill' ? null : 'fill'))}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
              hasMultiSelection ? activeToolbarBtn : idleToolbarBtn
            }`}
          >
            <ArrowDownToLine className="w-3.5 h-3.5" />
            Fill
            <ChevronDown className="w-3 h-3 opacity-75" />
          </button>
          {openMenu === 'fill' && (
            <div className="absolute left-0 top-full mt-1.5 z-30 w-32 rounded-lg glass-popover py-1">
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
                  className="w-full text-left px-3 py-1.5 text-xs text-slate-200 hover:bg-[#2589ff]/20 hover:text-white transition-colors cursor-pointer"
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Comparison Mode Bar + Selection Stats */}
      <div className="shrink-0 px-4 py-1.5 border-b border-white/10 bg-[#0d1016]/80 flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center rounded-lg bg-[#141821] p-0.5 border border-white/10">
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
                className={`px-2.5 py-0.5 rounded-md text-[11px] font-medium transition-colors ${
                  active
                    ? 'bg-[#2589ff] text-white shadow-sm'
                    : disabled
                      ? 'text-slate-600 cursor-not-allowed'
                      : 'text-slate-400 hover:text-slate-200 cursor-pointer'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Min / Max / Avg Summary */}
        <div className="flex items-center gap-3 text-[11px] font-mono tabular-nums text-slate-400">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">
            {stats.scoped ? 'Selection' : 'Table'}
          </span>
          <span>
            min{' '}
            <strong className="text-slate-200 font-semibold">
              {stats.min !== null ? scalingFormat(item.scaling, stats.min) : '—'}
              {viewMode === 'deltaPct' && stats.min !== null ? '%' : ''}
            </strong>
          </span>
          <span>
            max{' '}
            <strong className="text-slate-200 font-semibold">
              {stats.max !== null ? scalingFormat(item.scaling, stats.max) : '—'}
              {viewMode === 'deltaPct' && stats.max !== null ? '%' : ''}
            </strong>
          </span>
          <span>
            avg{' '}
            <strong className="text-sky-300 font-semibold">
              {stats.avg !== null ? scalingFormat(item.scaling, stats.avg) : '—'}
              {viewMode === 'deltaPct' && stats.avg !== null ? '%' : ''}
            </strong>
          </span>
        </div>
      </div>

      {/* Main Body: Thermal Heatmap Table + Bottom Split Visualizations */}
      <div className="flex-1 min-h-0 flex flex-col gap-3 p-3 overflow-hidden">
        {/* Thermal Heatmap Table Container */}
        <div
          className="flex-[1.15] min-h-[180px] rounded-xl bg-[#141821] border border-white/10 overflow-auto select-none shadow-inner"
          onMouseLeave={() => setHoveredCell(null)}
        >
          <table className="border-collapse w-max min-w-full text-[11px] font-mono tabular-nums">
            <thead className="sticky top-0 z-20">
              <tr>
                <th
                  onClick={selectAll}
                  className="sticky left-0 z-30 px-2.5 py-1.5 bg-[#11151e] border-b border-r border-white/10 text-[10px] font-semibold text-slate-400 hover:text-white cursor-pointer text-center min-w-[54px]"
                  title="Select all cells"
                >
                  Y \ X
                </th>
                {xLabels.map((lbl, c) => (
                  <th
                    key={c}
                    onClick={() => selectCol(c)}
                    className={`px-2 py-1.5 bg-[#11151e] border-b border-r border-white/[0.07] font-medium cursor-pointer transition-colors min-w-[54px] text-right ${
                      hoveredCell?.c === c
                        ? 'text-cyan-300 bg-cyan-500/10'
                        : 'text-slate-400 hover:text-white'
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
                    className={`sticky left-0 z-10 px-2.5 py-1 bg-[#11151e] border-r border-b border-white/[0.07] font-medium cursor-pointer transition-colors text-right ${
                      hoveredCell?.r === r
                        ? 'text-cyan-300 bg-cyan-500/10'
                        : 'text-slate-400 hover:text-white'
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
                    let bg = 'transparent';
                    let textClass = 'text-slate-100';

                    if (viewMode === 'bin') {
                      if (raw !== null && val !== null) {
                        displayText = scalingDisplay(item.scaling, raw, item.data);
                        const span = tableData.maxVal - tableData.minVal;
                        const t = span > 1e-12 ? (val - tableData.minVal) / span : 0.5;
                        bg = thermalCellBg(t);
                      }
                    } else if (viewMode === 'compare') {
                      if (craw !== null && cval !== null) {
                        displayText = scalingDisplay(item.scaling, craw, item.data);
                        const span = tableData.maxCmp - tableData.minCmp;
                        const t = span > 1e-12 ? (cval - tableData.minCmp) / span : 0.5;
                        bg = thermalCellBg(t);
                      }
                    } else if (viewMode === 'delta') {
                      if (val !== null && cval !== null) {
                        const d = val - cval;
                        const isZero = Math.abs(d) <= 1e-9;
                        displayText = isZero
                          ? '0'
                          : `${d > 0 ? '+' : ''}${scalingFormat(item.scaling, d)}`;
                        bg = deltaCellBg(d, tableData.maxAbsDelta);
                        textClass = isZero
                          ? 'text-slate-500'
                          : d > 0
                            ? 'text-rose-200'
                            : 'text-sky-200';
                      }
                    } else if (viewMode === 'deltaPct') {
                      if (val !== null && cval !== null) {
                        const d = val - cval;
                        if (Math.abs(d) <= 1e-9) {
                          displayText = '0%';
                          bg = deltaCellBg(0, 1);
                          textClass = 'text-slate-500';
                        } else if (Math.abs(cval) > 1e-9) {
                          const pct = (d / cval) * 100;
                          displayText = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
                          bg = deltaCellBg(pct, tableData.maxAbsDeltaPct);
                          textClass = pct > 0 ? 'text-rose-200' : 'text-sky-200';
                        } else {
                          displayText = '∞';
                          bg = deltaCellBg(d, 1);
                          textClass = d > 0 ? 'text-rose-200' : 'text-sky-200';
                        }
                      }
                    }

                    return (
                      <td
                        key={c}
                        onMouseDown={(e) => handleCellMouseDown(cell, e)}
                        onMouseEnter={() => handleCellMouseEnter(cell)}
                        onDoubleClick={() => handleCellDoubleClick(cell)}
                        style={{ backgroundColor: bg }}
                        className={`relative px-2 py-1 text-right border-r border-b border-white/[0.06] cursor-cell transition-shadow ${textClass} ${
                          isSelected
                            ? 'ring-2 ring-inset ring-[#2589ff] bg-[#2589ff]/20 z-[5]'
                            : ''
                        } ${
                          isHovered
                            ? 'outline outline-1 outline-cyan-300/90 -outline-offset-1 z-[6]'
                            : ''
                        }`}
                      >
                        {isChanged && (
                          <span
                            className="pointer-events-none absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-[#f59e0b] shadow-[0_0_4px_#f59e0b]"
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
          />
        </div>
      </div>
    </div>
  );
};

export default MapEditorView;
