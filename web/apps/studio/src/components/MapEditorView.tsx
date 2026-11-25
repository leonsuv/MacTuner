import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowLeftRight,
  Binary,
  Box,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Copy,
  Edit3,
  FunctionSquare,
  Info,
  Link2,
  Lock,
  Minus,
  MoreHorizontal,
  Pin,
  Plus,
  RotateCcw,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Spline,
  Star,
  StickyNote,
  Undo2,
  Unlock,
  Wrench,
} from 'lucide-react';
import {
  Axis,
  BinCodec,
  Cell,
  Expr,
  HeatmapPalette,
  InterpolationMode,
  Patch,
  TableOps,
  UnitSystem,
  XDFDefinition,
  XDFItem,
  XdfPatchEntry,
  cellKey,
  cellOffset,
  clampRange,
  displayUnit,
  elementBytes,
  eval1D,
  fillAverage,
  findSyncBlocks,
  flattenRange,
  getUnitConversion,
  isMonotonic,
  layoutTypeDescription,
  parseCellKey,
  scalingDisplay,
  scalingFormat,
  scalingRawFor,
  scalingRawStep,
  scalingValue,
} from '@mactuner/core';
import { getHeatmapCellColors } from '../lib/theme';
import { Surface3DCanvas, type DatalogPoint3D } from './Surface3DCanvas';
import { Curves2DCanvas } from './Curves2DCanvas';

export interface MapEditorOpenBin {
  id: string;
  name: string;
  bytes: Uint8Array;
}

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
  /** Optional extended Swift-parity props (all optional & backwards-compatible) */
  xdf?: XDFDefinition | null;
  onSelectMap?: (itemId: number) => void;
  heatmapPalette?: HeatmapPalette;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  safeRange?: { min?: number; max?: number };
  onUpdateSafeRange?: (range: { min?: number; max?: number } | undefined) => void;
  isPinned?: boolean;
  splitPinnedActive?: boolean;
  onTogglePin?: () => void;
  mirrorPinnedEdits?: boolean;
  onToggleMirrorPinned?: () => void;
  openBins?: MapEditorOpenBin[];
  activeBinId?: string;
  onCopyMapFrom?: (source: { kind: 'compare' | 'bin' | 'map'; id?: string | number }) => void;
  unitSystem?: UnitSystem;
  datalogHits?: Map<string, number> | Record<string, number>;
  datalogActiveCell?: Cell | null;
  datalogPoints?: DatalogPoint3D[];
  userNote?: string;
}

type ViewMode = 'bin' | 'compare' | 'delta' | 'deltaPct';
type OpenMenu =
  | 'interpolate'
  | 'fill'
  | 'formula'
  | 'rescale'
  | 'actions'
  | 'safeRange'
  | 'sharedAxis'
  | 'copyFrom'
  | null;

function deltaTileBg(delta: number, maxAbs: number): string {
  if (!Number.isFinite(delta) || Math.abs(delta) <= 1e-9) {
    return '#1a1b20';
  }
  const intensity = Math.min(1, Math.abs(delta) / Math.max(1e-9, maxAbs));
  const alpha = 0.72 + intensity * 0.24;
  return delta > 0
    ? `rgba(217, 56, 72, ${alpha.toFixed(3)})`
    : `rgba(37, 117, 232, ${alpha.toFixed(3)})`;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function bytesToHexStr(bytes: ArrayLike<number>): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push((bytes[i] & 0xff).toString(16).toUpperCase().padStart(2, '0'));
  }
  return out.join(' ');
}

function fmtHexAddr(addr: number, pad = 6): string {
  return `0x${Math.max(0, addr).toString(16).toUpperCase().padStart(pad, '0')}`;
}

const FORMULA_PRESETS = [
  { label: '+5%', expr: 'X * 1.05' },
  { label: '-5%', expr: 'X * 0.95' },
  { label: '+50', expr: 'X + 50' },
  { label: 'Blend 50%', expr: '(X + CMP) / 2' },
];

const NOTES_STORAGE_KEY = 'mactuner.mapNotes.v1';

function readStoredNote(item: XDFItem): string {
  try {
    const raw = window.localStorage.getItem(NOTES_STORAGE_KEY);
    if (!raw) return '';
    const map = JSON.parse(raw) as Record<string, string>;
    const key = `${item.id}::${item.title.trim().toLowerCase().replace(/\s+/g, ' ')}`;
    return map[key] ?? '';
  } catch {
    return '';
  }
}

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
  xdf = null,
  onSelectMap,
  heatmapPalette = 'classic',
  isFavorite: controlledFavorite,
  onToggleFavorite,
  safeRange: controlledSafeRange,
  onUpdateSafeRange,
  isPinned = false,
  splitPinnedActive = false,
  onTogglePin,
  mirrorPinnedEdits = false,
  onToggleMirrorPinned,
  openBins = [],
  activeBinId,
  onCopyMapFrom,
  unitSystem = 'original',
  datalogHits,
  datalogActiveCell = null,
  datalogPoints,
  userNote,
}) => {
  const rows = item.data.rows;
  const cols = item.data.cols;
  const totalCells = rows * cols;
  const kind = item.itemKind.kind;

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [anchorCell, setAnchorCell] = useState<Cell | null>(null);
  const [focusCell, setFocusCell] = useState<Cell | null>(null);
  const [hoveredCell, setHoveredCell] = useState<Cell | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('bin');
  const [directInput, setDirectInput] = useState<string>('');
  const [inlineTypingBuffer, setInlineTypingBuffer] = useState<string | null>(null);
  const [percentInput, setPercentInput] = useState<string>('5');
  const [stepSizeInput, setStepSizeInput] = useState<string>(() => String(scalingRawStep(item.scaling)));
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);

  // Favorite & Safe Range local fallbacks
  const [internalFavoriteIds, setInternalFavoriteIds] = useState<Set<number>>(() => new Set());
  const [internalSafeRanges, setInternalSafeRanges] = useState<
    Record<number, { min?: number; max?: number }>
  >({});
  const [safeMinText, setSafeMinText] = useState<string>('');
  const [safeMaxText, setSafeMaxText] = useState<string>('');

  // Header & layout toggles
  const [descExpanded, setDescExpanded] = useState<boolean>(false);
  const [transposed, setTransposed] = useState<boolean>(false);
  const [show2D, setShow2D] = useState<boolean>(true);
  const [show3D, setShow3D] = useState<boolean>(true);
  const [editAxesMode, setEditAxesMode] = useState<boolean>(false);
  const [editingAxisCell, setEditingAxisCell] = useState<{ axis: 'x' | 'y'; idx: number; text: string } | null>(null);

  // Sync-Block edit mirroring toggle
  const [syncBlockEdits, setSyncBlockEdits] = useState<boolean>(false);

  // Formula popover state
  const [formulaText, setFormulaText] = useState<string>('X * 1.05');

  // Fill sub-inputs (Flatten / Clamp)
  const [flattenValText, setFlattenValText] = useState<string>('');
  const [clampMinText, setClampMinText] = useState<string>('');
  const [clampMaxText, setClampMaxText] = useState<string>('');

  // Rescale Axis popover state
  const [rescaleAxisTarget, setRescaleAxisTarget] = useState<'x' | 'y'>('x');
  const [rescaleStart, setRescaleStart] = useState<string>('');
  const [rescaleEnd, setRescaleEnd] = useState<string>('');
  const [rescaleInterpolate, setRescaleInterpolate] = useState<boolean>(true);
  const [rescaleExtrapolate, setRescaleExtrapolate] = useState<boolean>(false);
  const [rescaleCascadeShared, setRescaleCascadeShared] = useState<boolean>(true);

  // Cell right-click context menu
  const [cellCtxMenu, setCellCtxMenu] = useState<{ x: number; y: number; cell: Cell } | null>(null);

  const isDraggingRef = useRef<boolean>(false);
  const dragAnchorRef = useRef<Cell | null>(null);
  const directInputRef = useRef<HTMLInputElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);

  const isFavorite =
    controlledFavorite !== undefined ? controlledFavorite : internalFavoriteIds.has(item.id);

  const handleToggleFavorite = useCallback(() => {
    if (onToggleFavorite) {
      onToggleFavorite();
    } else {
      setInternalFavoriteIds((prev) => {
        const next = new Set(prev);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
    }
  }, [onToggleFavorite, item.id]);

  const effectiveSafeRange = useMemo(
    () => controlledSafeRange ?? internalSafeRanges[item.id] ?? item.safeRange,
    [controlledSafeRange, internalSafeRanges, item.id, item.safeRange],
  );

  // Reset per-map transient state when switching maps
  useEffect(() => {
    setSelectedKeys(new Set());
    setAnchorCell(null);
    setFocusCell(null);
    setHoveredCell(null);
    setDirectInput('');
    setInlineTypingBuffer(null);
    setOpenMenu(null);
    setCellCtxMenu(null);
    setEditingAxisCell(null);
    setStepSizeInput(String(scalingRawStep(item.scaling)));
    setDescExpanded(false);
  }, [item.id, item.scaling]);

  // If compareBin is removed while in a comparison mode, fall back to 'bin'
  useEffect(() => {
    if (!compareBin && viewMode !== 'bin') {
      setViewMode('bin');
    }
  }, [compareBin, viewMode]);

  // Close dropdown menus when clicking outside
  useEffect(() => {
    if (!openMenu && !cellCtxMenu) return;
    const onDocDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        openMenu &&
        (!toolbarRef.current || !toolbarRef.current.contains(target)) &&
        (!headerRef.current || !headerRef.current.contains(target))
      ) {
        setOpenMenu(null);
      }
      if (cellCtxMenu && (!ctxMenuRef.current || !ctxMenuRef.current.contains(target))) {
        setCellCtxMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenMenu(null);
        setCellCtxMenu(null);
      }
    };
    window.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openMenu, cellCtxMenu]);

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

  const xMonotonic = useMemo(
    () => (hasEditableX ? isMonotonic(xValues) : true),
    [hasEditableX, xValues],
  );
  const yMonotonic = useMemo(
    () => (hasEditableY ? isMonotonic(yValues) : true),
    [hasEditableY, yValues],
  );

  const canRescaleAxis = hasEditableX || hasEditableY;

  // Shared Axis (COM_AXIS) detection across XDF
  const sharedAxisInfo = useMemo(() => {
    if (!xdf || item.itemKind.kind !== 'table') {
      return { xSiblings: [] as XDFItem[], ySiblings: [] as XDFItem[], allSiblings: [] as XDFItem[] };
    }
    const xAddr = item.itemKind.x.source.kind === 'data' ? item.itemKind.x.source.layout.address : null;
    const yAddr = item.itemKind.y.source.kind === 'data' ? item.itemKind.y.source.layout.address : null;
    const xSiblings: XDFItem[] = [];
    const ySiblings: XDFItem[] = [];
    const seen = new Set<number>();
    const allSiblings: XDFItem[] = [];

    for (const other of xdf.items) {
      if (other.id === item.id || other.itemKind.kind !== 'table') continue;
      const ox = other.itemKind.x.source.kind === 'data' ? other.itemKind.x.source.layout.address : null;
      const oy = other.itemKind.y.source.kind === 'data' ? other.itemKind.y.source.layout.address : null;
      let shared = false;
      if (xAddr !== null && (ox === xAddr || oy === xAddr)) {
        xSiblings.push(other);
        shared = true;
      }
      if (yAddr !== null && (oy === yAddr || ox === yAddr)) {
        ySiblings.push(other);
        shared = true;
      }
      if (shared && !seen.has(other.id)) {
        seen.add(other.id);
        allSiblings.push(other);
      }
    }
    return { xSiblings, ySiblings, allSiblings };
  }, [xdf, item]);

  // Sync-Block Twin Maps detection
  const syncBlockInfo = useMemo(() => {
    if (!xdf || item.itemKind.kind !== 'table' || bin.length === 0) return null;
    const groups = findSyncBlocks(compareBin ?? bin, xdf, 0.92);
    const group = groups.find((g) => g.itemIds.includes(item.id));
    if (!group) return null;
    const members = group.itemIds
      .map((id) => xdf.items.find((it) => it.id === id))
      .filter((it): it is XDFItem => Boolean(it));
    if (members.length < 2) return null;
    const currentIndex = members.findIndex((m) => m.id === item.id);
    return { group, members, currentIndex };
  }, [xdf, item, bin, compareBin]);

  // Same-dimension XDF maps for "Copy From…"
  const sameDimMaps = useMemo(() => {
    if (!xdf || item.itemKind.kind !== 'table') return [];
    return xdf.items.filter(
      (other) =>
        other.id !== item.id &&
        other.itemKind.kind === 'table' &&
        other.data.rows === rows &&
        other.data.cols === cols,
    );
  }, [xdf, item, rows, cols]);

  // Filter out currently active BIN from "Copy From → Open BINs"
  const otherOpenBins = useMemo(
    () => openBins.filter((ob) => (activeBinId ? ob.id !== activeBinId : ob.bytes !== bin)),
    [openBins, activeBinId, bin],
  );

  // Unit system conversion (display-only; binary encoding stays in native XDF units)
  const unitConv = useMemo(
    () => getUnitConversion(item.scaling.units, unitSystem),
    [item.scaling.units, unitSystem],
  );
  const activeUnitLabel = useMemo(
    () => displayUnit(item.scaling.units, unitSystem),
    [item.scaling.units, unitSystem],
  );
  const formatDisplayValue = useCallback(
    (v: number) => {
      if (!unitConv) return scalingFormat(item.scaling, v);
      const dv = unitConv.toDisplay(v);
      const dec = Math.max(item.scaling.decimals, Math.abs(dv) < 10 ? 2 : 1);
      return Number.isFinite(dv) ? dv.toFixed(Math.min(4, dec)) : '—';
    },
    [unitConv, item.scaling],
  );
  const formatDisplayDelta = useCallback(
    (d: number) => {
      if (!unitConv) return scalingFormat(item.scaling, d);
      const dd = d * unitConv.deltaScale;
      const dec = Math.max(item.scaling.decimals, Math.abs(dd) < 10 ? 2 : 1);
      return Number.isFinite(dd) ? dd.toFixed(Math.min(4, dec)) : '—';
    },
    [unitConv, item.scaling],
  );

  // Datalog hit lookup helper
  const getDatalogHitCount = useCallback(
    (key: string): number => {
      if (!datalogHits) return 0;
      if (datalogHits instanceof Map) return datalogHits.get(key) ?? 0;
      return datalogHits[key] ?? 0;
    },
    [datalogHits],
  );

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

  // Decode table raw & scaled values + comparison values + changed flags + safe-range violations
  const tableData = useMemo(() => {
    const rawGrid: (number | null)[][] = [];
    const valGrid: (number | null)[][] = [];
    const cmpRawGrid: (number | null)[][] | null = compareBin ? [] : null;
    const cmpValGrid: (number | null)[][] | null = compareBin ? [] : null;
    const changedSet = new Set<string>();
    const outOfRangeSet = new Set<string>();

    let minVal = Infinity;
    let maxVal = -Infinity;
    let minCmp = Infinity;
    let maxCmp = -Infinity;
    let maxAbsDelta = 0;
    let maxAbsDeltaPct = 0;

    const srMin = effectiveSafeRange?.min;
    const srMax = effectiveSafeRange?.max;

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
          if (
            (srMin !== undefined && Number.isFinite(srMin) && val < srMin) ||
            (srMax !== undefined && Number.isFinite(srMax) && val > srMax)
          ) {
            outOfRangeSet.add(cellKey(cell));
          }
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
      outOfRangeSet,
      minVal: Number.isFinite(minVal) ? minVal : 0,
      maxVal: Number.isFinite(maxVal) ? maxVal : 1,
      minCmp: Number.isFinite(minCmp) ? minCmp : 0,
      maxCmp: Number.isFinite(maxCmp) ? maxCmp : 1,
      maxAbsDelta: maxAbsDelta > 1e-9 ? maxAbsDelta : 1,
      maxAbsDeltaPct: maxAbsDeltaPct > 1e-9 ? maxAbsDeltaPct : 1,
    };
  }, [item, bin, compareBin, rows, cols, effectiveSafeRange]);

  const displayValGrid = useMemo(() => {
    if (!unitConv) return tableData.valGrid;
    return tableData.valGrid.map((row) => row.map((v) => (v !== null ? unitConv.toDisplay(v) : null)));
  }, [tableData.valGrid, unitConv]);

  const displayCmpValGrid = useMemo(() => {
    if (!tableData.cmpValGrid || !unitConv) return tableData.cmpValGrid;
    return tableData.cmpValGrid.map((row) =>
      row.map((v) => (v !== null ? unitConv.toDisplay(v) : null)),
    );
  }, [tableData.cmpValGrid, unitConv]);

  // Close open edit popovers if map becomes locked
  useEffect(() => {
    if (isLocked) {
      setOpenMenu(null);
      setEditingAxisCell(null);
    }
  }, [isLocked]);

  // Build patches from a map of cellKey -> engineering value (optionally mirrored to Sync-Block twins)
  const commitEngineeringValues = useCallback(
    (updates: Map<string, number>, label: string) => {
      if (isLocked) return;
      const patches: Patch[] = [];
      const seenOffsets = new Set<number>();

      const targets: XDFItem[] =
        syncBlockEdits && syncBlockInfo ? syncBlockInfo.members : [item];

      for (const targetItem of targets) {
        const n = elementBytes(targetItem.data);
        for (const [key, engVal] of updates.entries()) {
          if (!Number.isFinite(engVal)) continue;
          const cell = parseCellKey(key);
          if (cell.r < 0 || cell.r >= targetItem.data.rows || cell.c < 0 || cell.c >= targetItem.data.cols) {
            continue;
          }
          const raw = scalingRawFor(targetItem.scaling, engVal, targetItem.data);
          if (raw === null) continue;
          const offset = cellOffset(targetItem.data, cell);
          if (offset < 0 || offset + n > bin.length || seenOffsets.has(offset)) continue;
          seenOffsets.add(offset);

          const oldBytes = bin.slice(offset, offset + n);
          const nextBytes = BinCodec.encode(targetItem.data, raw);
          if (!bytesEqual(oldBytes, nextBytes)) {
            patches.push({ offset, old: oldBytes, next: nextBytes });
          }
        }
      }

      if (patches.length > 0) {
        const suffix = syncBlockEdits && syncBlockInfo ? ` (+${syncBlockInfo.members.length - 1} twins)` : '';
        onApplyPatches(patches, `${label}${suffix}`);
      }
    },
    [isLocked, item, bin, onApplyPatches, syncBlockEdits, syncBlockInfo],
  );

  // Interactive 2D/3D single-cell edit handler
  const handleEditCell = useCallback(
    (cell: Cell, newValue: number) => {
      if (isLocked || viewMode === 'compare' || !Number.isFinite(newValue)) return;
      const nativeValue = unitConv ? unitConv.toNative(newValue) : newValue;
      const key = cellKey(cell);
      const yLbl = yLabels[cell.r] ?? String(cell.r);
      const xLbl = xLabels[cell.c] ?? String(cell.c);
      const formatted = scalingFormat(item.scaling, nativeValue);
      commitEngineeringValues(new Map([[key, nativeValue]]), `Edit [${yLbl} × ${xLbl}] → ${formatted}`);
      setAnchorCell(cell);
      setFocusCell(cell);
      setSelectedKeys(new Set([key]));
      setDirectInput(formatted);
    },
    [isLocked, viewMode, unitConv, yLabels, xLabels, item.scaling, commitEngineeringValues],
  );

  // Inline axis breakpoint commit
  const handleCommitAxisBreakpoint = useCallback(
    (axisKind: 'x' | 'y', idx: number, rawText: string) => {
      setEditingAxisCell(null);
      if (isLocked || item.itemKind.kind !== 'table') return;
      const axis = axisKind === 'x' ? item.itemKind.x : item.itemKind.y;
      if (axis.source.kind !== 'data') return;
      const parsed = parseFloat(rawText.replace(',', '.'));
      if (!Number.isFinite(parsed)) return;

      const layout = axis.source.layout;
      const raw = scalingRawFor(axis.scaling, parsed, layout);
      if (raw === null) return;
      const axisCell: Cell = layout.rows > 1 ? { r: idx, c: 0 } : { r: 0, c: idx };
      const offset = cellOffset(layout, axisCell);
      const n = elementBytes(layout);
      if (offset < 0 || offset + n > bin.length) return;

      const oldBytes = bin.slice(offset, offset + n);
      const nextBytes = BinCodec.encode(layout, raw);
      if (!bytesEqual(oldBytes, nextBytes)) {
        onApplyPatches(
          [{ offset, old: oldBytes, next: nextBytes }],
          `Edit ${axisKind.toUpperCase()}-axis[${idx}] → ${scalingFormat(axis.scaling, parsed)}`,
        );
      }
    },
    [isLocked, item, bin, onApplyPatches],
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
    if (cellCtxMenu) setCellCtxMenu(null);
    if (e.button !== 0) return;
    e.preventDefault();
    setInlineTypingBuffer(null);
    const key = cellKey(cell);

    if (e.shiftKey && anchorCell) {
      setFocusCell(cell);
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
      setFocusCell(cell);
      return;
    }

    isDraggingRef.current = true;
    dragAnchorRef.current = cell;
    setAnchorCell(cell);
    setFocusCell(cell);
    setSelectedKeys(new Set([key]));

    const val = tableData.valGrid[cell.r]?.[cell.c];
    if (val !== null && val !== undefined) {
      setDirectInput(scalingFormat(item.scaling, val));
    }
  };

  const handleCellContextMenu = (cell: Cell, e: React.MouseEvent) => {
    e.preventDefault();
    const key = cellKey(cell);
    if (!selectedKeys.has(key)) {
      setAnchorCell(cell);
      setFocusCell(cell);
      setSelectedKeys(new Set([key]));
    }
    const menuW = 224;
    const menuH = 420;
    const x = Math.min(e.clientX, window.innerWidth - menuW - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuH - 8);
    setCellCtxMenu({ x: Math.max(8, x), y: Math.max(8, y), cell });
  };

  const handleCellMouseEnter = (cell: Cell) => {
    setHoveredCell(cell);
    if (isDraggingRef.current && dragAnchorRef.current) {
      setFocusCell(cell);
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

  const selectRow = useCallback(
    (r: number) => {
      const next = new Set<string>();
      for (let c = 0; c < cols; c++) next.add(cellKey({ r, c }));
      setSelectedKeys(next);
      setAnchorCell({ r, c: 0 });
      setFocusCell({ r, c: Math.max(0, cols - 1) });
    },
    [cols],
  );

  const selectCol = useCallback(
    (c: number) => {
      const next = new Set<string>();
      for (let r = 0; r < rows; r++) next.add(cellKey({ r, c }));
      setSelectedKeys(next);
      setAnchorCell({ r: 0, c });
      setFocusCell({ r: Math.max(0, rows - 1), c });
    },
    [rows],
  );

  const selectAll = useCallback(() => {
    const next = new Set<string>();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) next.add(cellKey({ r, c }));
    }
    setSelectedKeys(next);
    setAnchorCell({ r: 0, c: 0 });
    setFocusCell({ r: Math.max(0, rows - 1), c: Math.max(0, cols - 1) });
  }, [rows, cols]);

  const selectChangedCells = useCallback(() => {
    if (tableData.changedSet.size === 0) return;
    setSelectedKeys(new Set(tableData.changedSet));
    const first = parseCellKey(Array.from(tableData.changedSet)[0]);
    setAnchorCell(first);
    setFocusCell(first);
    setOpenMenu(null);
  }, [tableData.changedSet]);

  // Copy helpers
  const handleCopySelection = useCallback(
    (withAxes = false) => {
      const cells =
        selectedKeys.size > 0
          ? Array.from(selectedKeys, parseCellKey)
          : Array.from({ length: totalCells }, (_, idx) => ({
              r: Math.floor(idx / cols),
              c: idx % cols,
            }));
      if (cells.length === 0) return;
      const r0 = Math.min(...cells.map((c) => c.r));
      const r1 = Math.max(...cells.map((c) => c.r));
      const c0 = Math.min(...cells.map((c) => c.c));
      const c1 = Math.max(...cells.map((c) => c.c));

      const tsvRows: string[][] = [];
      if (withAxes) {
        const header = ['Y \\ X'];
        for (let c = c0; c <= c1; c++) header.push(xLabels[c] ?? String(c));
        tsvRows.push(header);
      }
      for (let r = r0; r <= r1; r++) {
        const rowOut: string[] = [];
        if (withAxes) rowOut.push(yLabels[r] ?? String(r));
        for (let c = c0; c <= c1; c++) {
          const raw = tableData.rawGrid[r]?.[c];
          rowOut.push(
            raw !== null && raw !== undefined ? scalingDisplay(item.scaling, raw, item.data) : '',
          );
        }
        tsvRows.push(rowOut);
      }
      navigator.clipboard?.writeText(TableOps.tsv(tsvRows)).catch(() => {});
      setOpenMenu(null);
    },
    [selectedKeys, totalCells, cols, xLabels, yLabels, tableData.rawGrid, item.scaling, item.data],
  );

  const handlePasteFromClipboard = useCallback(() => {
    if (isLocked || selectedKeys.size === 0) return;
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
  }, [isLocked, selectedKeys, rows, cols, commitEngineeringValues]);

  // Edit operations
  const handleSetDirect = useCallback(
    (overrideText?: string) => {
      if (selectedKeys.size === 0) return;
      const text = overrideText ?? directInput;
      const parsed = parseFloat(text.replace(',', '.'));
      if (!Number.isFinite(parsed)) return;
      const updates = new Map<string, number>();
      for (const k of selectedKeys) updates.set(k, parsed);
      commitEngineeringValues(updates, `Set ${selectedKeys.size} cell(s) to ${parsed}`);
    },
    [selectedKeys, directInput, commitEngineeringValues],
  );

  const resolvedStep = useMemo(() => {
    const parsed = parseFloat(stepSizeInput.replace(',', '.'));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return scalingRawStep(item.scaling);
  }, [stepSizeInput, item.scaling]);

  const handleStep = useCallback(
    (direction: 1 | -1) => {
      if (selectedKeys.size === 0) return;
      const step = resolvedStep;
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
    [selectedKeys, resolvedStep, tableData.valGrid, commitEngineeringValues],
  );

  const handlePercent = useCallback(
    (direction: 1 | -1, overridePct?: number) => {
      if (selectedKeys.size === 0) return;
      const pct = overridePct ?? parseFloat(percentInput.replace(',', '.'));
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

  // Rescale Axis handler (with Extrapolate + Cascade to shared-axis maps)
  const handleApplyRescale = useCallback(() => {
    if (isLocked || item.itemKind.kind !== 'table') return;
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
    const seenOffsets = new Set<number>();

    for (let i = 0; i < count; i++) {
      const frac = i / (count - 1);
      const nextVal = startVal + (endVal - startVal) * frac;
      newAxisVals.push(nextVal);

      const raw = scalingRawFor(axis.scaling, nextVal, axisLayout);
      if (raw === null) continue;
      const axisCell: Cell = axisLayout.rows > 1 ? { r: i, c: 0 } : { r: 0, c: i };
      const offset = cellOffset(axisLayout, axisCell);
      if (offset < 0 || offset + axisElemBytes > bin.length || seenOffsets.has(offset)) continue;
      seenOffsets.add(offset);

      const oldBytes = bin.slice(offset, offset + axisElemBytes);
      const nextBytes = BinCodec.encode(axisLayout, raw);
      if (!bytesEqual(oldBytes, nextBytes)) {
        patches.push({ offset, old: oldBytes, next: nextBytes });
      }
    }

    // Helper to resample a single map along either 'x' or 'y'
    const resampleMap = (targetMap: XDFItem, targetAxis: 'x' | 'y', oldAxisVals: number[]) => {
      const tRows = targetMap.data.rows;
      const tCols = targetMap.data.cols;
      const eb = elementBytes(targetMap.data);
      const readPhys = (r: number, c: number): number => {
        const raw = BinCodec.raw(targetMap.data, { r, c }, bin);
        return raw !== null ? scalingValue(targetMap.scaling, raw) : 0;
      };

      if (targetAxis === 'x' && tCols === newAxisVals.length) {
        for (let r = 0; r < tRows; r++) {
          const oldRow = Array.from({ length: tCols }, (_, c) => readPhys(r, c));
          for (let c = 0; c < tCols; c++) {
            const resampled = eval1D(oldAxisVals, oldRow, newAxisVals[c], rescaleExtrapolate);
            if (!Number.isFinite(resampled)) continue;
            const raw = scalingRawFor(targetMap.scaling, resampled, targetMap.data);
            if (raw === null) continue;
            const offset = cellOffset(targetMap.data, { r, c });
            if (offset < 0 || offset + eb > bin.length || seenOffsets.has(offset)) continue;
            seenOffsets.add(offset);
            const oldBytes = bin.slice(offset, offset + eb);
            const nextBytes = BinCodec.encode(targetMap.data, raw);
            if (!bytesEqual(oldBytes, nextBytes)) {
              patches.push({ offset, old: oldBytes, next: nextBytes });
            }
          }
        }
      } else if (targetAxis === 'y' && tRows === newAxisVals.length) {
        for (let c = 0; c < tCols; c++) {
          const oldCol = Array.from({ length: tRows }, (_, r) => readPhys(r, c));
          for (let r = 0; r < tRows; r++) {
            const resampled = eval1D(oldAxisVals, oldCol, newAxisVals[r], rescaleExtrapolate);
            if (!Number.isFinite(resampled)) continue;
            const raw = scalingRawFor(targetMap.scaling, resampled, targetMap.data);
            if (raw === null) continue;
            const offset = cellOffset(targetMap.data, { r, c });
            if (offset < 0 || offset + eb > bin.length || seenOffsets.has(offset)) continue;
            seenOffsets.add(offset);
            const oldBytes = bin.slice(offset, offset + eb);
            const nextBytes = BinCodec.encode(targetMap.data, raw);
            if (!bytesEqual(oldBytes, nextBytes)) {
              patches.push({ offset, old: oldBytes, next: nextBytes });
            }
          }
        }
      }
    };

    if (rescaleInterpolate) {
      const oldAxisVals = rescaleAxisTarget === 'x' ? xValues : yValues;
      resampleMap(item, rescaleAxisTarget, oldAxisVals);

      // Cascade to shared-axis sibling maps if enabled
      if (rescaleCascadeShared) {
        const siblings =
          rescaleAxisTarget === 'x' ? sharedAxisInfo.xSiblings : sharedAxisInfo.ySiblings;
        const axisAddr = axisLayout.address;
        for (const sib of siblings) {
          if (sib.itemKind.kind !== 'table') continue;
          if (
            sib.itemKind.x.source.kind === 'data' &&
            sib.itemKind.x.source.layout.address === axisAddr
          ) {
            resampleMap(sib, 'x', oldAxisVals);
          }
          if (
            sib.itemKind.y.source.kind === 'data' &&
            sib.itemKind.y.source.layout.address === axisAddr
          ) {
            resampleMap(sib, 'y', oldAxisVals);
          }
        }
      }
    }

    if (patches.length > 0) {
      const sibCount = rescaleCascadeShared
        ? (rescaleAxisTarget === 'x' ? sharedAxisInfo.xSiblings : sharedAxisInfo.ySiblings).length
        : 0;
      const cascadeLabel = sibCount > 0 ? ` (+${sibCount} shared)` : '';
      onApplyPatches(
        patches,
        `Rescale ${rescaleAxisTarget.toUpperCase()} axis (${startVal} → ${endVal})${cascadeLabel}`,
      );
    }
    setOpenMenu(null);
  }, [
    isLocked,
    item,
    rescaleAxisTarget,
    rescaleStart,
    rescaleEnd,
    rescaleInterpolate,
    rescaleExtrapolate,
    rescaleCascadeShared,
    sharedAxisInfo,
    cols,
    rows,
    bin,
    xValues,
    yValues,
    onApplyPatches,
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

  // Fill: Set to Average / Flatten / Clamp using core tableOps helpers
  const numericGrid = useMemo(
    () => tableData.valGrid.map((row) => row.map((v) => (v !== null && Number.isFinite(v) ? v : 0))),
    [tableData.valGrid],
  );

  const handleFillAverage = useCallback(() => {
    setOpenMenu(null);
    if (selectedKeys.size < 2) return;
    const nextGrid = fillAverage(numericGrid, selectedKeys);
    const updates = new Map<string, number>();
    for (const k of selectedKeys) {
      const { r, c } = parseCellKey(k);
      updates.set(k, nextGrid[r][c]);
    }
    commitEngineeringValues(updates, `Set ${selectedKeys.size} cells to average`);
  }, [selectedKeys, numericGrid, commitEngineeringValues]);

  const handleFlatten = useCallback(() => {
    const val = parseFloat(flattenValText.replace(',', '.'));
    if (!Number.isFinite(val) || selectedKeys.size === 0) return;
    setOpenMenu(null);
    const nextGrid = flattenRange(numericGrid, selectedKeys, val);
    const updates = new Map<string, number>();
    for (const k of selectedKeys) {
      const { r, c } = parseCellKey(k);
      updates.set(k, nextGrid[r][c]);
    }
    commitEngineeringValues(updates, `Flatten ${selectedKeys.size} cells to ${val}`);
  }, [flattenValText, selectedKeys, numericGrid, commitEngineeringValues]);

  const handleClamp = useCallback(() => {
    if (selectedKeys.size === 0) return;
    const minV = clampMinText.trim() ? parseFloat(clampMinText.replace(',', '.')) : undefined;
    const maxV = clampMaxText.trim() ? parseFloat(clampMaxText.replace(',', '.')) : undefined;
    if (minV === undefined && maxV === undefined) return;
    setOpenMenu(null);
    const nextGrid = clampRange(numericGrid, selectedKeys, minV, maxV);
    const updates = new Map<string, number>();
    for (const k of selectedKeys) {
      const { r, c } = parseCellKey(k);
      updates.set(k, nextGrid[r][c]);
    }
    commitEngineeringValues(updates, `Clamp ${selectedKeys.size} cells`);
  }, [clampMinText, clampMaxText, selectedKeys, numericGrid, commitEngineeringValues]);

  // Copy From handler (Compare BIN, another Open BIN, or another XDF map of same dimensions)
  const handleCopyFromSource = useCallback(
    (source: { kind: 'compare' | 'bin' | 'map'; id?: string | number }) => {
      setOpenMenu(null);
      if (isLocked) return;
      if (onCopyMapFrom) {
        onCopyMapFrom(source);
        return;
      }

      if (source.kind === 'compare' && compareBin) {
        onResetMap(item);
        return;
      }

      if (source.kind === 'bin') {
        const srcBin = openBins.find((b) => b.id === source.id);
        if (!srcBin) return;
        const patches: Patch[] = [];
        const n = elementBytes(item.data);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const offset = cellOffset(item.data, { r, c });
            if (offset < 0 || offset + n > bin.length || offset + n > srcBin.bytes.length) continue;
            const oldBytes = bin.slice(offset, offset + n);
            const nextBytes = srcBin.bytes.slice(offset, offset + n);
            if (!bytesEqual(oldBytes, nextBytes)) {
              patches.push({ offset, old: oldBytes, next: nextBytes });
            }
          }
        }
        if (patches.length > 0) {
          onApplyPatches(patches, `Copy map from ${srcBin.name}`);
        }
        return;
      }

      if (source.kind === 'map' && xdf) {
        const srcMap = xdf.items.find((it) => it.id === source.id);
        if (!srcMap) return;
        const updates = new Map<string, number>();
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const raw = BinCodec.raw(srcMap.data, { r, c }, bin);
            if (raw === null) continue;
            const val = scalingValue(srcMap.scaling, raw);
            if (Number.isFinite(val)) updates.set(cellKey({ r, c }), val);
          }
        }
        commitEngineeringValues(updates, `Copy values from ${srcMap.title}`);
      }
    },
    [
      isLocked,
      onCopyMapFrom,
      compareBin,
      onResetMap,
      item,
      openBins,
      rows,
      cols,
      bin,
      onApplyPatches,
      xdf,
      commitEngineeringValues,
    ],
  );

  // Full Keyboard Grid Navigation & Shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (isInput) return;

      if (kind !== 'table') return;

      // Escape: cancel inline typing or clear selection
      if (e.key === 'Escape') {
        if (inlineTypingBuffer !== null) {
          setInlineTypingBuffer(null);
        } else {
          setSelectedKeys(new Set());
        }
        return;
      }

      // Inline typing mode active
      if (inlineTypingBuffer !== null && !isLocked) {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleSetDirect(inlineTypingBuffer);
          setDirectInput(inlineTypingBuffer);
          setInlineTypingBuffer(null);
          return;
        }
        if (e.key === 'Backspace') {
          e.preventDefault();
          setInlineTypingBuffer((prev) => (prev && prev.length > 1 ? prev.slice(0, -1) : null));
          return;
        }
        if (/^[0-9.,-]$/.test(e.key)) {
          e.preventDefault();
          setInlineTypingBuffer((prev) => `${prev ?? ''}${e.key}`);
          return;
        }
      }

      // Select All (Cmd/Ctrl+A)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAll();
        return;
      }

      // Copy (Cmd/Ctrl+C)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && selectedKeys.size > 0) {
        e.preventDefault();
        handleCopySelection(false);
        return;
      }

      // Paste (Cmd/Ctrl+V)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && selectedKeys.size > 0 && !isLocked) {
        e.preventDefault();
        handlePasteFromClipboard();
        return;
      }

      // Tab toggles BIN <-> Comparison view
      if (e.key === 'Tab' && compareBin) {
        e.preventDefault();
        setViewMode((prev) => (prev === 'compare' ? 'bin' : 'compare'));
        return;
      }

      // Arrow keys move cursor / Shift+Arrow expands selection
      if (
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown' ||
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight'
      ) {
        e.preventDefault();
        setInlineTypingBuffer(null);
        const dr =
          transposed
            ? e.key === 'ArrowLeft'
              ? -1
              : e.key === 'ArrowRight'
                ? 1
                : 0
            : e.key === 'ArrowUp'
              ? -1
              : e.key === 'ArrowDown'
                ? 1
                : 0;
        const dc =
          transposed
            ? e.key === 'ArrowUp'
              ? -1
              : e.key === 'ArrowDown'
                ? 1
                : 0
            : e.key === 'ArrowLeft'
              ? -1
              : e.key === 'ArrowRight'
                ? 1
                : 0;

        const base = focusCell ?? anchorCell ?? { r: 0, c: 0 };
        const next: Cell = {
          r: Math.max(0, Math.min(rows - 1, base.r + dr)),
          c: Math.max(0, Math.min(cols - 1, base.c + dc)),
        };

        if (e.shiftKey && anchorCell) {
          setFocusCell(next);
          setSelectedKeys(buildRectSelection(anchorCell, next));
        } else {
          setAnchorCell(next);
          setFocusCell(next);
          setSelectedKeys(new Set([cellKey(next)]));
          const val = tableData.valGrid[next.r]?.[next.c];
          if (val !== null && val !== undefined) {
            setDirectInput(scalingFormat(item.scaling, val));
          }
        }
        return;
      }

      // + / = increments selected cells; - decrements selected cells
      if ((e.key === '+' || e.key === '=') && selectedKeys.size > 0 && !isLocked) {
        e.preventDefault();
        handleStep(1);
        return;
      }
      if ((e.key === '-' || e.key === '_') && selectedKeys.size > 0 && !isLocked) {
        e.preventDefault();
        handleStep(-1);
        return;
      }

      // Typing a digit directly starts inline cell editing
      if (/^[0-9.]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && selectedKeys.size > 0 && !isLocked) {
        e.preventDefault();
        setInlineTypingBuffer(e.key);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    kind,
    inlineTypingBuffer,
    isLocked,
    selectedKeys,
    compareBin,
    transposed,
    focusCell,
    anchorCell,
    rows,
    cols,
    buildRectSelection,
    tableData.valGrid,
    item.scaling,
    selectAll,
    handleCopySelection,
    handlePasteFromClipboard,
    handleSetDirect,
    handleStep,
  ]);

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

  const effectiveNote = userNote ?? readStoredNote(item);

  const hasSelection = selectedKeys.size > 0;
  const hasMultiSelection = selectedKeys.size >= 2;
  const canEditSelection = hasSelection && !isLocked;
  const canEditMulti = hasMultiSelection && !isLocked;
  const changedCount = tableData.changedSet.size;
  const outOfRangeCount = tableData.outOfRangeSet.size;
  const hexAddr = fmtHexAddr(item.data.address);
  const badgeLabel =
    categoryName ??
    (kind === 'table'
      ? 'Map Table'
      : kind === 'flag'
        ? 'Flag'
        : kind === 'patch'
          ? 'Patch'
          : 'Constant');

  const toolBtnActive =
    'bg-white/[0.06] text-zinc-200 hover:bg-white/[0.11] hover:text-white cursor-pointer';
  const toolBtnDisabled = 'bg-transparent text-zinc-600 cursor-not-allowed opacity-50';

  // Save Safe Range popover
  const handleSaveSafeRange = () => {
    const minV = safeMinText.trim() ? parseFloat(safeMinText.replace(',', '.')) : undefined;
    const maxV = safeMaxText.trim() ? parseFloat(safeMaxText.replace(',', '.')) : undefined;
    const next =
      minV !== undefined || maxV !== undefined
        ? {
            ...(minV !== undefined && Number.isFinite(minV) ? { min: minV } : {}),
            ...(maxV !== undefined && Number.isFinite(maxV) ? { max: maxV } : {}),
          }
        : undefined;
    if (onUpdateSafeRange) {
      onUpdateSafeRange(next);
    } else {
      setInternalSafeRanges((prev) => {
        const copy = { ...prev };
        if (!next) delete copy[item.id];
        else copy[item.id] = next;
        return copy;
      });
    }
    setOpenMenu(null);
  };

  // Dedicated editors for Constant, Flag, and Patch
  const renderDedicatedEditor = () => {
    // 1. CONSTANT EDITOR
    if (item.itemKind.kind === 'constant') {
      const raw = tableData.rawGrid[0]?.[0] ?? null;
      const val = tableData.valGrid[0]?.[0] ?? null;
      const cmpVal = tableData.cmpValGrid?.[0]?.[0] ?? null;
      const delta = val !== null && cmpVal !== null ? val - cmpVal : null;
      const isOor = tableData.outOfRangeSet.has(cellKey({ r: 0, c: 0 }));
      const eb = elementBytes(item.data);
      const rawHex =
        raw !== null
          ? `0x${((Math.round(raw) >>> 0) & (eb >= 4 ? 0xffffffff : (1 << (eb * 8)) - 1))
              .toString(16)
              .toUpperCase()
              .padStart(eb * 2, '0')}`
          : '—';

      const rawStepVal = scalingRawStep(item.scaling);
      const displayStepVal = unitConv ? rawStepVal * unitConv.deltaScale : rawStepVal;
      const formattedRawStep =
        Math.abs(displayStepVal) > 0 && Math.abs(displayStepVal) < 1
          ? Number(displayStepVal.toPrecision(3)).toString()
          : scalingFormat(item.scaling, displayStepVal);

      const applyConstant = (nextVal: number) => {
        if (isLocked || !Number.isFinite(nextVal)) return;
        commitEngineeringValues(
          new Map([[cellKey({ r: 0, c: 0 }), nextVal]]),
          `Set ${item.title} → ${scalingFormat(item.scaling, nextVal)}`,
        );
      };

      return (
        <div className="flex-1 min-h-0 overflow-y-auto p-6 flex items-start justify-center">
          <div className="w-full max-w-2xl space-y-4">
            <div className="rounded-2xl bg-[#17181d] border border-white/[0.075] p-6 space-y-5 shadow-xl">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                    Scalar Constant Readout
                  </div>
                  <div
                    className={`mt-1 text-4xl font-mono font-bold tabular-nums tracking-tight ${
                      isOor ? 'text-rose-400' : 'text-[#0a84ff]'
                    }`}
                  >
                    {raw !== null && val !== null
                      ? unitConv
                        ? formatDisplayValue(val)
                        : scalingDisplay(item.scaling, raw, item.data)
                      : '—'}
                    {activeUnitLabel && (
                      <span className="ml-2 text-lg font-medium text-zinc-400">
                        {activeUnitLabel}
                      </span>
                    )}
                  </div>
                </div>
                {delta !== null && Math.abs(delta) > 1e-9 && (
                  <span
                    className={`px-2.5 py-1 rounded-full text-xs font-mono font-semibold ${
                      delta > 0
                        ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                        : 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
                    }`}
                  >
                    {delta > 0 ? '+' : ''}
                    {formatDisplayDelta(delta)} vs Compare
                  </span>
                )}
              </div>

              {/* Direct Value Input + Apply + Step */}
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-white/[0.065]">
                <input
                  type="text"
                  disabled={isLocked}
                  value={directInput || (val !== null ? scalingFormat(item.scaling, val) : '')}
                  onChange={(e) => setDirectInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const p = parseFloat(directInput.replace(',', '.'));
                      if (Number.isFinite(p)) applyConstant(p);
                    }
                  }}
                  placeholder="Enter value…"
                  className="flex-1 min-w-[160px] px-3 py-2 rounded-lg bg-[#0f1014] border border-white/[0.08] focus:border-[#0a84ff] focus:outline-none text-sm font-mono tabular-nums text-zinc-100 disabled:opacity-45"
                />
                <button
                  type="button"
                  disabled={isLocked}
                  onClick={() => {
                    const p = parseFloat((directInput || '').replace(',', '.'));
                    if (Number.isFinite(p)) applyConstant(p);
                  }}
                  className="px-4 py-2 rounded-lg text-xs font-semibold bg-[#0a84ff] hover:bg-[#1e8fff] disabled:opacity-40 text-white shadow-[0_1px_8px_rgba(10,132,255,0.4)] transition-colors cursor-pointer"
                >
                  Apply
                </button>
                <div className="inline-flex items-center rounded-lg bg-white/[0.04] border border-white/[0.065] p-0.5 gap-0.5">
                  <button
                    type="button"
                    disabled={isLocked || val === null}
                    onClick={() => val !== null && applyConstant(val - resolvedStep)}
                    className="p-1.5 rounded text-zinc-200 hover:bg-white/[0.09] disabled:opacity-40 cursor-pointer"
                    title={`−${resolvedStep}`}
                  >
                    <Minus className="w-3.5 h-3.5" />
                  </button>
                  <input
                    type="text"
                    value={stepSizeInput}
                    onChange={(e) => setStepSizeInput(e.target.value)}
                    className="w-14 bg-transparent text-center text-xs font-mono text-zinc-200 focus:outline-none"
                    title="Step size"
                  />
                  <button
                    type="button"
                    disabled={isLocked || val === null}
                    onClick={() => val !== null && applyConstant(val + resolvedStep)}
                    className="p-1.5 rounded text-zinc-200 hover:bg-white/[0.09] disabled:opacity-40 cursor-pointer"
                    title={`+${resolvedStep}`}
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Info Cards Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3 space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">Raw Hex / Dec</div>
                <div className="text-xs font-mono font-semibold text-zinc-100">{rawHex}</div>
                <div className="text-[10.5px] font-mono text-zinc-500">
                  {raw !== null ? Math.round(raw) : '—'}
                </div>
              </div>
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3 space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">Compare BIN</div>
                <div className="text-xs font-mono font-semibold text-zinc-100">
                  {cmpVal !== null
                    ? `${formatDisplayValue(cmpVal)}${activeUnitLabel ? ` ${activeUnitLabel}` : ''}`
                    : '—'}
                </div>
                <div className="text-[10.5px] font-mono text-zinc-500">
                  {compareBin ? 'Baseline loaded' : 'No compare BIN'}
                </div>
              </div>
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3 space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">1 Raw Step</div>
                <div className="text-xs font-mono font-semibold text-zinc-100">
                  {formattedRawStep}
                  {activeUnitLabel ? ` ${activeUnitLabel}` : ''}
                </div>
                <div className="text-[10.5px] font-mono text-zinc-500">{layoutTypeDescription(item.data)}</div>
              </div>
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3 space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">Safe Range</div>
                <div
                  className={`text-xs font-mono font-semibold ${
                    isOor ? 'text-rose-400' : 'text-emerald-300'
                  }`}
                >
                  {effectiveSafeRange?.min !== undefined || effectiveSafeRange?.max !== undefined
                    ? `${effectiveSafeRange?.min ?? '−∞'} … ${effectiveSafeRange?.max ?? '+∞'}`
                    : 'Unbounded'}
                </div>
                <div className="text-[10.5px] text-zinc-500">
                  {isOor ? 'Out of bounds!' : 'Within bounds'}
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // 2. FLAG EDITOR
    if (item.itemKind.kind === 'flag') {
      const { mask, invert } = item.itemKind;
      const raw = tableData.rawGrid[0]?.[0] ?? 0;
      const uval = Math.max(0, Math.round(raw)) >>> 0;
      const masked = (uval & (mask >>> 0)) !== 0;
      const isEnabled = invert ? !masked : masked;
      const byteHex = `0x${(uval & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;
      const maskHex = `0x${(mask >>> 0).toString(16).toUpperCase().padStart(2, '0')}`;
      const binStr = (uval & 0xff).toString(2).padStart(8, '0');

      const toggleFlag = () => {
        if (isLocked) return;
        const nextUval = masked ? uval & ~(mask >>> 0) : uval | (mask >>> 0);
        const offset = item.data.address;
        const n = elementBytes(item.data);
        if (offset < 0 || offset + n > bin.length) return;
        const oldBytes = bin.slice(offset, offset + n);
        const nextBytes = BinCodec.encode(item.data, nextUval);
        if (!bytesEqual(oldBytes, nextBytes)) {
          onApplyPatches(
            [{ offset, old: oldBytes, next: nextBytes }],
            `Toggle ${item.title} → ${!isEnabled ? 'ON' : 'OFF'}`,
          );
        }
      };

      return (
        <div className="flex-1 min-h-0 overflow-y-auto p-6 flex items-start justify-center">
          <div className="w-full max-w-2xl space-y-4">
            <div className="rounded-2xl bg-[#17181d] border border-white/[0.075] p-6 space-y-5 shadow-xl">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                    Configuration Flag Switch
                  </div>
                  <div className="text-2xl font-semibold text-zinc-100">
                    {isEnabled ? 'Enabled (Active)' : 'Disabled (Inactive)'}
                  </div>
                  <div className="text-xs font-mono text-zinc-400">
                    Address {hexAddr} · Mask {maskHex} {invert ? '· Inverted Logic' : ''}
                  </div>
                </div>

                {/* Prominent Toggle Switch */}
                <button
                  type="button"
                  disabled={isLocked}
                  onClick={toggleFlag}
                  className={`relative w-16 h-9 rounded-full transition-colors cursor-pointer disabled:opacity-45 ${
                    isEnabled
                      ? 'bg-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.4)]'
                      : 'bg-white/[0.12]'
                  }`}
                  title="Toggle flag bit"
                >
                  <span
                    className={`absolute top-1 w-7 h-7 rounded-full bg-white shadow-md transition-transform ${
                      isEnabled ? 'translate-x-8' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              {/* 8-Bit Binary Readout */}
              <div className="pt-4 border-t border-white/[0.065] space-y-2">
                <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400">
                  <span>8-Bit Register Readout (MSB → LSB)</span>
                  <span>
                    Raw Byte: <strong className="text-zinc-100">{byteHex}</strong> ({binStr}b)
                  </span>
                </div>
                <div className="grid grid-cols-8 gap-1.5">
                  {[7, 6, 5, 4, 3, 2, 1, 0].map((bit) => {
                    const bitSet = ((uval >>> bit) & 1) !== 0;
                    const inMask = ((mask >>> bit) & 1) !== 0;
                    return (
                      <div
                        key={bit}
                        className={`rounded-lg border p-2 text-center font-mono ${
                          inMask
                            ? bitSet
                              ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-200'
                              : 'bg-[#0a84ff]/15 border-[#0a84ff]/45 text-sky-200'
                            : 'bg-[#101115] border-white/[0.06] text-zinc-500'
                        }`}
                      >
                        <div className="text-[9.5px] opacity-70">b{bit}</div>
                        <div className="text-sm font-bold">{bitSet ? '1' : '0'}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // 3. PATCH EDITOR (XDFPATCH)
    if (item.itemKind.kind === 'patch') {
      const entries: XdfPatchEntry[] = item.patchEntries ?? item.itemKind.entries ?? [];

      const entryStates = entries.map((entry, idx) => {
        const len = entry.patchBytes.length;
        const inRange = entry.address >= 0 && entry.address + len <= bin.length;
        const cur = inRange ? bin.slice(entry.address, entry.address + len) : new Uint8Array(0);
        const isApplied =
          inRange && len > 0 && entry.patchBytes.every((b, i) => cur[i] === (b & 0xff));
        const isBase =
          inRange &&
          entry.baseBytes.length === len &&
          entry.baseBytes.every((b, i) => cur[i] === (b & 0xff));
        return { idx, entry, inRange, cur, isApplied, isBase };
      });

      const allApplied = entryStates.length > 0 && entryStates.every((s) => s.isApplied);
      const canRevert = entryStates.some((s) => s.entry.baseBytes.length > 0 && !s.isBase);

      const handleApplyPatchAll = () => {
        if (isLocked) return;
        const patches: Patch[] = [];
        for (const s of entryStates) {
          if (!s.inRange) continue;
          const next = new Uint8Array(s.entry.patchBytes.map((b) => b & 0xff));
          if (!bytesEqual(s.cur, next)) {
            patches.push({ offset: s.entry.address, old: s.cur, next });
          }
        }
        if (patches.length > 0) {
          onApplyPatches(patches, `Apply Patch: ${item.title}`);
        }
      };

      const handleRevertPatchAll = () => {
        if (isLocked) return;
        const patches: Patch[] = [];
        for (const s of entryStates) {
          if (!s.inRange || s.entry.baseBytes.length === 0) continue;
          const next = new Uint8Array(s.entry.baseBytes.map((b) => b & 0xff));
          const old = bin.slice(s.entry.address, s.entry.address + next.length);
          if (!bytesEqual(old, next)) {
            patches.push({ offset: s.entry.address, old, next });
          }
        }
        if (patches.length > 0) {
          onApplyPatches(patches, `Revert Patch: ${item.title}`);
        }
      };

      return (
        <div className="flex-1 min-h-0 overflow-y-auto p-6 flex items-start justify-center">
          <div className="w-full max-w-3xl space-y-4">
            <div className="rounded-2xl bg-[#17181d] border border-white/[0.075] p-5 flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="inline-flex items-center gap-2 text-xs font-semibold text-zinc-200">
                  <Wrench className="w-4 h-4 text-[#0a84ff]" />
                  Binary Code Patch (XDFPATCH)
                </div>
                <div className="text-xs text-zinc-400">
                  {entries.length} patch {entries.length === 1 ? 'entry' : 'entries'} ·{' '}
                  {entryStates.filter((s) => s.isApplied).length} applied
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isLocked || !canRevert}
                  onClick={handleRevertPatchAll}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-40 disabled:cursor-not-allowed text-zinc-200 transition-colors cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Revert to Base
                </button>
                <button
                  type="button"
                  disabled={isLocked || allApplied || entries.length === 0}
                  onClick={handleApplyPatchAll}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-[#0a84ff] hover:bg-[#1e8fff] disabled:opacity-40 disabled:cursor-not-allowed text-white shadow-[0_1px_8px_rgba(10,132,255,0.4)] transition-colors cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" />
                  {allApplied ? 'Patch Applied' : 'Apply Patch'}
                </button>
              </div>
            </div>

            {entries.length === 0 ? (
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-8 text-center text-xs text-zinc-500">
                No patch entries defined. Open Edit XDF to configure patch bytes.
              </div>
            ) : (
              <div className="space-y-2.5">
                {entryStates.map((s) => (
                  <div
                    key={s.idx}
                    className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3.5 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onJumpToHex(s.entry.address)}
                          className="text-xs font-mono font-semibold text-sky-300 hover:underline cursor-pointer"
                        >
                          {fmtHexAddr(s.entry.address)}
                        </button>
                        {s.entry.name && (
                          <span className="text-xs text-zinc-300">{s.entry.name}</span>
                        )}
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                          !s.inRange
                            ? 'bg-rose-500/15 text-rose-300'
                            : s.isApplied
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : s.isBase
                                ? 'bg-white/[0.06] text-zinc-400'
                                : 'bg-amber-500/15 text-amber-300'
                        }`}
                      >
                        {!s.inRange
                          ? 'Out of Bounds'
                          : s.isApplied
                            ? 'Applied'
                            : s.isBase
                              ? 'Base'
                              : 'Modified'}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px] font-mono">
                      <div className="rounded-lg bg-[#101115] border border-white/[0.05] px-2.5 py-1.5">
                        <div className="text-[9.5px] uppercase text-zinc-500">Current BIN</div>
                        <div className="text-zinc-200 break-all">
                          {s.inRange ? bytesToHexStr(s.cur) : '—'}
                        </div>
                      </div>
                      <div className="rounded-lg bg-[#101115] border border-white/[0.05] px-2.5 py-1.5">
                        <div className="text-[9.5px] uppercase text-zinc-500">Base Bytes</div>
                        <div className="text-zinc-400 break-all">
                          {s.entry.baseBytes.length > 0 ? bytesToHexStr(s.entry.baseBytes) : '—'}
                        </div>
                      </div>
                      <div className="rounded-lg bg-[#101115] border border-white/[0.05] px-2.5 py-1.5">
                        <div className="text-[9.5px] uppercase text-zinc-500">Patch Bytes</div>
                        <div className="text-sky-300 break-all">
                          {bytesToHexStr(s.entry.patchBytes)}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }

    return null;
  };

  // Grid display orientation (supports Transposed mode)
  const displayRowCount = transposed ? cols : rows;
  const displayColCount = transposed ? rows : cols;
  const displayXLabels = transposed ? yLabels : xLabels;
  const displayYLabels = transposed ? xLabels : yLabels;
  const canEditDisplayX = transposed ? hasEditableY : hasEditableX;
  const canEditDisplayY = transposed ? hasEditableX : hasEditableY;
  const rescaleTargetSiblingsCount =
    rescaleAxisTarget === 'x' ? sharedAxisInfo.xSiblings.length : sharedAxisInfo.ySiblings.length;

  return (
    <div className="flex flex-col h-full w-full bg-[#0c0d10] text-zinc-100 overflow-hidden">
      {/* Top Header */}
      <div
        ref={headerRef}
        className="relative z-40 shrink-0 px-4 py-2.5 border-b border-white/[0.065] bg-[#121317]/90 backdrop-blur-xl space-y-1.5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="min-w-0 flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Favorite Star (Cmd+D) */}
              <button
                type="button"
                onClick={handleToggleFavorite}
                className={`p-1 rounded-md transition-colors cursor-pointer ${
                  isFavorite
                    ? 'text-amber-400 bg-amber-500/15 hover:bg-amber-500/25'
                    : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06]'
                }`}
                title={isFavorite ? 'Remove from Favorites (⌘D)' : 'Add to Favorites (⌘D)'}
              >
                <Star className={`w-3.5 h-3.5 ${isFavorite ? 'fill-amber-400' : ''}`} />
              </button>

              <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider bg-white/[0.06] text-zinc-400">
                {badgeLabel}
              </span>
              <h1 className="text-[15px] font-semibold tracking-[-0.015em] text-zinc-100 truncate">
                {item.title}
              </h1>

              {/* Auto-Align Confidence Badge */}
              {item.alignConfidence !== undefined && (
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] font-mono font-semibold ${
                    item.alignConfidence >= 0.85
                      ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                      : item.alignConfidence >= 0.65
                        ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                        : 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                  }`}
                  title="Auto-Align correlation confidence"
                >
                  {Math.round(
                    item.alignConfidence <= 1 ? item.alignConfidence * 100 : item.alignConfidence,
                  )}
                  % aligned
                </span>
              )}

              {isLocked && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-semibold bg-amber-500/15 border border-amber-500/30 text-amber-300">
                  <Lock className="w-3 h-3" />
                  Locked
                </span>
              )}

              {/* Out-of-Range Red Warning Pill */}
              {outOfRangeCount > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setSafeMinText(
                      effectiveSafeRange?.min !== undefined ? String(effectiveSafeRange.min) : '',
                    );
                    setSafeMaxText(
                      effectiveSafeRange?.max !== undefined ? String(effectiveSafeRange.max) : '',
                    );
                    setOpenMenu((m) => (m === 'safeRange' ? null : 'safeRange'));
                  }}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-semibold bg-rose-500/20 border border-rose-500/40 text-rose-300 hover:bg-rose-500/30 cursor-pointer"
                  title="Click to configure Safe Range bounds"
                >
                  <ShieldAlert className="w-3 h-3" />
                  {outOfRangeCount} out of range
                </button>
              )}

              {/* Shared Axis (COM_AXIS) Orange Warning Pill */}
              {sharedAxisInfo.allSiblings.length > 0 && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setOpenMenu((m) => (m === 'sharedAxis' ? null : 'sharedAxis'))}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-semibold bg-orange-500/15 border border-orange-500/35 text-orange-300 hover:bg-orange-500/25 cursor-pointer"
                    title="This map shares an axis (COM_AXIS) with other maps"
                  >
                    <AlertTriangle className="w-3 h-3" />
                    Shared Axis ({sharedAxisInfo.allSiblings.length})
                  </button>
                  {openMenu === 'sharedAxis' && (
                    <div className="absolute left-0 top-full mt-1.5 z-40 w-64 rounded-xl glass-popover p-2.5 space-y-1.5">
                      <div className="text-[10.5px] font-semibold text-orange-300">
                        Shared Axis Maps (COM_AXIS)
                      </div>
                      <div className="text-[10px] text-zinc-400">
                        Editing axis breakpoints will affect these sibling maps:
                      </div>
                      <div className="max-h-44 overflow-y-auto space-y-1 pt-1">
                        {sharedAxisInfo.allSiblings.map((sib) => (
                          <button
                            key={sib.id}
                            type="button"
                            onClick={() => {
                              onSelectMap?.(sib.id);
                              setOpenMenu(null);
                            }}
                            className="w-full text-left px-2 py-1 rounded-md bg-white/[0.04] hover:bg-white/[0.1] text-[11px] text-zinc-200 truncate cursor-pointer"
                          >
                            {sib.title}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Non-Monotonic Axis Warning Badge */}
              {kind === 'table' && (!xMonotonic || !yMonotonic) && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-semibold bg-amber-500/15 border border-amber-500/35 text-amber-300"
                  title="One or more axes are non-monotonic (reversals or duplicate breakpoints)"
                >
                  <AlertTriangle className="w-3 h-3" />
                  Non-Monotonic {!xMonotonic && !yMonotonic ? 'X & Y' : !xMonotonic ? 'X' : 'Y'}
                </span>
              )}

              {/* Expandable Description & User Note Badges */}
              {item.description && (
                <button
                  type="button"
                  onClick={() => setDescExpanded((v) => !v)}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] transition-colors cursor-pointer ${
                    descExpanded
                      ? 'bg-white/[0.12] text-zinc-100'
                      : 'bg-white/[0.04] text-zinc-400 hover:text-zinc-200'
                  }`}
                  title="Toggle map description"
                >
                  <Info className="w-3 h-3" />
                  Desc
                </button>
              )}
              {effectiveNote && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] bg-sky-500/12 text-sky-300 border border-sky-500/25 max-w-[180px] truncate"
                  title={effectiveNote}
                >
                  <StickyNote className="w-3 h-3 shrink-0" />
                  <span className="truncate">{effectiveNote}</span>
                </span>
              )}

              {compareBin && kind === 'table' && (
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
              {activeUnitLabel && (
                <>
                  <span className="text-zinc-700">·</span>
                  <span className="text-zinc-300">{activeUnitLabel}</span>
                </>
              )}
              {item.scaling.equation && item.scaling.equation !== 'X' && (
                <>
                  <span className="text-zinc-700">·</span>
                  <span className="text-zinc-500 truncate max-w-[240px]" title={item.scaling.equation}>
                    f(X) = {item.scaling.equation}
                  </span>
                </>
              )}
            </div>

            {descExpanded && item.description && (
              <div className="mt-1 rounded-lg bg-[#0f1014] border border-white/[0.06] px-2.5 py-1.5 text-[11px] text-zinc-300 leading-relaxed">
                {item.description}
              </div>
            )}
          </div>

          {/* Right Action Buttons */}
          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
            {/* Safe Range Popover */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  if (openMenu === 'safeRange') {
                    setOpenMenu(null);
                  } else {
                    setSafeMinText(
                      effectiveSafeRange?.min !== undefined ? String(effectiveSafeRange.min) : '',
                    );
                    setSafeMaxText(
                      effectiveSafeRange?.max !== undefined ? String(effectiveSafeRange.max) : '',
                    );
                    setOpenMenu('safeRange');
                  }
                }}
                className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  outOfRangeCount > 0
                    ? 'bg-rose-500/15 border border-rose-500/35 text-rose-300'
                    : effectiveSafeRange?.min !== undefined || effectiveSafeRange?.max !== undefined
                      ? 'bg-emerald-500/12 border border-emerald-500/30 text-emerald-300'
                      : 'bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200'
                }`}
                title="Configure Safe Range min/max bounds"
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                Limits
              </button>
              {openMenu === 'safeRange' && (
                <div className="absolute right-0 top-full mt-1.5 z-40 w-64 rounded-xl glass-popover p-3 space-y-2.5">
                  <div className="text-[11px] font-semibold text-zinc-100">
                    Safe Range Guardrails
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="block text-[10px] uppercase text-zinc-500">Min</span>
                      <input
                        type="text"
                        value={safeMinText}
                        onChange={(e) => setSafeMinText(e.target.value)}
                        placeholder="None"
                        className="w-full px-2 py-1 rounded-lg bg-[#101115] border border-white/[0.08] focus:border-[#0a84ff] focus:outline-none text-xs font-mono text-zinc-100"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="block text-[10px] uppercase text-zinc-500">Max</span>
                      <input
                        type="text"
                        value={safeMaxText}
                        onChange={(e) => setSafeMaxText(e.target.value)}
                        placeholder="None"
                        className="w-full px-2 py-1 rounded-lg bg-[#101115] border border-white/[0.08] focus:border-[#0a84ff] focus:outline-none text-xs font-mono text-zinc-100"
                      />
                    </label>
                  </div>
                  <div className="flex items-center justify-between pt-1 border-t border-white/[0.065]">
                    <button
                      type="button"
                      onClick={() => {
                        setSafeMinText('');
                        setSafeMaxText('');
                        if (onUpdateSafeRange) onUpdateSafeRange(undefined);
                        else
                          setInternalSafeRanges((prev) => {
                            const copy = { ...prev };
                            delete copy[item.id];
                            return copy;
                          });
                        setOpenMenu(null);
                      }}
                      className="text-[11px] text-zinc-400 hover:text-zinc-200 cursor-pointer"
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveSafeRange}
                      className="px-3 py-1 rounded-lg text-xs font-medium bg-[#0a84ff] hover:bg-[#1e8fff] text-white cursor-pointer"
                    >
                      Apply
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Pin for Split + Mirror Edits */}
            {onTogglePin && (
              <button
                type="button"
                onClick={onTogglePin}
                className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  isPinned
                    ? 'bg-[#0a84ff]/20 border border-[#0a84ff]/40 text-sky-300'
                    : 'bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200'
                }`}
                title="Pin map for side-by-side split editing"
              >
                <Pin className="w-3.5 h-3.5" />
                {isPinned ? 'Pinned' : 'Pin'}
              </button>
            )}
            {(isPinned || splitPinnedActive) && onToggleMirrorPinned && (
              <button
                type="button"
                onClick={onToggleMirrorPinned}
                className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  mirrorPinnedEdits
                    ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-300'
                    : 'bg-white/[0.05] hover:bg-white/[0.1] text-zinc-300'
                }`}
                title="Mirror edits live to pinned split map"
              >
                <Link2 className="w-3.5 h-3.5" />
                Mirror Edits
              </button>
            )}

            {/* Copy From… Dropdown */}
            {kind === 'table' && (compareBin || otherOpenBins.length > 0 || sameDimMaps.length > 0) && (
              <div className="relative">
                <button
                  type="button"
                  disabled={isLocked}
                  onClick={() => setOpenMenu((m) => (m === 'copyFrom' ? null : 'copyFrom'))}
                  className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    isLocked
                      ? 'bg-white/[0.03] text-zinc-600 cursor-not-allowed'
                      : 'bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200 cursor-pointer'
                  }`}
                  title="Copy map values from Compare BIN, another open BIN, or a same-dimension XDF map"
                >
                  <Copy className="w-3.5 h-3.5 text-zinc-400" />
                  Copy From
                  <ChevronDown className="w-3 h-3 opacity-60" />
                </button>
                {openMenu === 'copyFrom' && (
                  <div className="absolute right-0 top-full mt-1.5 z-[70] w-60 rounded-xl glass-popover py-1.5 text-xs">
                    {compareBin && (
                      <button
                        type="button"
                        onClick={() => handleCopyFromSource({ kind: 'compare' })}
                        className="w-full text-left px-3 py-1.5 text-amber-300 hover:bg-white/[0.08] cursor-pointer"
                      >
                        Comparison BIN (Baseline)
                      </button>
                    )}
                    {otherOpenBins.length > 0 && (
                      <>
                        <div className="px-3 pt-1.5 pb-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-zinc-500">
                          Open BINs
                        </div>
                        {otherOpenBins.map((ob) => (
                          <button
                            key={ob.id}
                            type="button"
                            onClick={() => handleCopyFromSource({ kind: 'bin', id: ob.id })}
                            className="w-full text-left px-3 py-1.5 text-zinc-200 hover:bg-white/[0.08] truncate cursor-pointer"
                          >
                            {ob.name}
                          </button>
                        ))}
                      </>
                    )}
                    {sameDimMaps.length > 0 && (
                      <>
                        <div className="px-3 pt-1.5 pb-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-zinc-500">
                          Same-Size Maps ({rows}×{cols})
                        </div>
                        <div className="max-h-40 overflow-y-auto">
                          {sameDimMaps.slice(0, 15).map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => handleCopyFromSource({ kind: 'map', id: m.id })}
                              className="w-full text-left px-3 py-1.5 text-zinc-200 hover:bg-white/[0.08] truncate cursor-pointer"
                            >
                              {m.title}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

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

        {/* Sync-Block Twin Maps Bar */}
        {syncBlockInfo && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-[#0a84ff]/10 border border-[#0a84ff]/25 text-[11px]">
            <div className="flex items-center gap-2 min-w-0">
              <span className="inline-flex items-center gap-1 font-semibold text-sky-300 shrink-0">
                <Link2 className="w-3.5 h-3.5" />
                Sync-Block ({syncBlockInfo.currentIndex + 1}/{syncBlockInfo.members.length})
              </span>
              <div className="inline-flex items-center rounded bg-white/[0.06]">
                <button
                  type="button"
                  onClick={() => {
                    const prevIdx =
                      (syncBlockInfo.currentIndex - 1 + syncBlockInfo.members.length) %
                      syncBlockInfo.members.length;
                    onSelectMap?.(syncBlockInfo.members[prevIdx].id);
                  }}
                  className="p-0.5 text-zinc-300 hover:text-white cursor-pointer"
                  title="Previous twin map"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const nextIdx = (syncBlockInfo.currentIndex + 1) % syncBlockInfo.members.length;
                    onSelectMap?.(syncBlockInfo.members[nextIdx].id);
                  }}
                  className="p-0.5 text-zinc-300 hover:text-white cursor-pointer"
                  title="Next twin map"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex items-center gap-1 overflow-x-auto">
                {syncBlockInfo.members.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => onSelectMap?.(m.id)}
                    className={`px-2 py-0.5 rounded text-[10.5px] truncate max-w-[160px] transition-colors cursor-pointer ${
                      m.id === item.id
                        ? 'bg-[#0a84ff] text-white font-medium'
                        : 'bg-white/[0.06] text-zinc-300 hover:bg-white/[0.12]'
                    }`}
                  >
                    {m.title}
                  </button>
                ))}
              </div>
            </div>

            <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-sky-200 cursor-pointer select-none shrink-0">
              <input
                type="checkbox"
                checked={syncBlockEdits}
                onChange={(e) => setSyncBlockEdits(e.target.checked)}
                className="rounded accent-[#0a84ff]"
              />
              Sync Edits
            </label>
          </div>
        )}
      </div>

      {/* Dedicated Editor for Constant / Flag / Patch */}
      {kind !== 'table' ? (
        renderDedicatedEditor()
      ) : (
        <>
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
                value={inlineTypingBuffer !== null ? inlineTypingBuffer : directInput}
                onChange={(e) => {
                  setInlineTypingBuffer(null);
                  setDirectInput(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isLocked) handleSetDirect();
                }}
                placeholder={isLocked ? 'Locked' : 'Value'}
                className={`w-20 px-2 py-1 rounded-md bg-[#17181d] border focus:border-[#0a84ff] focus:outline-none disabled:opacity-45 disabled:cursor-not-allowed text-xs font-mono tabular-nums text-zinc-100 placeholder:text-zinc-600 transition-colors ${
                  inlineTypingBuffer !== null ? 'border-[#0a84ff] ring-1 ring-[#0a84ff]/50' : 'border-white/[0.065]'
                }`}
              />
              <button
                type="button"
                disabled={!canEditSelection}
                onClick={() => handleSetDirect()}
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

            {/* Step - / Custom Step Input / + */}
            <div className="flex items-center rounded-md bg-white/[0.04] p-0.5 gap-0.5">
              <button
                type="button"
                disabled={!canEditSelection}
                onClick={() => handleStep(-1)}
                className={`p-1 rounded transition-colors ${
                  canEditSelection
                    ? 'text-zinc-200 hover:bg-white/[0.09] hover:text-white cursor-pointer'
                    : 'text-zinc-600 cursor-not-allowed'
                }`}
                title={`Decrement by ${resolvedStep} (−)`}
              >
                <Minus className="w-3.5 h-3.5" />
              </button>
              <input
                type="text"
                disabled={isLocked}
                value={stepSizeInput}
                onChange={(e) => setStepSizeInput(e.target.value)}
                className="w-12 px-1 py-0.5 rounded bg-[#17181d] border border-white/[0.06] focus:border-[#0a84ff] focus:outline-none text-[11px] font-mono tabular-nums text-center text-zinc-200"
                title="Custom step size"
              />
              <button
                type="button"
                disabled={!canEditSelection}
                onClick={() => handleStep(1)}
                className={`p-1 rounded transition-colors ${
                  canEditSelection
                    ? 'text-zinc-200 hover:bg-white/[0.09] hover:text-white cursor-pointer'
                    : 'text-zinc-600 cursor-not-allowed'
                }`}
                title={`Increment by ${resolvedStep} (+)`}
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
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
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
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
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
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                  openMenu === 'interpolate'
                    ? 'bg-white/[0.12] text-white cursor-pointer'
                    : canEditMulti
                      ? toolBtnActive
                      : toolBtnDisabled
                }`}
              >
                <Spline className="w-3.5 h-3.5" />
                Interp
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

            {/* Fill Dropdown (Directional + Average + Flatten + Clamp) */}
            <div className="relative">
              <button
                type="button"
                disabled={!canEditSelection}
                onClick={() => setOpenMenu((m) => (m === 'fill' ? null : 'fill'))}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                  openMenu === 'fill'
                    ? 'bg-white/[0.12] text-white cursor-pointer'
                    : canEditSelection
                      ? toolBtnActive
                      : toolBtnDisabled
                }`}
              >
                <ArrowDownToLine className="w-3.5 h-3.5" />
                Fill
                <ChevronDown className="w-3 h-3 opacity-60" />
              </button>
              {openMenu === 'fill' && (
                <div className="absolute left-0 top-full mt-1.5 z-30 w-56 rounded-xl glass-popover py-1.5 space-y-1">
                  <div className="grid grid-cols-2 gap-1 px-2">
                    {(
                      [
                        ['down', 'Down ↓'],
                        ['up', 'Up ↑'],
                        ['right', 'Right →'],
                        ['left', 'Left ←'],
                      ] as const
                    ).map(([dir, label]) => (
                      <button
                        key={dir}
                        type="button"
                        disabled={!canEditMulti}
                        onClick={() => handleFill(dir)}
                        className="px-2 py-1 rounded-md text-xs text-zinc-200 bg-white/[0.04] hover:bg-white/[0.1] disabled:opacity-40 cursor-pointer"
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    disabled={!canEditMulti}
                    onClick={handleFillAverage}
                    className="w-full text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/[0.08] disabled:opacity-40 cursor-pointer"
                  >
                    Set to Average
                  </button>

                  {/* Flatten to Value */}
                  <div className="px-2.5 pt-1.5 border-t border-white/[0.065] space-y-1">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                      Flatten to Value
                    </div>
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={flattenValText}
                        onChange={(e) => setFlattenValText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleFlatten();
                        }}
                        placeholder="Target…"
                        className="flex-1 min-w-0 px-2 py-1 rounded bg-[#101115] border border-white/[0.08] text-xs font-mono text-zinc-100 focus:border-[#0a84ff] focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={handleFlatten}
                        className="px-2 py-1 rounded bg-[#0a84ff] hover:bg-[#1e8fff] text-[11px] font-medium text-white cursor-pointer"
                      >
                        Go
                      </button>
                    </div>
                  </div>

                  {/* Clamp Min / Max */}
                  <div className="px-2.5 pt-1.5 border-t border-white/[0.065] space-y-1">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                      Clamp (Min / Max)
                    </div>
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={clampMinText}
                        onChange={(e) => setClampMinText(e.target.value)}
                        placeholder="Min"
                        className="w-16 px-1.5 py-1 rounded bg-[#101115] border border-white/[0.08] text-xs font-mono text-zinc-100 focus:border-[#0a84ff] focus:outline-none"
                      />
                      <input
                        type="text"
                        value={clampMaxText}
                        onChange={(e) => setClampMaxText(e.target.value)}
                        placeholder="Max"
                        className="w-16 px-1.5 py-1 rounded bg-[#101115] border border-white/[0.08] text-xs font-mono text-zinc-100 focus:border-[#0a84ff] focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={handleClamp}
                        className="flex-1 px-2 py-1 rounded bg-[#0a84ff] hover:bg-[#1e8fff] text-[11px] font-medium text-white cursor-pointer"
                      >
                        Clamp
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Rescale Axis Popover */}
            <div className="relative">
              <button
                type="button"
                disabled={!canRescaleAxis || isLocked}
                onClick={handleToggleRescale}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                  openMenu === 'rescale'
                    ? 'bg-[#0a84ff] text-white cursor-pointer'
                    : canRescaleAxis && !isLocked
                      ? toolBtnActive
                      : toolBtnDisabled
                }`}
                title="Rescale X or Y axis breakpoints and optionally resample map values"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                Rescale
              </button>

              {openMenu === 'rescale' && (
                <div className="absolute left-0 top-full mt-1.5 z-30 w-76 rounded-xl glass-popover p-3 space-y-2.5">
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

                  <div className="space-y-1.5">
                    <label className="flex items-center gap-2 text-[11px] text-zinc-300 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={rescaleInterpolate}
                        onChange={(e) => setRescaleInterpolate(e.target.checked)}
                        className="rounded accent-[#0a84ff]"
                      />
                      <span>Resample map values to preserve shape</span>
                    </label>

                    {rescaleInterpolate && (
                      <label className="flex items-center gap-2 text-[11px] text-zinc-300 cursor-pointer select-none pl-4">
                        <input
                          type="checkbox"
                          checked={rescaleExtrapolate}
                          onChange={(e) => setRescaleExtrapolate(e.target.checked)}
                          className="rounded accent-[#0a84ff]"
                        />
                        <span>Extrapolate boundary values</span>
                      </label>
                    )}

                    {rescaleTargetSiblingsCount > 0 && rescaleInterpolate && (
                      <label className="flex items-center gap-2 text-[11px] text-orange-300 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={rescaleCascadeShared}
                          onChange={(e) => setRescaleCascadeShared(e.target.checked)}
                          className="rounded accent-orange-400"
                        />
                        <span>
                          Cascade to {rescaleTargetSiblingsCount} shared-axis{' '}
                          {rescaleTargetSiblingsCount === 1 ? 'map' : 'maps'}
                        </span>
                      </label>
                    )}
                  </div>

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

            {/* Inline Edit Axes Toggle */}
            {canRescaleAxis && !isLocked && (
              <button
                type="button"
                onClick={() => {
                  setEditAxesMode((v) => !v);
                  setEditingAxisCell(null);
                }}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  editAxesMode
                    ? 'bg-[#0a84ff] text-white shadow-[0_1px_6px_rgba(10,132,255,0.35)]'
                    : toolBtnActive
                }`}
                title="Click any X/Y axis header cell to edit its breakpoint value inline"
              >
                <Edit3 className="w-3.5 h-3.5" />
                Axes
              </button>
            )}

            {/* Actions Menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setOpenMenu((m) => (m === 'actions' ? null : 'actions'))}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  openMenu === 'actions' ? 'bg-white/[0.12] text-white' : toolBtnActive
                }`}
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
                Actions
              </button>
              {openMenu === 'actions' && (
                <div className="absolute left-0 top-full mt-1.5 z-30 w-48 rounded-xl glass-popover py-1 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      selectAll();
                      setOpenMenu(null);
                    }}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-zinc-200 hover:bg-white/[0.08] cursor-pointer"
                  >
                    <span>Select All</span>
                    <span className="text-[10px] font-mono text-zinc-500">⌘A</span>
                  </button>
                  <button
                    type="button"
                    disabled={!compareBin || changedCount === 0}
                    onClick={selectChangedCells}
                    className="w-full text-left px-3 py-1.5 text-zinc-200 hover:bg-white/[0.08] disabled:opacity-40 cursor-pointer"
                  >
                    Select Changed Cells ({changedCount})
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCopySelection(true)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-zinc-200 hover:bg-white/[0.08] cursor-pointer"
                  >
                    <ClipboardCopy className="w-3.5 h-3.5 text-zinc-400" />
                    Copy with Axes (TSV)
                  </button>
                </div>
              )}
            </div>

            {/* Right-aligned layout & pane toggles */}
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => setTransposed((v) => !v)}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                  transposed
                    ? 'bg-[#0a84ff]/20 text-sky-300'
                    : 'bg-white/[0.04] text-zinc-400 hover:text-zinc-200'
                }`}
                title="Transpose rows & columns"
              >
                <ArrowLeftRight className="w-3 h-3" />
                T
              </button>
              <button
                type="button"
                onClick={() => setShow3D((v) => !v)}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                  show3D
                    ? 'bg-white/[0.1] text-zinc-100'
                    : 'bg-white/[0.03] text-zinc-500 hover:text-zinc-300'
                }`}
                title="Toggle 3D Surface pane"
              >
                <Box className="w-3 h-3" />
                3D
              </button>
              <button
                type="button"
                onClick={() => setShow2D((v) => !v)}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                  show2D
                    ? 'bg-white/[0.1] text-zinc-100'
                    : 'bg-white/[0.03] text-zinc-500 hover:text-zinc-300'
                }`}
                title="Toggle 2D Curves pane"
              >
                <Activity className="w-3 h-3" />
                2D
              </button>
              <span className="ml-1.5 text-[11px] font-mono tabular-nums text-zinc-500">
                {hasSelection ? (
                  <span className="text-zinc-300">
                    {selectedKeys.size} {selectedKeys.size === 1 ? 'cell' : 'cells'}
                  </span>
                ) : (
                  '0 sel'
                )}
              </span>
            </div>
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

            {inlineTypingBuffer !== null && (
              <span className="px-2 py-0.5 rounded-md bg-[#0a84ff]/20 border border-[#0a84ff]/40 text-[11px] font-mono text-sky-200">
                Typing: <strong>{inlineTypingBuffer}</strong> · Enter to commit · Esc to cancel
              </span>
            )}

            {/* Min / Max / Avg Summary */}
            <div className="flex items-center gap-3.5 text-[11px] font-mono tabular-nums text-zinc-500">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                {stats.scoped ? 'Selection' : 'Table'}
              </span>
              <span>
                min{' '}
                <strong className="text-zinc-200 font-semibold">
                  {stats.min !== null
                    ? viewMode === 'deltaPct'
                      ? scalingFormat(item.scaling, stats.min)
                      : viewMode === 'delta'
                        ? formatDisplayDelta(stats.min)
                        : formatDisplayValue(stats.min)
                    : '—'}
                  {viewMode === 'deltaPct' && stats.min !== null ? '%' : ''}
                </strong>
              </span>
              <span>
                max{' '}
                <strong className="text-zinc-200 font-semibold">
                  {stats.max !== null
                    ? viewMode === 'deltaPct'
                      ? scalingFormat(item.scaling, stats.max)
                      : viewMode === 'delta'
                        ? formatDisplayDelta(stats.max)
                        : formatDisplayValue(stats.max)
                    : '—'}
                  {viewMode === 'deltaPct' && stats.max !== null ? '%' : ''}
                </strong>
              </span>
              <span>
                avg{' '}
                <strong className="text-zinc-100 font-semibold">
                  {stats.avg !== null
                    ? viewMode === 'deltaPct'
                      ? scalingFormat(item.scaling, stats.avg)
                      : viewMode === 'delta'
                        ? formatDisplayDelta(stats.avg)
                        : formatDisplayValue(stats.avg)
                    : '—'}
                  {viewMode === 'deltaPct' && stats.avg !== null ? '%' : ''}
                </strong>
              </span>
            </div>
          </div>

          {/* Main Body: Iconic Jewel-Tile Thermal Heatmap + Bottom Split Visualizations */}
          <div className="flex-1 min-h-0 flex flex-col gap-3 p-3 overflow-hidden">
            {/* Jewel-Tile Thermal Heatmap Container */}
            <div
              className={`${
                show2D || show3D ? 'flex-[1.15] min-h-[180px]' : 'flex-1'
              } rounded-xl bg-[#121317] border border-white/[0.065] p-2 overflow-auto select-none`}
              onMouseLeave={() => setHoveredCell(null)}
            >
              <table className="border-separate border-spacing-[2.5px] w-max min-w-full text-[11px] font-mono tabular-nums">
                <thead className="sticky top-0 z-20">
                  <tr>
                    <th
                      onClick={selectAll}
                      className="sticky left-0 z-30 px-2.5 py-1.5 bg-[#121317] rounded-[5px] text-[10px] font-semibold text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] cursor-pointer text-center min-w-[54px] transition-colors"
                      title="Select all cells (⌘A)"
                    >
                      {transposed ? 'X \\ Y' : 'Y \\ X'}
                    </th>
                    {displayXLabels.map((lbl, dc) => {
                      const realAxis: 'x' | 'y' = transposed ? 'y' : 'x';
                      const isEditingThis =
                        editingAxisCell?.axis === realAxis && editingAxisCell.idx === dc;
                      const isHoveredCol = transposed
                        ? hoveredCell?.r === dc
                        : hoveredCell?.c === dc;
                      return (
                        <th
                          key={dc}
                          onClick={() => {
                            if (editAxesMode && canEditDisplayX && !isLocked) {
                              setEditingAxisCell({ axis: realAxis, idx: dc, text: lbl });
                            } else if (transposed) {
                              selectRow(dc);
                            } else {
                              selectCol(dc);
                            }
                          }}
                          className={`px-2 py-1.5 rounded-[5px] font-medium cursor-pointer transition-colors min-w-[56px] text-right ${
                            editAxesMode && canEditDisplayX
                              ? 'bg-[#0a84ff]/15 text-sky-200 ring-1 ring-[#0a84ff]/35'
                              : isHoveredCol
                                ? 'bg-white/[0.09] text-white'
                                : 'bg-[#121317] text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.05]'
                          }`}
                          title={
                            editAxesMode && canEditDisplayX
                              ? `Click to edit breakpoint ${lbl}`
                              : `Select column ${lbl}`
                          }
                        >
                          {isEditingThis ? (
                            <input
                              type="text"
                              autoFocus
                              value={editingAxisCell.text}
                              onChange={(e) =>
                                setEditingAxisCell({ ...editingAxisCell, text: e.target.value })
                              }
                              onBlur={() =>
                                handleCommitAxisBreakpoint(realAxis, dc, editingAxisCell.text)
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  handleCommitAxisBreakpoint(realAxis, dc, editingAxisCell.text);
                                } else if (e.key === 'Escape') {
                                  setEditingAxisCell(null);
                                }
                              }}
                              onClick={(e) => e.stopPropagation()}
                              className="w-14 px-1 py-0 rounded bg-[#0c0d10] border border-[#0a84ff] text-right text-[11px] font-mono text-white focus:outline-none"
                            />
                          ) : (
                            lbl
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: displayRowCount }, (_, dr) => {
                    const realAxisY: 'x' | 'y' = transposed ? 'x' : 'y';
                    const yLbl = displayYLabels[dr] ?? String(dr);
                    const isEditingY =
                      editingAxisCell?.axis === realAxisY && editingAxisCell.idx === dr;
                    const isHoveredRow = transposed
                      ? hoveredCell?.c === dr
                      : hoveredCell?.r === dr;

                    return (
                      <tr key={dr}>
                        <th
                          onClick={() => {
                            if (editAxesMode && canEditDisplayY && !isLocked) {
                              setEditingAxisCell({ axis: realAxisY, idx: dr, text: yLbl });
                            } else if (transposed) {
                              selectCol(dr);
                            } else {
                              selectRow(dr);
                            }
                          }}
                          className={`sticky left-0 z-10 px-2.5 py-1 rounded-[5px] font-medium cursor-pointer transition-colors text-right ${
                            editAxesMode && canEditDisplayY
                              ? 'bg-[#0a84ff]/15 text-sky-200 ring-1 ring-[#0a84ff]/35'
                              : isHoveredRow
                                ? 'bg-white/[0.09] text-white'
                                : 'bg-[#121317] text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.05]'
                          }`}
                          title={
                            editAxesMode && canEditDisplayY
                              ? `Click to edit breakpoint ${yLbl}`
                              : `Select row ${yLbl}`
                          }
                        >
                          {isEditingY ? (
                            <input
                              type="text"
                              autoFocus
                              value={editingAxisCell.text}
                              onChange={(e) =>
                                setEditingAxisCell({ ...editingAxisCell, text: e.target.value })
                              }
                              onBlur={() =>
                                handleCommitAxisBreakpoint(realAxisY, dr, editingAxisCell.text)
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  handleCommitAxisBreakpoint(realAxisY, dr, editingAxisCell.text);
                                } else if (e.key === 'Escape') {
                                  setEditingAxisCell(null);
                                }
                              }}
                              onClick={(e) => e.stopPropagation()}
                              className="w-14 px-1 py-0 rounded bg-[#0c0d10] border border-[#0a84ff] text-right text-[11px] font-mono text-white focus:outline-none"
                            />
                          ) : (
                            yLbl
                          )}
                        </th>
                        {Array.from({ length: displayColCount }, (_, dc) => {
                          const r = transposed ? dc : dr;
                          const c = transposed ? dr : dc;
                          const cell: Cell = { r, c };
                          const key = cellKey(cell);
                          const isSelected = selectedKeys.has(key);
                          const isHovered = hoveredCell?.r === r && hoveredCell?.c === c;
                          const isChanged = tableData.changedSet.has(key);
                          const isOor = tableData.outOfRangeSet.has(key);
                          const isDatalogActive =
                            datalogActiveCell !== null &&
                            datalogActiveCell.r === r &&
                            datalogActiveCell.c === c;
                          const hitCount = getDatalogHitCount(key);

                          const raw = tableData.rawGrid[r]?.[c] ?? null;
                          const val = tableData.valGrid[r]?.[c] ?? null;
                          const craw = tableData.cmpRawGrid?.[r]?.[c] ?? null;
                          const cval = tableData.cmpValGrid?.[r]?.[c] ?? null;

                          let displayText = '—';
                          let bg = '#1a1b20';
                          let textColor: string | undefined;
                          let isMutedZero = false;
                          let isColoredTile = false;

                          if (viewMode === 'bin') {
                            if (raw !== null && val !== null) {
                              displayText = unitConv
                                ? formatDisplayValue(val)
                                : scalingDisplay(item.scaling, raw, item.data);
                              const span = tableData.maxVal - tableData.minVal;
                              const t = span > 1e-12 ? (val - tableData.minVal) / span : 0.5;
                              const colors = getHeatmapCellColors(t, heatmapPalette);
                              bg = colors.bg;
                              textColor = colors.text;
                              isColoredTile = true;
                            }
                          } else if (viewMode === 'compare') {
                            if (craw !== null && cval !== null) {
                              displayText = unitConv
                                ? formatDisplayValue(cval)
                                : scalingDisplay(item.scaling, craw, item.data);
                              const span = tableData.maxCmp - tableData.minCmp;
                              const t = span > 1e-12 ? (cval - tableData.minCmp) / span : 0.5;
                              const colors = getHeatmapCellColors(t, heatmapPalette);
                              bg = colors.bg;
                              textColor = colors.text;
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
                                displayText = `${d > 0 ? '+' : ''}${formatDisplayDelta(d)}`;
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
                            ...(textColor ? { color: textColor } : {}),
                            ...(isColoredTile
                              ? {
                                  boxShadow: isSelected
                                    ? undefined
                                    : 'inset 0 1px 0 rgba(255, 255, 255, 0.14)',
                                }
                              : {}),
                          };

                          return (
                            <td
                              key={dc}
                              onMouseDown={(e) => handleCellMouseDown(cell, e)}
                              onMouseEnter={() => handleCellMouseEnter(cell)}
                              onDoubleClick={() => handleCellDoubleClick(cell)}
                              onContextMenu={(e) => handleCellContextMenu(cell, e)}
                              style={tileStyle}
                              className={`relative px-2 py-1 rounded-[5px] cursor-cell transition-[box-shadow,filter] ${
                                isMutedZero
                                  ? 'text-center text-zinc-600 font-normal'
                                  : 'text-right text-white font-semibold'
                              } ${
                                isSelected
                                  ? 'ring-2 ring-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)] z-[5]'
                                  : isDatalogActive
                                    ? 'ring-2 ring-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.75)] z-[7]'
                                    : isOor
                                      ? 'ring-1.5 ring-rose-500 z-[4]'
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
                              {hitCount > 0 && (
                                <span
                                  className="pointer-events-none absolute bottom-[1px] left-[2px] px-1 rounded bg-black/65 text-[8.5px] font-mono font-bold text-emerald-300 leading-tight"
                                  title={`${hitCount} datalog hits`}
                                >
                                  {hitCount}×
                                </span>
                              )}
                              {displayText}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Bottom Split Pane: 3D Surface & 2D Curves */}
            {(show3D || show2D) && (
              <div
                className={`flex-1 min-h-[240px] grid gap-3 overflow-hidden ${
                  show3D && show2D ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1'
                }`}
              >
                {show3D && (
                  <Surface3DCanvas
                    values={
                      viewMode === 'compare' && displayCmpValGrid
                        ? displayCmpValGrid
                        : displayValGrid
                    }
                    compareValues={viewMode === 'compare' ? displayValGrid : displayCmpValGrid}
                    xLabels={xLabels}
                    yLabels={yLabels}
                    units={activeUnitLabel}
                    decimals={item.scaling.decimals}
                    hoveredCell={hoveredCell}
                    selectedKeys={selectedKeys}
                    onHoverCell={setHoveredCell}
                    onSelectCell={(cell) => {
                      setAnchorCell(cell);
                      setFocusCell(cell);
                      setSelectedKeys(new Set([cellKey(cell)]));
                    }}
                    onEditCell={isLocked || viewMode === 'compare' ? undefined : handleEditCell}
                    isLocked={isLocked || viewMode === 'compare'}
                    heatmapPalette={heatmapPalette}
                    datalogPoints={datalogPoints}
                    datalogActiveCell={datalogActiveCell}
                    onResetToOriginal={() => !isLocked && onResetMap(item)}
                    onJumpToHex={() => onJumpToHex(item.data.address)}
                    onOpenXdfEditor={onOpenXdfEditor}
                  />
                )}
                {show2D && (
                  <Curves2DCanvas
                    values={
                      viewMode === 'compare' && displayCmpValGrid
                        ? displayCmpValGrid
                        : displayValGrid
                    }
                    compareValues={viewMode === 'compare' ? displayValGrid : displayCmpValGrid}
                    xLabels={xLabels}
                    yLabels={yLabels}
                    xValues={xValues}
                    units={activeUnitLabel}
                    decimals={item.scaling.decimals}
                    selectedKeys={selectedKeys}
                    hoveredCell={hoveredCell}
                    onHoverCell={setHoveredCell}
                    onEditCell={isLocked || viewMode === 'compare' ? undefined : handleEditCell}
                    isLocked={isLocked || viewMode === 'compare'}
                    datalogActiveCell={datalogActiveCell}
                    onSelectAll={selectAll}
                    onSmoothSelection={handleSmooth}
                    onResetToOriginal={() => !isLocked && onResetMap(item)}
                    onJumpToHex={() => onJumpToHex(item.data.address)}
                    onOpenXdfEditor={onOpenXdfEditor}
                  />
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Cell Right-Click Context Menu */}
      {cellCtxMenu && (
        <div
          ref={ctxMenuRef}
          style={{ left: cellCtxMenu.x, top: cellCtxMenu.y }}
          className="fixed z-50 w-56 rounded-xl glass-popover py-1.5 text-xs text-zinc-200 shadow-2xl"
        >
          {/* Quick +/- % and Step grid */}
          <div className="px-2 pb-1.5 grid grid-cols-3 gap-1">
            {(
              [
                ['+1%', () => handlePercent(1, 1)],
                ['-1%', () => handlePercent(-1, 1)],
                ['+1 Step', () => handleStep(1)],
                ['+5%', () => handlePercent(1, 5)],
                ['-5%', () => handlePercent(-1, 5)],
                ['-1 Step', () => handleStep(-1)],
              ] as const
            ).map(([lbl, fn]) => (
              <button
                key={lbl}
                type="button"
                disabled={isLocked}
                onClick={() => {
                  fn();
                  setCellCtxMenu(null);
                }}
                className="px-1.5 py-1 rounded-md bg-white/[0.06] hover:bg-white/[0.14] disabled:opacity-40 text-[10.5px] font-mono font-medium text-center cursor-pointer"
              >
                {lbl}
              </button>
            ))}
          </div>

          <div className="my-1 border-t border-white/[0.08]" />

          <button
            type="button"
            disabled={!canEditMulti}
            onClick={() => {
              handleSmooth();
              setCellCtxMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-white/[0.08] disabled:opacity-40 cursor-pointer"
          >
            Smooth (3×3)
          </button>

          <div className="px-3 py-1 flex items-center justify-between gap-1">
            <span className="text-[11px] text-zinc-400">Interpolate</span>
            <div className="inline-flex gap-1">
              {(
                [
                  ['horizontal', 'H'],
                  ['vertical', 'V'],
                  ['bilinear', '2D'],
                ] as const
              ).map(([m, lbl]) => (
                <button
                  key={m}
                  type="button"
                  disabled={!canEditMulti}
                  onClick={() => {
                    handleInterpolate(m);
                    setCellCtxMenu(null);
                  }}
                  className="px-2 py-0.5 rounded bg-white/[0.06] hover:bg-white/[0.15] disabled:opacity-40 text-[10.5px] font-mono cursor-pointer"
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            disabled={!canEditSelection || !compareBin}
            onClick={() => {
              handleRestoreOriginal();
              setCellCtxMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-white/[0.08] disabled:opacity-40 text-amber-300 cursor-pointer"
          >
            Reset Selected Cells
          </button>

          <div className="my-1 border-t border-white/[0.08]" />

          <div className="grid grid-cols-2 gap-1 px-2">
            <button
              type="button"
              onClick={() => {
                handleCopySelection(false);
                setCellCtxMenu(null);
              }}
              className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.12] text-[11px] cursor-pointer"
            >
              Copy (⌘C)
            </button>
            <button
              type="button"
              disabled={isLocked}
              onClick={() => {
                handlePasteFromClipboard();
                setCellCtxMenu(null);
              }}
              className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.12] disabled:opacity-40 text-[11px] cursor-pointer"
            >
              Paste (⌘V)
            </button>
          </div>

          <div className="my-1 border-t border-white/[0.08]" />

          <button
            type="button"
            onClick={() => {
              selectRow(cellCtxMenu.cell.r);
              setCellCtxMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-white/[0.08] cursor-pointer"
          >
            Select Row ({yLabels[cellCtxMenu.cell.r] ?? cellCtxMenu.cell.r})
          </button>
          <button
            type="button"
            onClick={() => {
              selectCol(cellCtxMenu.cell.c);
              setCellCtxMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-white/[0.08] cursor-pointer"
          >
            Select Column ({xLabels[cellCtxMenu.cell.c] ?? cellCtxMenu.cell.c})
          </button>
          <button
            type="button"
            onClick={() => {
              selectAll();
              setCellCtxMenu(null);
            }}
            className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-white/[0.08] cursor-pointer"
          >
            <span>Select All</span>
            <span className="text-[10px] font-mono text-zinc-500">⌘A</span>
          </button>

          <div className="my-1 border-t border-white/[0.08]" />

          <button
            type="button"
            onClick={() => {
              onJumpToHex(cellOffset(item.data, cellCtxMenu.cell));
              setCellCtxMenu(null);
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/[0.08] cursor-pointer"
          >
            <Binary className="w-3.5 h-3.5 text-zinc-400" />
            Jump Cell to Hex
          </button>

          {onOpenXdfEditor && (
            <button
              type="button"
              onClick={() => {
                onOpenXdfEditor();
                setCellCtxMenu(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/[0.08] cursor-pointer"
            >
              <Settings2 className="w-3.5 h-3.5 text-zinc-400" />
              Edit in XDF Editor
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default MapEditorView;
