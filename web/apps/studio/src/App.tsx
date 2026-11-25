import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeftRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Columns3,
  Cpu,
  Download,
  FileDown,
  FolderOpen,
  Globe,
  HardDrive,
  LayoutDashboard,
  LayoutGrid,
  Layers,
  Palette,
  PanelBottom,
  PanelRight,
  Pin,
  Redo2,
  Save,
  Scale,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import {
  BinCodec,
  alignDefinition,
  applyPatches,
  candidateToXDFItem,
  cellKey,
  countChangedBytes,
  countChangedCells,
  createMed17DemoBundle,
  detectChecksumPlugin,
  diffClusters,
  exportDefinition,
  exportIntelHex,
  exportSRecord,
  extractEmbeddedWinOLSBin,
  findTwinMaps,
  fixChecksums,
  identifyECU,
  importBinaryDefinition,
  importDefinition,
  isWinOLSBinary,
  layoutByteRange,
  parseBinaryFile,
  parseProject,
  runDiagnostics,
  scalingValue,
  scanMaps,
  serializeProject,
  smartMergeDefinitions,
  splitHiLo,
  verifyChecksums,
  type Cell,
  type DefinitionAlignmentResult,
  type DefinitionExportFormat,
  type DiagnosticFinding,
  type HeatmapPalette,
  type MapCandidate as CoreMapCandidate,
  type Patch,
  type Snapshot,
  type TranslationMode,
  type UnitSystem,
  type XDFDefinition,
  type XDFItem,
} from '@mactuner/core';
import {
  Sidebar,
  type HexMarker,
  type MapCandidate as UiMapCandidate,
  type SidebarMapScope,
  type SidebarTab,
  type WorkbenchMode,
} from './components/Sidebar';
import { OverviewView } from './components/OverviewView';
import { HexDiffCanvas } from './components/HexDiffCanvas';
import { MapEditorView } from './components/MapEditorView';
import { DiscoveryView } from './components/DiscoveryView';
import { MemoryMapView } from './components/MemoryMapView';
import {
  FlashPreflightView,
  type ChecksumBlock as UiChecksumBlock,
  type EditHistoryItem,
} from './components/FlashPreflightView';
import { DatalogView, type DatalogOverlayState } from './components/DatalogView';
import { MultiCompareView } from './components/MultiCompareView';
import { RecipesPluginsView } from './components/RecipesPluginsView';
import { InspectorPanel } from './components/InspectorPanel';
import { XdfEditorModal } from './components/XdfEditorModal';
import { PreSaveReviewModal } from './components/PreSaveReviewModal';
import { CommandPalette, type LayoutMode, type PaletteSection } from './components/CommandPalette';
import { BottomDrawer } from './components/BottomDrawer';
import { UpdateModal } from './components/UpdateModal';
import { WebMenuBar } from './components/WebMenuBar';
import type { DatalogPoint3D } from './components/Surface3DCanvas';
import type { HexWordFormat } from './components/Waveform2D';
import { APP_VERSION, checkForUpdates, type UpdateInfo } from './lib/updater';
import {
  AVAILABLE_LOCALES,
  I18nProvider,
  getInitialLocale,
  saveLocale,
  translate,
  type LocaleCode,
} from './lib/i18n';
import {
  HEATMAP_PALETTES,
  THEME_OPTIONS,
  applyTheme,
  getInitialHeatmapPalette,
  getInitialTheme,
  saveHeatmapPalette,
  type AppThemeId,
} from './lib/theme';

type TopSection = PaletteSection;

interface OpenBinDocument {
  id: string;
  name: string;
  bytes: Uint8Array;
}

interface HistoryEntry {
  patches: Patch[];
  label: string;
  timestamp: number;
  note?: string;
}

const DEF_EXPORT_OPTIONS: Array<{ format: DefinitionExportFormat; ext: string; label: string; desc: string }> = [
  { format: 'xdf', ext: 'xdf', label: 'TunerPro (.xdf)', desc: 'Full XDF v1.70 XML' },
  { format: 'a2l', ext: 'a2l', label: 'ASAP2 (.a2l)', desc: 'Standard ECU calibration' },
  { format: 'csv', ext: 'csv', label: 'WinOLS CSV (.csv)', desc: 'Map list table export' },
  { format: 'kp', ext: 'kp', label: 'WinOLS Map Pack (.kp)', desc: 'Binary WinOLS map pack' },
  { format: 'xml', ext: 'xml', label: 'RomRaider (.xml)', desc: 'RomRaider ECU XML definition' },
];

function stripExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function candidateKey(c: { address: number; rows: number; cols: number; bits: number }): string {
  return `${c.address}_${c.rows}x${c.cols}_${c.bits}`;
}

function computeByteDiffPatches(prev: Uint8Array, next: Uint8Array): Patch[] {
  if (prev.length !== next.length) {
    return [{ offset: 0, old: prev.slice(), next: next.slice() }];
  }
  const patches: Patch[] = [];
  let i = 0;
  while (i < prev.length) {
    if (prev[i] !== next[i]) {
      const start = i;
      while (i < prev.length && prev[i] !== next[i]) i++;
      patches.push({
        offset: start,
        old: prev.slice(start, i),
        next: next.slice(start, i),
      });
    } else {
      i++;
    }
  }
  return patches;
}

function toUiCandidate(c: CoreMapCandidate, bin: Uint8Array, cmp: Uint8Array | null): UiMapCandidate {
  const [start, end] = layoutByteRange(c.layout);
  const hasDiff = cmp ? countChangedBytes(bin, cmp, start, end) > 0 : false;
  return {
    id: c.id,
    address: c.address,
    rows: c.rows,
    cols: c.cols,
    bits: c.bits,
    signed: c.signed,
    isFloat: c.isFloat,
    lsbFirst: c.lsbFirst,
    confidence: c.confidence,
    patternLabel: c.shortBadge,
    hasHeaderProof: c.evidence === 'Header Proof',
    hasAxes: c.xAxisAddress !== undefined || c.yAxisAddress !== undefined,
    hasDiff,
    xAxisAddress: c.xAxisAddress,
    yAxisAddress: c.yAxisAddress,
    domainHint: c.rpmAxisDetected ? 'RPM axis' : undefined,
  };
}

function fromUiCandidate(c: UiMapCandidate): CoreMapCandidate {
  const isFloat = Boolean(c.isFloat || c.bits === 32);
  return {
    id: c.id,
    address: c.address,
    rows: c.rows,
    cols: c.cols,
    bits: c.bits,
    signed: c.signed,
    isFloat,
    lsbFirst: c.lsbFirst,
    xAxisAddress: c.xAxisAddress,
    yAxisAddress: c.yAxisAddress,
    axisBits: c.bits,
    confidence: c.confidence,
    evidence: c.hasHeaderProof ? 'Header Proof' : c.hasAxes ? 'Axis Proof' : 'Data Pattern',
    shortBadge: c.patternLabel ?? `${c.rows}×${c.cols}`,
    reason: `Auto-detected ${c.bits}-bit ${c.rows}×${c.cols} map`,
    rpmAxisDetected: Boolean(c.domainHint),
    layout: {
      address: c.address,
      bits: c.bits,
      signed: c.signed,
      lsbFirst: c.lsbFirst,
      columnMajor: false,
      isFloat,
      rows: c.rows,
      cols: c.cols,
    },
  };
}

function wordFormatToLayout(fmt: HexWordFormat): { bits: number; lsbFirst: boolean; isFloat: boolean } {
  switch (fmt) {
    case 'u8':
      return { bits: 8, lsbFirst: true, isFloat: false };
    case 'u16le':
      return { bits: 16, lsbFirst: true, isFloat: false };
    case 'u16be':
      return { bits: 16, lsbFirst: false, isFloat: false };
    case 'u32le':
      return { bits: 32, lsbFirst: true, isFloat: false };
    case 'u32be':
      return { bits: 32, lsbFirst: false, isFloat: false };
    case 'f32le':
      return { bits: 32, lsbFirst: true, isFloat: true };
    case 'f32be':
      return { bits: 32, lsbFirst: false, isFloat: true };
  }
}

export default function App() {
  const initialDemo = useMemo(() => createMed17DemoBundle(), []);

  // Multi-BIN Document Bar state
  const [openBins, setOpenBins] = useState<OpenBinDocument[]>(() => [
    { id: 'bin-stage1', name: initialDemo.stage1Name, bytes: initialDemo.stage1Bin },
    { id: 'bin-stock', name: initialDemo.stockName, bytes: initialDemo.stockBin },
  ]);
  const [activeBinId, setActiveBinId] = useState<string>('bin-stage1');
  const [compareBinId, setCompareBinId] = useState<string | null>('bin-stock');
  const [openedSnapshot, setOpenedSnapshot] = useState<Uint8Array>(() => initialDemo.stage1Bin.slice());

  const activeBinDoc = useMemo(
    () => openBins.find((b) => b.id === activeBinId) ?? openBins[0],
    [openBins, activeBinId],
  );
  const compareBinDoc = useMemo(
    () => (compareBinId ? openBins.find((b) => b.id === compareBinId) ?? null : null),
    [openBins, compareBinId],
  );

  const bin = activeBinDoc.bytes;
  const binName = activeBinDoc.name;
  const compareBin = compareBinDoc?.bytes ?? null;
  const compareName = compareBinDoc?.name ?? '';

  const updateActiveBinBytes = useCallback(
    (updater: (prev: Uint8Array) => Uint8Array) => {
      setOpenBins((prev) =>
        prev.map((doc) => (doc.id === activeBinId ? { ...doc, bytes: updater(doc.bytes) } : doc)),
      );
    },
    [activeBinId],
  );

  const [xdfName, setXdfName] = useState<string>(initialDemo.xdfName);
  const [xdf, setXdf] = useState<XDFDefinition | null>(initialDemo.xdf);

  // Navigation & Layout states
  const [section, setSection] = useState<TopSection>('workspace');
  const [workbenchMode, setWorkbenchMode] = useState<WorkbenchMode>('hex');
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('maps');
  const [sidebarMapScope, setSidebarMapScope] = useState<SidebarMapScope>('all');
  const [diffClusterGap, setDiffClusterGap] = useState<number>(16);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('studio');
  const [bottomDrawerOpen, setBottomDrawerOpen] = useState<boolean>(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState<boolean>(true);

  const [selectedItemId, setSelectedItemId] = useState<number | null>(initialDemo.xdf.items[0]?.id ?? null);
  const [pinnedItemId, setPinnedItemId] = useState<number | null>(null);
  const [mirrorPinnedEdits, setMirrorPinnedEdits] = useState<boolean>(false);
  const [ideTabs, setIdeTabs] = useState<number[]>(() =>
    initialDemo.xdf.items.slice(0, 3).map((it) => it.id),
  );

  const [jumpAddress, setJumpAddress] = useState<number | null>(0x24024);
  const [hexCols, setHexCols] = useState<number>(8);
  const [hexJumpNonce, setHexJumpNonce] = useState<number>(0);
  const [selectedRange, setSelectedRange] = useState<[number, number] | null>(null);
  const [pendingCompareSlot, setPendingCompareSlot] = useState<{
    id: string;
    name: string;
    bytes: Uint8Array;
  } | null>(null);
  const [customUiCandidates, setCustomUiCandidates] = useState<UiMapCandidate[] | null>(null);
  const [autoAlignBanner, setAutoAlignBanner] = useState<{
    result: DefinitionAlignmentResult;
    shiftedCount: number;
    dominantDelta: number;
  } | null>(null);
  const [autoAlignConfidenceByItemId, setAutoAlignConfidenceByItemId] = useState<Record<number, number>>({});
  const [markers, setMarkers] = useState<HexMarker[]>([
    { id: 'm1', address: 0x20044, label: 'Target Boost Pressure (LDRXN)', color: '#2589ff' },
    { id: 'm2', address: 0x24024, label: 'Stage 1 Detected Diff Map', color: '#f59e0b' },
  ]);

  // Shared lifted parity states
  const [snapshots, setSnapshots] = useState<Snapshot[]>(() => [
    {
      id: 'snap-initial',
      name: 'Initial Loaded State',
      createdAt: Date.now() - 120_000,
      changedBytes: 0,
      bytes: initialDemo.stage1Bin.slice(),
      note: 'Auto-captured when BIN was opened',
    },
  ]);
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    const first = initialDemo.xdf.items[0]?.id;
    return first !== undefined ? new Set([String(first)]) : new Set();
  });
  const [safeRanges, setSafeRanges] = useState<Record<string, { min?: number; max?: number }>>({});
  const [dismissedCandidateKeys, setDismissedCandidateKeys] = useState<Set<string>>(() => new Set());
  const [candidateScanNonce, setCandidateScanNonce] = useState<number>(0);

  const [unitSystem, setUnitSystem] = useState<UnitSystem>('original');
  const [translationMode, setTranslationMode] = useState<TranslationMode>('original');
  const [heatmapPalette, setHeatmapPalette] = useState<HeatmapPalette>(() => getInitialHeatmapPalette());
  const [locale, setLocale] = useState<LocaleCode>(() => getInitialLocale());
  const [themeId, setThemeId] = useState<AppThemeId>(() => getInitialTheme());

  const [rawDatalogOverlay, setRawDatalogOverlay] = useState<DatalogOverlayState | null>(null);

  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  const [lockedItemIds, setLockedItemIds] = useState<Set<number>>(() => new Set());
  const [xdfEditorOpen, setXdfEditorOpen] = useState(false);
  const [xdfEditorItem, setXdfEditorItem] = useState<XDFItem | null>(null);
  const [xdfModalDraft, setXdfModalDraft] = useState<Partial<XDFItem> | null>(null);
  const [exportDefMenuOpen, setExportDefMenuOpen] = useState(false);
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [exportReviewOpen, setExportReviewOpen] = useState(false);
  const [checksumProfileId, setChecksumProfileId] = useState<string>(
    () => detectChecksumPlugin(initialDemo.stage1Bin).id,
  );

  const handleLocaleChange = useCallback((next: LocaleCode) => {
    setLocale(next);
    saveLocale(next);
  }, []);

  const t = useCallback(
    (key: string, ...args: (string | number)[]) => translate(locale, key, ...args),
    [locale],
  );

  useEffect(() => {
    applyTheme(themeId);
  }, [themeId]);

  const handleHeatmapPaletteChange = useCallback((next: HeatmapPalette) => {
    setHeatmapPalette(next);
    saveHeatmapPalette(next);
  }, []);

  const exportDefRef = useRef<HTMLDivElement>(null);
  const langMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const compareInputRef = useRef<HTMLInputElement>(null);
  const smartMergeInputRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 2800);
  }, []);

  const runUpdateCheck = useCallback(async () => {
    setCheckingUpdate(true);
    const info = await checkForUpdates();
    setUpdateInfo(info);
    setCheckingUpdate(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void runUpdateCheck();
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [runUpdateCheck]);

  useEffect(() => {
    if (!exportDefMenuOpen && !langMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (exportDefMenuOpen && exportDefRef.current && !exportDefRef.current.contains(e.target as Node)) {
        setExportDefMenuOpen(false);
      }
      if (langMenuOpen && langMenuRef.current && !langMenuRef.current.contains(e.target as Node)) {
        setLangMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExportDefMenuOpen(false);
        setLangMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [exportDefMenuOpen, langMenuOpen]);

  const ecuIdentity = useMemo(() => identifyECU(bin), [bin]);

  const clusters = useMemo(
    () => (compareBin ? diffClusters(bin, compareBin, diffClusterGap) : []),
    [bin, compareBin, diffClusterGap],
  );

  const coveredRanges = useMemo<Array<[number, number]>>(() => {
    if (!xdf) return [];
    return xdf.items.map((it) => layoutByteRange(it.data));
  }, [xdf]);

  const outsideClusters = useMemo(() => {
    if (clusters.length === 0) return [];
    return clusters.filter(
      (c) => !coveredRanges.some(([s, e]) => c.start < e && c.end > s),
    );
  }, [clusters, coveredRanges]);

  const outsideOfXdfBytes = useMemo(
    () => outsideClusters.reduce((sum, c) => sum + c.changedBytes, 0),
    [outsideClusters],
  );

  const coreCandidates = useMemo(() => {
    void candidateScanNonce;
    return scanMaps(bin, coveredRanges).filter(
      (c) => !dismissedCandidateKeys.has(candidateKey(c)),
    );
  }, [bin, coveredRanges, dismissedCandidateKeys, candidateScanNonce]);

  useEffect(() => {
    setCustomUiCandidates(null);
  }, [bin, candidateScanNonce]);

  const uiCandidates = useMemo(
    () => customUiCandidates ?? coreCandidates.map((c) => toUiCandidate(c, bin, compareBin)),
    [customUiCandidates, coreCandidates, bin, compareBin],
  );

  const changedItemIds = useMemo(() => {
    const out = new Set<number>();
    if (!xdf || !compareBin) return out;
    for (const item of xdf.items) {
      if (countChangedCells(item, bin, compareBin) > 0) out.add(item.id);
    }
    return out;
  }, [xdf, bin, compareBin]);

  const diagnostics = useMemo(
    () => runDiagnostics(bin, compareBin, xdf),
    [bin, compareBin, xdf],
  );

  const diagnosticWarningItemIds = useMemo(() => {
    const out = new Set<number>();
    for (const f of diagnostics) {
      if (f.itemId !== undefined && (f.severity === 'error' || f.severity === 'warning')) {
        out.add(f.itemId);
      }
    }
    return out;
  }, [diagnostics]);

  const outOfSafeRangeItemIds = useMemo(() => {
    const out = new Set<number>();
    if (!xdf) return out;
    for (const item of xdf.items) {
      const range = safeRanges[String(item.id)];
      if (!range || (range.min === undefined && range.max === undefined)) continue;
      const l = item.data;
      let violated = false;
      for (let r = 0; r < l.rows && !violated; r++) {
        for (let c = 0; c < l.cols && !violated; c++) {
          const raw = BinCodec.raw(l, { r, c }, bin);
          if (raw === null) continue;
          const phys = scalingValue(item.scaling, raw);
          if (range.min !== undefined && phys < range.min) violated = true;
          if (range.max !== undefined && phys > range.max) violated = true;
        }
      }
      if (violated) out.add(item.id);
    }
    return out;
  }, [xdf, safeRanges, bin]);

  const checksumReport = useMemo(
    () => verifyChecksums(bin, compareBin ?? undefined, checksumProfileId),
    [bin, compareBin, checksumProfileId],
  );

  const uiChecksumBlocks = useMemo<UiChecksumBlock[]>(() => {
    return checksumReport.blocks.map((b) => ({
      id: b.id,
      name: b.name,
      algorithm: b.algorithm,
      start: b.start,
      end: b.end,
      storeAddress: b.storeAddress ?? Math.max(b.start, b.end - 8),
      expectedHex: b.computedHex,
      actualHex: b.storedHex,
      valid: b.valid,
      protected: b.triage === 'uncorrectable',
    }));
  }, [checksumReport]);

  const selectedItem = useMemo(
    () => xdf?.items.find((i) => i.id === selectedItemId) ?? xdf?.items[0] ?? null,
    [xdf, selectedItemId],
  );

  // Project live datalog samples & active frame onto the selected map's X/Y axis breakpoints
  const datalogOverlay = useMemo<{
    enabled: boolean;
    frameIndex: number;
    xChannel: string;
    yChannel: string;
    xValue?: number;
    yValue?: number;
    hits: Record<string, number>;
    activeCell: Cell | null;
    points3d: DatalogPoint3D[];
  }>(() => {
    if (!rawDatalogOverlay || !rawDatalogOverlay.enabled) {
      return {
        enabled: false,
        frameIndex: rawDatalogOverlay?.frameIndex ?? 0,
        xChannel: rawDatalogOverlay?.xChannel ?? 'RPM',
        yChannel: rawDatalogOverlay?.yChannel ?? 'Load',
        xValue: rawDatalogOverlay?.xValue,
        yValue: rawDatalogOverlay?.yValue,
        hits: {},
        activeCell: null,
        points3d: [],
      };
    }

    const hits: Record<string, number> = {};
    let activeCell: Cell | null = null;
    const points3d: DatalogPoint3D[] = [];

    if (selectedItem && selectedItem.itemKind.kind === 'table') {
      const rows = Math.max(1, selectedItem.data.rows);
      const cols = Math.max(1, selectedItem.data.cols);
      const xVals = BinCodec.axisValues(selectedItem.itemKind.x, cols, bin);
      const yVals = BinCodec.axisValues(selectedItem.itemKind.y, rows, bin);

      const nearestIdx = (axis: number[], val: number): number => {
        if (axis.length <= 1) return 0;
        let best = 0;
        let bestDist = Math.abs(axis[0] - val);
        for (let i = 1; i < axis.length; i++) {
          const d = Math.abs(axis[i] - val);
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        }
        return best;
      };

      const cellMap = new Map<string, { r: number; c: number; count: number; zSum: number; zCount: number }>();
      const samples = rawDatalogOverlay.samples ?? [];
      for (const s of samples) {
        if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
        const c = nearestIdx(xVals, s.x);
        const r = nearestIdx(yVals, s.y);
        const k = cellKey({ r, c });
        hits[k] = (hits[k] ?? 0) + 1;
        const entry = cellMap.get(k) ?? { r, c, count: 0, zSum: 0, zCount: 0 };
        entry.count++;
        if (s.z !== undefined && Number.isFinite(s.z)) {
          entry.zSum += s.z;
          entry.zCount++;
        }
        cellMap.set(k, entry);
      }

      if (
        rawDatalogOverlay.xValue !== undefined &&
        rawDatalogOverlay.yValue !== undefined &&
        Number.isFinite(rawDatalogOverlay.xValue) &&
        Number.isFinite(rawDatalogOverlay.yValue)
      ) {
        activeCell = {
          r: nearestIdx(yVals, rawDatalogOverlay.yValue),
          c: nearestIdx(xVals, rawDatalogOverlay.xValue),
        };
      }

      for (const entry of cellMap.values()) {
        const rawCell = BinCodec.raw(selectedItem.data, { r: entry.r, c: entry.c }, bin);
        const mapVal = rawCell !== null ? scalingValue(selectedItem.scaling, rawCell) : 0;
        points3d.push({
          r: entry.r,
          c: entry.c,
          value: entry.zCount > 0 ? entry.zSum / entry.zCount : mapVal,
          hits: entry.count,
        });
      }
    }

    return {
      enabled: rawDatalogOverlay.enabled,
      frameIndex: rawDatalogOverlay.frameIndex,
      xChannel: rawDatalogOverlay.xChannel,
      yChannel: rawDatalogOverlay.yChannel,
      xValue: rawDatalogOverlay.xValue,
      yValue: rawDatalogOverlay.yValue,
      hits,
      activeCell,
      points3d,
    };
  }, [rawDatalogOverlay, selectedItem, bin]);

  const pinnedItem = useMemo(
    () => (pinnedItemId !== null ? xdf?.items.find((i) => i.id === pinnedItemId) ?? null : null),
    [xdf, pinnedItemId],
  );

  const isSelectedLocked = selectedItem ? lockedItemIds.has(selectedItem.id) : false;

  const historyEntries = useMemo<EditHistoryItem[]>(
    () =>
      undoStack.map((entry) => ({
        label: entry.label,
        bytes: entry.patches.reduce((sum, p) => sum + p.next.length, 0),
        timestamp: entry.timestamp,
        note: entry.note,
      })),
    [undoStack],
  );

  const selectMapById = useCallback((id: number) => {
    setSelectedItemId(id);
    setIdeTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setSection('workspace');
    setWorkbenchMode('map');
  }, []);

  const handleToggleLockItem = useCallback(
    (item: XDFItem) => {
      setLockedItemIds((prev) => {
        const next = new Set(prev);
        if (next.has(item.id)) {
          next.delete(item.id);
          showToast(`Unlocked: ${item.title}`);
        } else {
          next.add(item.id);
          showToast(`Locked: ${item.title}`);
        }
        return next;
      });
    },
    [showToast],
  );

  const handleToggleLockSelected = useCallback(() => {
    if (selectedItem) handleToggleLockItem(selectedItem);
  }, [selectedItem, handleToggleLockItem]);

  const handleToggleFavoriteItem = useCallback(
    (item: XDFItem) => {
      const key = String(item.id);
      setFavorites((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
          showToast(`Removed favorite: ${item.title}`);
        } else {
          next.add(key);
          showToast(`Favorited: ${item.title}`);
        }
        return next;
      });
    },
    [showToast],
  );

  const handleToggleFavoriteSelected = useCallback(() => {
    if (selectedItem) handleToggleFavoriteItem(selectedItem);
  }, [selectedItem, handleToggleFavoriteItem]);

  const handleTogglePinItem = useCallback(
    (item: XDFItem) => {
      setPinnedItemId((prev) => {
        if (prev === item.id) {
          showToast(`Unpinned split: ${item.title}`);
          return null;
        }
        showToast(`Pinned for Split View: ${item.title}`);
        return item.id;
      });
    },
    [showToast],
  );

  const handleCycleChangedMap = useCallback(
    (dir: 1 | -1) => {
      if (!xdf) return;
      const changed = xdf.items.filter((it) => changedItemIds.has(it.id));
      if (changed.length === 0) {
        showToast('No changed maps vs comparison BIN');
        return;
      }
      const curIdx = changed.findIndex((it) => it.id === selectedItemId);
      const nextIdx =
        curIdx === -1
          ? 0
          : (curIdx + dir + changed.length) % changed.length;
      const target = changed[nextIdx];
      selectMapById(target.id);
      showToast(`Changed map ${nextIdx + 1}/${changed.length}: ${target.title}`);
    },
    [xdf, changedItemIds, selectedItemId, selectMapById, showToast],
  );

  const handleOpenXdfEditor = useCallback((targetItem: XDFItem | null, draft: Partial<XDFItem> | null = null) => {
    setXdfEditorItem(targetItem);
    setXdfModalDraft(draft);
    setXdfEditorOpen(true);
  }, []);

  const handleSaveXdfItem = useCallback(
    (updatedItem: XDFItem) => {
      setXdf((prev) => {
        const base: XDFDefinition = prev ?? {
          title: 'MacTuner Definition',
          description: '',
          baseOffset: 0,
          categories: {},
          items: [],
        };
        const exists = base.items.some((it) => it.id === updatedItem.id);
        const nextItems = exists
          ? base.items.map((it) => (it.id === updatedItem.id ? updatedItem : it))
          : [updatedItem, ...base.items];
        return { ...base, items: nextItems };
      });
      setSelectedItemId(updatedItem.id);
      setIdeTabs((prev) => (prev.includes(updatedItem.id) ? prev : [...prev, updatedItem.id]));
      setXdfEditorOpen(false);
      setXdfModalDraft(null);
      showToast(`Saved XDF item: ${updatedItem.title}`);
    },
    [showToast],
  );

  const handleDeleteXdfItem = useCallback(
    (id: number) => {
      setXdf((prev) => {
        if (!prev) return prev;
        const nextItems = prev.items.filter((it) => it.id !== id);
        if (selectedItemId === id) {
          setSelectedItemId(nextItems[0]?.id ?? null);
        }
        return { ...prev, items: nextItems };
      });
      setIdeTabs((prev) => prev.filter((tid) => tid !== id));
      setPinnedItemId((prev) => (prev === id ? null : prev));
      setLockedItemIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      showToast('Deleted item from XDF definition');
    },
    [selectedItemId, showToast],
  );

  const handleAddCategory = useCallback(
    (name: string) => {
      const existingIds = Object.keys(xdf?.categories ?? {})
        .map(Number)
        .filter(Number.isFinite);
      const nextId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;
      setXdf((prev) => {
        const base: XDFDefinition = prev ?? {
          title: 'MacTuner Definition',
          description: '',
          baseOffset: 0,
          categories: {},
          items: [],
        };
        return { ...base, categories: { ...base.categories, [nextId]: name } };
      });
      return nextId;
    },
    [xdf?.categories],
  );

  const undoStackRef = useRef(undoStack);
  undoStackRef.current = undoStack;
  const redoStackRef = useRef(redoStack);
  redoStackRef.current = redoStack;

  const handleApplyPatches = useCallback(
    (patches: Patch[], label: string) => {
      if (patches.length === 0) return;
      updateActiveBinBytes((prev) => applyPatches(prev, patches));
      setUndoStack((prev) => [...prev.slice(-199), { patches, label, timestamp: Date.now() }]);
      setRedoStack([]);
      showToast(label);
    },
    [updateActiveBinBytes, showToast],
  );

  // Mirror edits symmetrically between active & pinned maps when mirrorPinnedEdits is enabled and layouts match
  const handleApplyPatchesWithMirror = useCallback(
    (patches: Patch[], label: string, sourceItem?: XDFItem) => {
      const targetItem =
        sourceItem && pinnedItem && selectedItem
          ? sourceItem.id === pinnedItem.id
            ? selectedItem
            : sourceItem.id === selectedItem.id
              ? pinnedItem
              : null
          : null;
      if (
        mirrorPinnedEdits &&
        sourceItem &&
        targetItem &&
        targetItem.id !== sourceItem.id &&
        sourceItem.data.rows === targetItem.data.rows &&
        sourceItem.data.cols === targetItem.data.cols &&
        sourceItem.data.bits === targetItem.data.bits
      ) {
        const deltaAddr = targetItem.data.address - sourceItem.data.address;
        const [srcStart, srcEnd] = layoutByteRange(sourceItem.data);
        const mirrored: Patch[] = [];
        for (const p of patches) {
          if (p.offset >= srcStart && p.offset + p.next.length <= srcEnd) {
            const targetOffset = p.offset + deltaAddr;
            if (targetOffset >= 0 && targetOffset + p.next.length <= bin.length) {
              mirrored.push({
                offset: targetOffset,
                old: bin.slice(targetOffset, targetOffset + p.next.length),
                next: p.next.slice(),
              });
            }
          }
        }
        handleApplyPatches([...patches, ...mirrored], `${label} (+ mirrored to ${targetItem.title})`);
        return;
      }
      handleApplyPatches(patches, label);
    },
    [mirrorPinnedEdits, pinnedItem, selectedItem, bin, handleApplyPatches],
  );

  const replaceBytesWithHistory = useCallback(
    (nextBytes: Uint8Array, description: string) => {
      const patches = computeByteDiffPatches(bin, nextBytes);
      if (patches.length === 0) {
        showToast(`${description} (no byte changes)`);
        return;
      }
      if (nextBytes.length !== bin.length) {
        updateActiveBinBytes(() => nextBytes.slice());
        setUndoStack((prev) => [...prev.slice(-49), { patches, label: description, timestamp: Date.now() }]);
        setRedoStack([]);
        showToast(description);
        return;
      }
      handleApplyPatches(patches, description);
    },
    [bin, updateActiveBinBytes, handleApplyPatches, showToast],
  );

  const handleApplySinglePatch = useCallback(
    (offset: number, next: Uint8Array, label: string) => {
      const old = bin.slice(offset, offset + next.length);
      handleApplyPatches([{ offset, old, next }], label);
    },
    [bin, handleApplyPatches],
  );

  const handleUndo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) {
      showToast('Nothing to undo');
      return;
    }
    const last = stack[stack.length - 1];
    const nextUndo = stack.slice(0, -1);
    undoStackRef.current = nextUndo;
    const inv: Patch[] = last.patches.map((p) => ({ offset: p.offset, old: p.next, next: p.old }));
    setUndoStack(nextUndo);
    updateActiveBinBytes((cur) => {
      if (inv.length === 1 && inv[0].offset === 0 && inv[0].next.length !== cur.length) {
        return inv[0].next.slice();
      }
      return applyPatches(cur, inv);
    });
    setRedoStack((r) => [...r, last]);
    showToast(`Undo: ${last.label}`);
  }, [updateActiveBinBytes, showToast]);

  const handleRedo = useCallback(() => {
    const stack = redoStackRef.current;
    if (stack.length === 0) {
      showToast('Nothing to redo');
      return;
    }
    const last = stack[stack.length - 1];
    const nextRedo = stack.slice(0, -1);
    redoStackRef.current = nextRedo;
    setRedoStack(nextRedo);
    updateActiveBinBytes((cur) => {
      if (last.patches.length === 1 && last.patches[0].offset === 0 && last.patches[0].next.length !== cur.length) {
        return last.patches[0].next.slice();
      }
      return applyPatches(cur, last.patches);
    });
    setUndoStack((u) => [...u, last]);
    showToast(`Redo: ${last.label}`);
  }, [updateActiveBinBytes, showToast]);

  const handleSaveSnapshot = useCallback(
    (name: string, note?: string) => {
      const snap: Snapshot = {
        id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: name.trim() || `Snapshot ${snapshots.length + 1}`,
        createdAt: Date.now(),
        changedBytes: compareBin ? countChangedBytes(bin, compareBin) : 0,
        bytes: bin.slice(),
        note,
      };
      setSnapshots((prev) => [snap, ...prev]);
      showToast(`Saved snapshot: ${snap.name}`);
    },
    [bin, compareBin, snapshots.length, showToast],
  );

  const handleQuickSnapshot = useCallback(() => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    handleSaveSnapshot(`Quick Snapshot ${time}`, `Captured from ${binName}`);
  }, [handleSaveSnapshot, binName]);

  const handleAddBookmark = useCallback(
    (address: number, label?: string) => {
      const id = `mk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const hex = `0x${address.toString(16).toUpperCase().padStart(5, '0')}`;
      setMarkers((prev) => [
        { id, address, label: label?.trim() || `Bookmark @ ${hex}`, color: '#0a84ff', createdAt: Date.now() },
        ...prev,
      ]);
      showToast(`Bookmarked ${hex}`);
    },
    [showToast],
  );

  const handleClearBookmarks = useCallback(() => {
    setMarkers([]);
    showToast('Cleared all bookmarks');
  }, [showToast]);

  const handleAddCoreCandidate = useCallback(
    (cand: CoreMapCandidate, openEditor: boolean) => {
      setXdf((prev) => {
        const base: XDFDefinition = prev ?? {
          title: 'MacTuner Definition',
          description: '',
          baseOffset: 0,
          categories: {},
          items: [],
        };
        const nextId = base.items.reduce((m, i) => Math.max(m, i.id), -1) + 1;
        const item = candidateToXDFItem(cand, nextId);
        setSelectedItemId(item.id);
        setIdeTabs((tabs) => (tabs.includes(item.id) ? tabs : [...tabs, item.id]));
        if (openEditor) {
          setSection('workspace');
          setWorkbenchMode('map');
        }
        showToast(`Added ${item.title} to XDF`);
        return { ...base, items: [item, ...base.items] };
      });
    },
    [showToast],
  );

  const handleFixChecksums = useCallback(() => {
    const res = fixChecksums(bin, checksumProfileId);
    if (res.patches.length === 0) {
      showToast('All checksums are already valid');
      return;
    }
    handleApplyPatches(res.patches, `Fixed ${res.fixedCount} checksum block(s)`);
  }, [bin, checksumProfileId, handleApplyPatches, showToast]);

  const handleResetMap = useCallback(
    (item: XDFItem) => {
      if (!compareBin) return;
      const [start, end] = layoutByteRange(item.data);
      const next = compareBin.slice(start, end);
      const old = bin.slice(start, end);
      handleApplyPatches([{ offset: start, old, next }], `Reset ${item.title} to comparison`);
    },
    [bin, compareBin, handleApplyPatches],
  );

  const handleCopyMapFromSource = useCallback(
    (item: XDFItem, source: { kind: 'compare' | 'bin' | 'map'; id?: string | number }) => {
      const [start, end] = layoutByteRange(item.data);
      if (source.kind === 'compare') {
        handleResetMap(item);
        return;
      }
      if (source.kind === 'bin' && typeof source.id === 'string') {
        const doc = openBins.find((b) => b.id === source.id);
        if (!doc || end > doc.bytes.length) return;
        const next = doc.bytes.slice(start, end);
        const old = bin.slice(start, end);
        handleApplyPatches([{ offset: start, old, next }], `Copied ${item.title} from ${doc.name}`);
        return;
      }
      if (source.kind === 'map' && typeof source.id === 'number' && xdf) {
        const srcItem = xdf.items.find((it) => it.id === source.id);
        if (!srcItem) return;
        const [sStart, sEnd] = layoutByteRange(srcItem.data);
        const len = Math.min(end - start, sEnd - sStart);
        if (len <= 0 || sStart + len > bin.length) return;
        const next = bin.slice(sStart, sStart + len);
        const old = bin.slice(start, start + len);
        handleApplyPatches([{ offset: start, old, next }], `Copied ${srcItem.title} → ${item.title}`);
      }
    },
    [bin, openBins, xdf, handleResetMap, handleApplyPatches],
  );

  const handleSwapBins = useCallback(() => {
    if (!compareBinId) return;
    const prevActive = activeBinId;
    const prevCompare = compareBinId;
    setActiveBinId(prevCompare);
    setCompareBinId(prevActive);
    const nextDoc = openBins.find((b) => b.id === prevCompare);
    if (nextDoc) {
      setOpenedSnapshot(nextDoc.bytes.slice());
      showToast(`Swapped active BIN → ${nextDoc.name}`);
    }
  }, [activeBinId, compareBinId, openBins, showToast]);

  const handleFiles = useCallback(
    async (files: FileList | File[], asCompare = false) => {
      for (const file of Array.from(files)) {
        const lower = file.name.toLowerCase();
        try {
          if (lower.endsWith('.mtproj')) {
            const text = await file.text();
            const proj = parseProject(text);
            let nextDocs: OpenBinDocument[] = [];
            let mainId = `bin-${Date.now()}`;
            let cmpId: string | null = null;
            if (proj.openBins && proj.openBins.length > 0) {
              nextDocs = proj.openBins.map((b) => ({ id: b.id, name: b.name, bytes: b.bytes }));
              const activeDoc = proj.openBins.find((b) => b.isActive) ?? proj.openBins[0];
              mainId = activeDoc.id;
              if (proj.compareBin) {
                const matchCmp = nextDocs.find((d) => d.id !== mainId && d.name === proj.compareName);
                if (matchCmp) {
                  cmpId = matchCmp.id;
                } else {
                  cmpId = `bin-cmp-${Date.now()}`;
                  nextDocs.push({ id: cmpId, name: proj.compareName ?? 'Comparison.bin', bytes: proj.compareBin });
                }
              }
            } else {
              nextDocs = [{ id: mainId, name: proj.binName, bytes: proj.bin }];
              if (proj.compareBin) {
                cmpId = `bin-cmp-${Date.now()}`;
                nextDocs.push({ id: cmpId, name: proj.compareName ?? 'Comparison.bin', bytes: proj.compareBin });
              }
            }
            setOpenBins(nextDocs);
            setActiveBinId(mainId);
            setCompareBinId(cmpId);
            setOpenedSnapshot(proj.bin.slice());
            setXdf(proj.xdf ?? null);
            if (proj.xdfName) setXdfName(proj.xdfName);
            if (proj.markers) setMarkers(proj.markers);
            if (proj.lockedItemIds) setLockedItemIds(new Set(proj.lockedItemIds));
            if (proj.selectedProfileId) {
              setChecksumProfileId(proj.selectedProfileId);
            } else {
              setChecksumProfileId(detectChecksumPlugin(proj.bin).id);
            }
            if (proj.snapshots) {
              setSnapshots(proj.snapshots);
            }
            if (proj.favorites) {
              setFavorites(new Set(proj.favorites.map(String)));
            }
            if (proj.safeRanges) {
              const restoredRanges: Record<string, { min?: number; max?: number }> = {};
              for (const [k, v] of Object.entries(proj.safeRanges)) {
                restoredRanges[String(k)] = v;
              }
              setSafeRanges(restoredRanges);
            }
            if (proj.dismissedCandidateKeys) {
              setDismissedCandidateKeys(new Set(proj.dismissedCandidateKeys));
            }
            if (proj.historyEntries && proj.historyEntries.length > 0) {
              setUndoStack(
                proj.historyEntries.map((h) => ({
                  patches: [],
                  label: h.label,
                  timestamp: h.timestamp,
                })),
              );
            } else {
              setUndoStack([]);
            }
            setSelectedItemId(proj.xdf?.items[0]?.id ?? null);
            setRedoStack([]);
            showToast(`Opened project: ${file.name}`);
          } else if (lower.endsWith('.ols') || lower.endsWith('.kp')) {
            const rawBuf = new Uint8Array(await file.arrayBuffer());
            const parsed = importBinaryDefinition(file.name, rawBuf);
            setXdf(parsed);
            setXdfName(file.name);
            setSelectedItemId(parsed.items[0]?.id ?? null);
            let extractedMsg = '';
            if (lower.endsWith('.ols')) {
              const candidateSizes = [bin.length, 0x200000, 0x100000, 0x80000, 0x400000, 0x40000, 0x20000];
              for (const sz of candidateSizes) {
                const embedded = extractEmbeddedWinOLSBin(rawBuf, parsed, sz);
                if (embedded) {
                  const embId = `bin-ols-${Date.now()}`;
                  const embName = `${stripExt(file.name)}.bin`;
                  setOpenBins((prev) => [...prev, { id: embId, name: embName, bytes: embedded }]);
                  setActiveBinId(embId);
                  setOpenedSnapshot(embedded.slice());
                  setUndoStack([]);
                  setRedoStack([]);
                  setChecksumProfileId(detectChecksumPlugin(embedded).id);
                  extractedMsg = ` + extracted ${Math.round(embedded.length / 1024)} KB BIN`;
                  break;
                }
              }
            }
            showToast(`Loaded WinOLS definition: ${file.name} (${parsed.items.length} items${extractedMsg})`);
          } else if (
            lower.endsWith('.xdf') ||
            lower.endsWith('.xml') ||
            lower.endsWith('.a2l') ||
            lower.endsWith('.csv')
          ) {
            const text = await file.text();
            const parsed = importDefinition(file.name, text);
            setXdf(parsed);
            setXdfName(file.name);
            setSelectedItemId(parsed.items[0]?.id ?? null);
            showToast(`Loaded definition: ${file.name} (${parsed.items.length} items)`);
          } else {
            const rawBuf = new Uint8Array(await file.arrayBuffer());
            if (isWinOLSBinary(rawBuf)) {
              const parsed = importBinaryDefinition(file.name, rawBuf);
              setXdf(parsed);
              setXdfName(file.name);
              setSelectedItemId(parsed.items[0]?.id ?? null);
              showToast(`Loaded WinOLS definition: ${file.name} (${parsed.items.length} items)`);
              continue;
            }
            const buf = parseBinaryFile(file.name, rawBuf);
            const newId = `bin-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
            setOpenBins((prev) => [...prev, { id: newId, name: file.name, bytes: buf }]);
            if (asCompare) {
              setCompareBinId(newId);
              showToast(`Added comparison BIN: ${file.name}`);
            } else {
              setActiveBinId(newId);
              setOpenedSnapshot(buf.slice());
              setUndoStack([]);
              setRedoStack([]);
              const detected = detectChecksumPlugin(buf);
              setChecksumProfileId(detected.id);
              showToast(`Loaded BIN: ${file.name} (${Math.round(buf.length / 1024)} KB)`);
            }
          }
        } catch (err) {
          showToast(err instanceof Error ? `Failed to load ${file.name}: ${err.message}` : `Failed to load ${file.name}`);
        }
      }
    },
    [bin.length, showToast],
  );

  const handleSmartMergeFiles = useCallback(
    async (files: FileList | File[]) => {
      const file = Array.from(files)[0];
      if (!file) return;
      try {
        const lower = file.name.toLowerCase();
        const incoming =
          lower.endsWith('.ols') || lower.endsWith('.kp')
            ? importBinaryDefinition(file.name, new Uint8Array(await file.arrayBuffer()))
            : importDefinition(file.name, await file.text());
        if (!xdf) {
          setXdf(incoming);
          setXdfName(file.name);
          setSelectedItemId(incoming.items[0]?.id ?? null);
          showToast(`Loaded definition: ${file.name} (${incoming.items.length} items)`);
          return;
        }
        const merged = smartMergeDefinitions(xdf, incoming);
        setXdf(merged.document);
        showToast(
          `Smart-merged ${file.name}: ${merged.updatedCount} updated, ${merged.addedCount} added, ${merged.preservedCount} preserved`,
        );
      } catch (err) {
        showToast(err instanceof Error ? `Smart-Merge failed: ${err.message}` : 'Smart-Merge failed');
      }
    },
    [xdf, showToast],
  );

  const handleRunAutoAlign = useCallback(() => {
    if (!xdf) {
      showToast('Load a definition (XDF/A2L/OLS) before running Auto-Align');
      return;
    }
    const sourceBin = compareBin ?? openedSnapshot;
    const res = alignDefinition(xdf, sourceBin, bin);
    const confByItem: Record<number, number> = {};
    const deltaCounts = new Map<number, number>();
    let shiftedCount = 0;
    for (const [idStr, info] of Object.entries(res.infoByItemId)) {
      const id = Number(idStr);
      confByItem[id] = info.percent / 100;
      if (info.delta !== 0 && info.percent > 0) {
        shiftedCount++;
        deltaCounts.set(info.delta, (deltaCounts.get(info.delta) ?? 0) + 1);
      }
    }
    setAutoAlignConfidenceByItemId(confByItem);
    let dominantDelta = 0;
    let bestCount = 0;
    for (const [d, cnt] of deltaCounts.entries()) {
      if (cnt > bestCount) {
        bestCount = cnt;
        dominantDelta = d;
      }
    }
    if (shiftedCount > 0) {
      setAutoAlignBanner({ result: res, shiftedCount, dominantDelta });
      showToast(
        `Auto-Align found ${shiftedCount} shifted map(s) (${res.summary.highCount} high confidence)`,
      );
    } else {
      setAutoAlignBanner(null);
      showToast(
        `Auto-Align complete: definition already aligned (${res.summary.highCount}/${res.summary.total} high confidence)`,
      );
    }
  }, [xdf, compareBin, openedSnapshot, bin, showToast]);

  const handleLoadDemoWorkspace = useCallback(() => {
    const demo = createMed17DemoBundle();
    setOpenBins([
      { id: 'bin-stage1', name: demo.stage1Name, bytes: demo.stage1Bin },
      { id: 'bin-stock', name: demo.stockName, bytes: demo.stockBin },
    ]);
    setActiveBinId('bin-stage1');
    setCompareBinId('bin-stock');
    setOpenedSnapshot(demo.stage1Bin.slice());
    setXdf(demo.xdf);
    setXdfName(demo.xdfName);
    setSelectedItemId(demo.xdf.items[0]?.id ?? null);
    setIdeTabs(demo.xdf.items.slice(0, 3).map((it) => it.id));
    setChecksumProfileId(detectChecksumPlugin(demo.stage1Bin).id);
    setUndoStack([]);
    setRedoStack([]);
    setAutoAlignBanner(null);
    setAutoAlignConfidenceByItemId({});
    showToast('Loaded MED17.5 Demo Workspace');
  }, [showToast]);

  const handleExportDefinition = useCallback(
    (format: DefinitionExportFormat, ext: string) => {
      setExportDefMenuOpen(false);
      if (!xdf) {
        showToast('No XDF definition loaded to export');
        return;
      }
      const data = exportDefinition(xdf, format);
      const part: BlobPart = typeof data === 'string' ? data : data.slice().buffer;
      const mime =
        format === 'kp'
          ? 'application/octet-stream'
          : format === 'csv'
            ? 'text/csv;charset=utf-8'
            : format === 'a2l'
              ? 'text/plain;charset=utf-8'
              : 'application/xml;charset=utf-8';
      const blob = new Blob([part], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const base = stripExt(xdfName || 'MacTuner');
      a.href = url;
      a.download = `${base}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Exported ${a.download}`);
    },
    [xdf, xdfName, showToast],
  );

  const handleSaveProject = useCallback(() => {
    const safeRangesNum: Record<number, { min?: number; max?: number }> = {};
    for (const [k, v] of Object.entries(safeRanges)) {
      const n = Number(k);
      if (Number.isFinite(n)) safeRangesNum[n] = v;
    }
    const json = serializeProject({
      binName,
      bin,
      compareName: compareBin ? compareName : undefined,
      compareBin,
      xdfName: xdf ? xdfName : undefined,
      xdf,
      markers,
      lockedItemIds: Array.from(lockedItemIds),
      selectedProfileId: checksumProfileId,
      snapshots,
      favorites: Array.from(favorites).map(Number).filter(Number.isFinite),
      safeRanges: safeRangesNum,
      historyEntries: undoStack.map((entry, idx) => ({
        id: `h-${idx}-${entry.timestamp}`,
        label: entry.label,
        timestamp: entry.timestamp,
        changedBytes: entry.patches.reduce((sum, p) => sum + p.next.length, 0),
      })),
      openBins: openBins.map((b) => ({
        id: b.id,
        name: b.name,
        bytes: b.bytes,
        isActive: b.id === activeBinId,
      })),
      dismissedCandidateKeys: Array.from(dismissedCandidateKeys),
    });
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${stripExt(binName || 'MacTuner')}.mtproj`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Saved project ${a.download}`);
  }, [
    binName,
    bin,
    compareName,
    compareBin,
    xdfName,
    xdf,
    markers,
    lockedItemIds,
    checksumProfileId,
    snapshots,
    favorites,
    safeRanges,
    undoStack,
    openBins,
    activeBinId,
    dismissedCandidateKeys,
    showToast,
  ]);

  const handleDownloadBin = useCallback(() => {
    const outName = binName.toLowerCase().endsWith('.bin') ? binName : `${stripExt(binName)}_tuned.bin`;
    const blob = new Blob([bin.slice().buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = outName;
    a.click();
    URL.revokeObjectURL(url);
    setExportReviewOpen(false);
    showToast(`Exported ${outName} (${Math.round(bin.length / 1024)} KB)`);
  }, [bin, binName, showToast]);

  const handleExportIntelHex = useCallback(() => {
    const hexText = exportIntelHex(bin);
    const blob = new Blob([hexText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${stripExt(binName || 'MacTuner')}.hex`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported Intel HEX: ${a.download}`);
  }, [bin, binName, showToast]);

  const handleExportSRecord = useCallback(() => {
    const srecText = exportSRecord(bin);
    const blob = new Blob([srecText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${stripExt(binName || 'MacTuner')}.s19`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported Motorola S-Record: ${a.download}`);
  }, [bin, binName, showToast]);

  const handleSplitHiLo = useCallback(() => {
    const { hi, lo } = splitHiLo(bin);
    const base = stripExt(binName || 'MacTuner');
    const triggerDownload = (bytes: Uint8Array, name: string) => {
      const blob = new Blob([bytes.slice().buffer], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    };
    triggerDownload(hi, `${base}_HI.bin`);
    window.setTimeout(() => triggerDownload(lo, `${base}_LO.bin`), 150);
    showToast(`Exported HI (${Math.round(hi.length / 1024)} KB) & LO (${Math.round(lo.length / 1024)} KB) EPROM halves`);
  }, [bin, binName, showToast]);

  const handleJumpToHex = useCallback((address: number) => {
    setSection('workspace');
    setWorkbenchMode('hex');
    setJumpAddress(address);
    setHexJumpNonce((n) => n + 1);
  }, []);

  const handleFindTwins = useCallback(
    (range: [number, number]) => {
      const twins = findTwinMaps(bin, range, 5);
      if (twins.length === 0) {
        showToast('No twin maps found for selection');
        return;
      }
      const first = twins[0];
      setJumpAddress(first.address);
      showToast(
        `Found ${twins.length} twin map(s) — jumped to 0x${first.address.toString(16).toUpperCase()} (${Math.round(first.similarity * 100)}%)`,
      );
    },
    [bin, showToast],
  );

  const handleAutoFixDiagnostic = useCallback(
    (finding: DiagnosticFinding) => {
      if (finding.address !== undefined) {
        handleJumpToHex(finding.address);
        showToast(`Jumped to diagnostic: ${finding.title}`);
      } else if (finding.itemId !== undefined) {
        selectMapById(finding.itemId);
      }
    },
    [handleJumpToHex, selectMapById, showToast],
  );

  const handleDatalogOverlayChange = useCallback((overlay: DatalogOverlayState) => {
    setRawDatalogOverlay(overlay);
  }, []);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (mod && key === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && key === 's') {
        e.preventDefault();
        setExportReviewOpen(true);
        return;
      }
      if (mod && e.shiftKey && key === 's') {
        e.preventDefault();
        handleSaveProject();
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && key === 'o') {
        e.preventDefault();
        fileInputRef.current?.click();
        return;
      }
      if (mod && e.shiftKey && key === 'o') {
        e.preventDefault();
        compareInputRef.current?.click();
        return;
      }
      if (mod && e.altKey && key === 'i') {
        e.preventDefault();
        setInspectorCollapsed((v) => !v);
        return;
      }
      if (mod && e.shiftKey && key === 'y') {
        e.preventDefault();
        setBottomDrawerOpen((v) => !v);
        return;
      }
      if (mod && e.shiftKey && key === 'e') {
        e.preventDefault();
        setExportReviewOpen(true);
        return;
      }
      if (mod && key === 'p') {
        e.preventDefault();
        window.print();
        return;
      }
      if (mod && key === '0') {
        e.preventDefault();
        setSection('overview');
        return;
      }
      if (!isInput && mod && !e.shiftKey && !e.altKey && (key === '1' || key === '2' || key === '3')) {
        e.preventDefault();
        setSidebarTab('maps');
        setSidebarMapScope(key === '1' ? 'all' : key === '2' ? 'changed' : 'favorites');
        return;
      }
      if (mod && e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        handleCycleChangedMap(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (!isInput && mod && key === 'd') {
        e.preventDefault();
        handleToggleFavoriteSelected();
        return;
      }
      if (!isInput && mod && key === 'l') {
        e.preventDefault();
        handleToggleLockSelected();
        return;
      }
      if (!isInput && mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    handleSaveProject,
    handleUndo,
    handleRedo,
    handleCycleChangedMap,
    handleToggleFavoriteSelected,
    handleToggleLockSelected,
  ]);

  // Native Tauri menu bar event listener (mounted once via ref so edits never drop menu events!)
  const menuDispatchRef = useRef<(payload: string) => void>(() => {});
  menuDispatchRef.current = (payload: string) => {
    switch (payload) {
      case 'check-updates': setUpdateModalOpen(true); void runUpdateCheck(); break;
      case 'open-file': fileInputRef.current?.click(); break;
      case 'open-compare': compareInputRef.current?.click(); break;
      case 'save-project': handleSaveProject(); break;
      case 'export-bin': setExportReviewOpen(true); break;
      case 'export-xdf': handleExportDefinition('xdf', 'xdf'); break;
      case 'print-report': window.print(); break;
      case 'edit-undo': handleUndo(); break;
      case 'edit-redo': handleRedo(); break;
      case 'view-overview': setSection('overview'); break;
      case 'view-hex': setSection('workspace'); setWorkbenchMode('hex'); break;
      case 'view-map': setSection('workspace'); setWorkbenchMode('map'); break;
      case 'view-compare': setSection('compare'); break;
      case 'view-memory': setSection('memory'); break;
      case 'view-flash': setSection('flash'); break;
      case 'toggle-bottom-drawer': setBottomDrawerOpen((v) => !v); break;
      case 'toggle-inspector': setInspectorCollapsed((v) => !v); break;
      case 'toggle-favorite': handleToggleFavoriteSelected(); break;
      case 'next-changed-map': handleCycleChangedMap(1); break;
      case 'prev-changed-map': handleCycleChangedMap(-1); break;
      case 'command-palette': setPaletteOpen((v) => !v); break;
      case 'fix-checksums': handleFixChecksums(); break;
      case 'swap-bins': handleSwapBins(); break;
    }
  };

  useEffect(() => {
    const tauriGlobal = (window as unknown as {
      __TAURI__?: {
        event?: {
          listen: (event: string, cb: (ev: { payload: string }) => void) => Promise<() => void>;
        };
      };
    }).__TAURI__;
    if (!tauriGlobal?.event?.listen) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void tauriGlobal.event
      .listen('mactuner-menu', (ev) => {
        menuDispatchRef.current(ev.payload);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const navItems: Array<{ id: TopSection; label: string; icon: React.ReactNode }> = [
    { id: 'overview', label: t('Overview'), icon: <LayoutDashboard className="h-3.5 w-3.5" /> },
    { id: 'workspace', label: t('Workspace'), icon: <Layers className="h-3.5 w-3.5" /> },
    { id: 'compare', label: t('Compare'), icon: <Columns3 className="h-3.5 w-3.5" /> },
    { id: 'discovery', label: t('Discovery'), icon: <Search className="h-3.5 w-3.5" /> },
    { id: 'memory', label: t('Memory'), icon: <HardDrive className="h-3.5 w-3.5" /> },
    { id: 'recipes', label: t('Recipes'), icon: <Sparkles className="h-3.5 w-3.5" /> },
    { id: 'datalog', label: t('Datalog'), icon: <Activity className="h-3.5 w-3.5" /> },
    { id: 'flash', label: t('Flash'), icon: <ShieldCheck className="h-3.5 w-3.5" /> },
  ];

  const favoriteNumericIds = useMemo(
    () => Array.from(favorites).map(Number).filter(Number.isFinite),
    [favorites],
  );

  const showSplitMapView =
    section === 'workspace' &&
    workbenchMode === 'map' &&
    selectedItem !== null &&
    pinnedItem !== null &&
    pinnedItem.id !== selectedItem.id;

  const shortLocaleCode =
    locale === 'zh-Hans'
      ? 'ZH'
      : locale === 'zh-Hant'
        ? 'TW'
        : locale.slice(0, 2).toUpperCase();

  return (
    <I18nProvider locale={locale} setLocale={handleLocaleChange}>
    <div
      className="flex h-screen w-screen flex-col overflow-hidden bg-[#0c0d10] text-[#e6eaf2]"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingFile(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setIsDraggingFile(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDraggingFile(false);
        if (e.dataTransfer.files.length > 0) void handleFiles(e.dataTransfer.files, e.shiftKey);
      }}
    >
      {/* Hidden file pickers */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".bin,.ori,.mod,.hex,.ihx,.s19,.s28,.s37,.srec,.mot,.xdf,.xml,.a2l,.csv,.ols,.kp,.mtproj"
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void handleFiles(e.target.files, false);
          e.target.value = '';
        }}
      />
      <input
        ref={compareInputRef}
        type="file"
        accept=".bin,.ori,.mod,.hex,.ihx,.s19,.s28,.s37,.srec,.mot"
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void handleFiles(e.target.files, true);
          e.target.value = '';
        }}
      />
      <input
        ref={smartMergeInputRef}
        type="file"
        accept=".xdf,.xml,.a2l,.csv,.ols,.kp"
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void handleSmartMergeFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {/* Web-only Apple Pro Menu Bar (auto-hidden on Tauri Desktop) */}
      <WebMenuBar
        version={APP_VERSION}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        hasCompareBin={Boolean(compareBin)}
        hasDefinition={Boolean(xdf)}
        hasSelectedItem={Boolean(selectedItem)}
        layoutMode={layoutMode}
        heatmapPalette={heatmapPalette}
        unitSystem={unitSystem}
        bottomDrawerOpen={bottomDrawerOpen}
        inspectorOpen={section === 'workspace' && !inspectorCollapsed}
        onAbout={() => showToast(`MacTuner Studio v${APP_VERSION} — ECU & TCU Calibration Workbench`)}
        onCheckUpdates={() => {
          setUpdateModalOpen(true);
          void runUpdateCheck();
        }}
        onLoadDemo={handleLoadDemoWorkspace}
        onOpenBin={() => fileInputRef.current?.click()}
        onOpenCompareBin={() => compareInputRef.current?.click()}
        onOpenDefinition={() => fileInputRef.current?.click()}
        onSmartMergeDefinition={() => smartMergeInputRef.current?.click()}
        onOpenProject={() => fileInputRef.current?.click()}
        onSaveProject={handleSaveProject}
        onExportBin={() => setExportReviewOpen(true)}
        onExportIntelHex={handleExportIntelHex}
        onExportSRecord={handleExportSRecord}
        onExportDefinition={handleExportDefinition}
        onPrint={() => window.print()}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onSwapBins={handleSwapBins}
        onToggleFavorite={handleToggleFavoriteSelected}
        onToggleLock={handleToggleLockSelected}
        onSplitHiLo={handleSplitHiLo}
        onSwitchSection={(sec, mode) => {
          setSection(sec);
          if (mode) setWorkbenchMode(mode);
        }}
        onToggleBottomDrawer={() => setBottomDrawerOpen((v) => !v)}
        onToggleInspector={() => {
          if (section !== 'workspace') {
            setSection('workspace');
            setInspectorCollapsed(false);
          } else {
            setInspectorCollapsed((v) => !v);
          }
        }}
        onSetLayoutMode={(m) => {
          setLayoutMode(m);
          if (m === 'ide') setBottomDrawerOpen(true);
        }}
        onSetHeatmapPalette={handleHeatmapPaletteChange}
        onSetUnitSystem={setUnitSystem}
        onNextChangedMap={() => handleCycleChangedMap(1)}
        onPrevChangedMap={() => handleCycleChangedMap(-1)}
        onFixChecksums={handleFixChecksums}
        onQuickSnapshot={handleQuickSnapshot}
        onAutoAlign={handleRunAutoAlign}
        onOpenCommandPalette={() => setPaletteOpen(true)}
      />

      {/* Top Native-Style Title & Workbench Bar */}
      <header className="relative z-[60] flex h-11 shrink-0 items-center justify-between gap-1.5 border-b border-white/[0.065] bg-[#131418]/95 px-2.5 backdrop-blur-xl">
        <div className="flex items-center gap-2 min-w-0 shrink">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-b from-[#2b95ff] to-[#0066dc] shadow-[0_2px_10px_rgba(10,132,255,0.35),inset_0_1px_0_rgba(255,255,255,0.28)]">
            <Cpu className="h-3.5 w-3.5 text-white" />
          </div>
          <div className="min-w-0 leading-tight">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[12px] font-semibold tracking-[-0.01em] text-white max-w-[130px] xl:max-w-[160px]">
                {binName}
              </span>
              {undoStack.length > 0 && (
                <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-300 shrink-0">
                  {t('edited')}
                </span>
              )}
            </div>
            <div className="truncate text-[10px] text-zinc-400">
              {ecuIdentity.ecuFamily} · MacTuner
            </div>
          </div>
        </div>

        {/* Center Apple Pro Segmented Navigation (all 8 tabs visible at 1280x800 with zero clipping) */}
        <nav className="flex items-center gap-0.5 rounded-full border border-white/[0.07] bg-white/[0.035] p-0.5 shrink-0">
          {navItems.map((n) => {
            const active = section === n.id;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => setSection(n.id)}
                className={`flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium transition-all shrink-0 cursor-pointer ${
                  active
                    ? 'bg-[#0a84ff] text-white shadow-[0_1px_8px_rgba(10,132,255,0.4)]'
                    : 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100'
                }`}
              >
                {n.icon}
                <span>{n.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Right Quick Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            title={`${t('Command Palette…')} (⌘K)`}
            className="flex items-center gap-1 rounded-lg bg-white/[0.05] px-1.5 py-1.5 text-[11px] text-zinc-300 hover:bg-white/[0.09] hover:text-white transition cursor-pointer"
          >
            <Search className="h-3.5 w-3.5 text-zinc-400" />
            <kbd className="font-mono text-[10px] text-zinc-400 hidden 2xl:inline">⌘K</kbd>
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title={t('Open XDF, A2L/KP, BIN, Project, or Datalog')}
            className="flex items-center gap-1 rounded-lg bg-white/[0.05] px-2 py-1.5 text-[11px] text-zinc-200 hover:bg-white/[0.09] transition cursor-pointer"
          >
            <FolderOpen className="h-3.5 w-3.5 text-zinc-400" />
            <span className="hidden 2xl:inline">{t('Open')}</span>
          </button>
          <button
            type="button"
            onClick={handleUndo}
            disabled={undoStack.length === 0}
            title={`${t('Undo')} (⌘Z)`}
            className="rounded-lg bg-white/[0.04] p-1.5 text-zinc-300 hover:bg-white/[0.09] disabled:opacity-25 transition cursor-pointer disabled:cursor-not-allowed"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleRedo}
            disabled={redoStack.length === 0}
            title={`${t('Redo')} (⇧⌘Z)`}
            className="rounded-lg bg-white/[0.04] p-1.5 text-zinc-300 hover:bg-white/[0.09] disabled:opacity-25 transition cursor-pointer disabled:cursor-not-allowed"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </button>

          {/* Export Def Dropdown (.xdf, .a2l, .csv, .kp, .xml) */}
          <div ref={exportDefRef} className="relative">
            <button
              type="button"
              onClick={() => setExportDefMenuOpen((v) => !v)}
              title={t('Export Definition')}
              className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition cursor-pointer ${
                exportDefMenuOpen
                  ? 'bg-white/[0.12] text-white'
                  : 'bg-white/[0.05] text-zinc-200 hover:bg-white/[0.09]'
              }`}
            >
              <Download className="h-3.5 w-3.5 text-zinc-400" />
              <span className="hidden 2xl:inline">{t('Export Def')}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
            {exportDefMenuOpen && (
              <div className="glass-popover absolute right-0 top-full mt-1.5 z-40 w-56 rounded-xl py-1">
                <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500 border-b border-white/[0.06]">
                  {t('Export Definition')}
                </div>
                {DEF_EXPORT_OPTIONS.map((opt) => (
                  <button
                    key={opt.format}
                    type="button"
                    onClick={() => handleExportDefinition(opt.format, opt.ext)}
                    className="w-full px-3 py-2 text-left hover:bg-white/[0.08] transition-colors cursor-pointer"
                  >
                    <div className="text-xs font-medium text-zinc-100">{t(opt.label)}</div>
                    <div className="text-[10px] text-zinc-400">{t(opt.desc)}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Export BIN -> PreSaveReviewModal */}
          <button
            type="button"
            onClick={() => setExportReviewOpen(true)}
            title={`${t('Export BIN…')} (⌘S)`}
            className="flex items-center gap-1 rounded-lg bg-[#0a84ff] px-2 py-1.5 text-[11px] font-semibold text-white hover:bg-[#1e8fff] shadow-[0_1px_8px_rgba(10,132,255,0.35)] transition cursor-pointer"
          >
            <FileDown className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">{t('Export')}</span>
          </button>

          {/* Compact Top-Right Language Chooser */}
          <div ref={langMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setLangMenuOpen((v) => !v)}
              title={t('Language')}
              aria-label={t('Language')}
              aria-expanded={langMenuOpen}
              className={`flex items-center gap-1 rounded-lg px-1.5 py-1.5 text-[10.5px] font-semibold tracking-wide transition cursor-pointer ${
                langMenuOpen
                  ? 'bg-[#0a84ff]/25 text-sky-200 border border-[#0a84ff]/40'
                  : 'bg-white/[0.05] text-zinc-200 hover:bg-white/[0.09] hover:text-white'
              }`}
            >
              <Globe className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              <span className="font-mono text-[10px]">{shortLocaleCode}</span>
            </button>
            {langMenuOpen && (
              <div
                role="menu"
                className="glass-popover absolute right-0 top-full mt-1.5 z-50 w-48 max-h-72 overflow-y-auto rounded-xl py-1 shadow-2xl border border-white/[0.1] bg-[#16181e]/95 backdrop-blur-xl"
              >
                <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500 border-b border-white/[0.06]">
                  {t('Language')}
                </div>
                {AVAILABLE_LOCALES.map((loc) => {
                  const selected = loc.code === locale;
                  return (
                    <button
                      key={loc.code}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        handleLocaleChange(loc.code);
                        setLangMenuOpen(false);
                      }}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition-colors cursor-pointer ${
                        selected
                          ? 'bg-[#0a84ff]/20 text-white font-medium'
                          : 'text-zinc-200 hover:bg-white/[0.08] hover:text-white'
                      }`}
                    >
                      <span className="truncate">{loc.name}</span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        <span className="font-mono text-[9.5px] uppercase text-zinc-500">
                          {loc.code}
                        </span>
                        {selected && <Check className="h-3 w-3 text-[#0a84ff]" />}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right Inspector Toggle */}
          <button
            type="button"
            onClick={() => {
              if (section !== 'workspace') {
                setSection('workspace');
                setInspectorCollapsed(false);
              } else {
                setInspectorCollapsed((v) => !v);
              }
            }}
            title={`${t('Toggle Inspector')} (⌥⌘I)`}
            className={`rounded-lg p-1.5 transition cursor-pointer ${
              section === 'workspace' && !inspectorCollapsed
                ? 'bg-[#0a84ff]/20 text-sky-300 border border-[#0a84ff]/35'
                : 'bg-white/[0.05] text-zinc-300 hover:bg-white/[0.09] hover:text-white'
            }`}
          >
            <PanelRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* Auto-Align Banner when non-zero shift is detected */}
      {autoAlignBanner && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-sky-500/25 bg-sky-500/10 px-3.5 py-1.5 text-[11.5px] text-sky-200">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="h-3.5 w-3.5 text-sky-400 shrink-0" />
            <span className="truncate">
              {t('Auto-Align Definition')}:{' '}
              <strong className="font-semibold text-white">{autoAlignBanner.shiftedCount}</strong>
              {autoAlignBanner.dominantDelta !== 0 && (
                <>
                  {' '}
                  (
                  <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[10.5px] text-sky-300">
                    {autoAlignBanner.dominantDelta >= 0 ? '+' : '-'}0x
                    {Math.abs(autoAlignBanner.dominantDelta).toString(16).toUpperCase()}
                  </code>
                  )
                </>
              )}{' '}
              · {autoAlignBanner.result.summary.highCount} / {autoAlignBanner.result.summary.mediumCount}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                setXdf(autoAlignBanner.result.alignedDefinition);
                setAutoAlignBanner(null);
                showToast(`Applied Auto-Align shift to ${autoAlignBanner.shiftedCount} map(s)`);
              }}
              className="rounded-md bg-[#0a84ff] px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-[#1e8fff] transition cursor-pointer"
            >
              {t('Apply')}
            </button>
            <button
              type="button"
              onClick={() => setAutoAlignBanner(null)}
              className="rounded-md bg-white/[0.07] px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-white/[0.12] hover:text-white transition cursor-pointer"
            >
              {t('Discard')}
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area: Sidebar + Multi-BIN Document Bar + Viewport + BottomDrawer (+ Optional Inspector) */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {layoutMode !== 'canvas' && (
          <Sidebar
            mode={workbenchMode}
            isWorkspaceActive={section === 'workspace'}
            onModeChange={(m) => {
              setWorkbenchMode(m);
              setSection('workspace');
            }}
            xdf={xdf}
            selectedItemId={selectedItem?.id ?? null}
            onSelectItem={(item) => selectMapById(item.id)}
            changedItemIds={changedItemIds}
            diffClusters={clusters}
            onJumpToAddress={(addr, toHex) => {
              setJumpAddress(addr);
              if (toHex !== false) {
                setSection('workspace');
                setWorkbenchMode('hex');
              }
            }}
            detectedCandidates={uiCandidates}
            onSelectCandidate={(cand) => {
              setJumpAddress(cand.address);
              setSection('workspace');
              setWorkbenchMode('hex');
            }}
            onAddCandidateToXdf={(cand) => handleAddCoreCandidate(fromUiCandidate(cand), true)}
            markers={markers}
            onDeleteMarker={(id) => setMarkers((prev) => prev.filter((m) => m.id !== id))}
            activeTab={sidebarTab}
            onTabChange={setSidebarTab}
            mapScope={sidebarMapScope}
            onMapScopeChange={setSidebarMapScope}
            favoriteIds={favorites}
            onToggleFavorite={handleToggleFavoriteItem}
            lockedItemIds={lockedItemIds}
            onToggleLock={handleToggleLockItem}
            pinnedItemId={pinnedItemId}
            onTogglePin={handleTogglePinItem}
            outOfSafeRangeItemIds={outOfSafeRangeItemIds}
            diagnosticWarningItemIds={diagnosticWarningItemIds}
            autoAlignConfidenceByItemId={autoAlignConfidenceByItemId}
            translationMode={translationMode}
            outsideOfXdfBytes={outsideOfXdfBytes}
            onClickOutsideOfXdf={() => {
              if (outsideClusters[0]) handleJumpToHex(outsideClusters[0].start);
              else setSection('overview');
            }}
            diffClusterGap={diffClusterGap}
            onDiffClusterGapChange={setDiffClusterGap}
            onCopyMapFromCompare={handleResetMap}
            onResetMap={handleResetMap}
            onEditMapInXdfModal={(item) => handleOpenXdfEditor(item)}
            onDeleteMap={(item) => handleDeleteXdfItem(item.id)}
            onCreateXdfFromDiff={(cluster) => {
              const span = Math.max(1, cluster.end - cluster.start);
              const cols = span >= 32 ? 16 : Math.max(1, Math.floor(span / 2));
              const rows = Math.max(1, Math.floor(span / (cols * 2)));
              handleOpenXdfEditor(null, {
                title: `Diff @ 0x${cluster.start.toString(16).toUpperCase()}`,
                data: {
                  address: cluster.start,
                  rows,
                  cols,
                  bits: 16,
                  signed: false,
                  lsbFirst: true,
                  columnMajor: false,
                  isFloat: false,
                },
              });
            }}
            onCopyDiffFromCompare={(cluster) => {
              if (!compareBin) return;
              const next = compareBin.slice(cluster.start, cluster.end);
              const old = bin.slice(cluster.start, cluster.end);
              handleApplyPatches(
                [{ offset: cluster.start, old, next }],
                `Copied diff 0x${cluster.start.toString(16).toUpperCase()} from Compare`,
              );
            }}
            onEditCandidateInXdfModal={(cand) => {
              const item = candidateToXDFItem(fromUiCandidate(cand), -1);
              handleOpenXdfEditor(null, item);
            }}
            onIgnoreCandidate={(cand) => {
              setDismissedCandidateKeys((prev) => {
                const next = new Set(prev);
                next.add(candidateKey(cand));
                return next;
              });
              showToast(`Ignored candidate @ 0x${cand.address.toString(16).toUpperCase()}`);
            }}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Multi-BIN Document Bar */}
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#101115] px-3 gap-2">
            <div className="flex items-center gap-1.5 overflow-x-auto min-w-0">
              {xdf && (
                <span className="flex items-center gap-1.5 rounded-md bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-zinc-300 shrink-0">
                  <span className="h-1.5 w-1.5 rounded-full bg-purple-400" />
                  {xdfName}
                </span>
              )}
              {openBins.map((doc) => {
                const isL = doc.id === activeBinId;
                const isR = doc.id === compareBinId;
                return (
                  <div
                    key={doc.id}
                    className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium shrink-0 transition ${
                      isL
                        ? 'bg-[#0a84ff]/20 text-white border border-[#0a84ff]/40'
                        : isR
                          ? 'bg-amber-500/15 text-amber-200 border border-amber-500/30'
                          : 'bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setActiveBinId(doc.id);
                        setOpenedSnapshot(doc.bytes.slice());
                        setUndoStack([]);
                        setRedoStack([]);
                        setChecksumProfileId(detectChecksumPlugin(doc.bytes).id);
                      }}
                      title="Click to activate as Left (L) BIN"
                      className="flex items-center gap-1 cursor-pointer"
                    >
                      {isL && (
                        <span className="rounded bg-[#0a84ff] px-1 text-[9px] font-bold text-white">L</span>
                      )}
                      {isR && (
                        <span className="rounded bg-amber-500 px-1 text-[9px] font-bold text-black">R</span>
                      )}
                      <span className="max-w-[140px] truncate">{doc.name}</span>
                    </button>
                    {!isL && (
                      <button
                        type="button"
                        onClick={() => setCompareBinId(isR ? null : doc.id)}
                        title={isR ? 'Unset Compare (R)' : 'Set as Compare (R) BIN'}
                        className="ml-0.5 rounded px-1 text-[9px] font-mono text-zinc-400 hover:bg-white/10 hover:text-amber-300 cursor-pointer"
                      >
                        {isR ? 'R✓' : 'R'}
                      </button>
                    )}
                    {openBins.length > 1 && (
                      <button
                        type="button"
                        onClick={() => {
                          setOpenBins((prev) => {
                            const next = prev.filter((b) => b.id !== doc.id);
                            if (activeBinId === doc.id && next[0]) {
                              setActiveBinId(next[0].id);
                              setOpenedSnapshot(next[0].bytes.slice());
                            }
                            if (compareBinId === doc.id) {
                              setCompareBinId(null);
                            }
                            return next;
                          });
                        }}
                        title={t('Close from Workspace')}
                        className="ml-0.5 text-zinc-500 hover:text-rose-400 cursor-pointer"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {compareBin && (
                <button
                  type="button"
                  onClick={handleSwapBins}
                  title={t('Swap Active & Comparison BIN')}
                  className="rounded-md p-1 text-zinc-400 hover:bg-white/[0.06] hover:text-white transition cursor-pointer"
                >
                  <ArrowLeftRight className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => compareInputRef.current?.click()}
                title={t('Add BIN…')}
                className="flex items-center gap-1 rounded-md bg-white/[0.05] px-2 py-0.5 text-[11px] font-medium text-zinc-300 hover:bg-white/[0.09] hover:text-white transition cursor-pointer"
              >
                {t('+ BIN')}
              </button>
            </div>
          </div>

          {/* IDE Mode Closable Map Tabs */}
          {layoutMode === 'ide' && section === 'workspace' && workbenchMode === 'map' && ideTabs.length > 0 && (
            <div className="flex h-7 shrink-0 items-center gap-1 border-b border-white/[0.06] bg-[#121318] px-2 overflow-x-auto">
              {ideTabs.map((tid) => {
                const it = xdf?.items.find((x) => x.id === tid);
                if (!it) return null;
                const active = selectedItem?.id === tid;
                return (
                  <div
                    key={tid}
                    className={`flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] shrink-0 ${
                      active ? 'bg-white/[0.1] text-white' : 'text-zinc-400 hover:bg-white/[0.05]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedItemId(tid)}
                      className="max-w-[160px] truncate cursor-pointer"
                    >
                      {it.title}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIdeTabs((prev) => prev.filter((id) => id !== tid));
                        if (selectedItemId === tid) {
                          const remaining = ideTabs.filter((id) => id !== tid);
                          if (remaining[0] !== undefined) setSelectedItemId(remaining[0]);
                        }
                      }}
                      className="text-zinc-500 hover:text-white cursor-pointer"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Active Workbench Pane (+ Collapsible Right Inspector in Workspace) */}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden flex flex-col">
                {/* Workspace: Hex-Diff (kept mounted so scroll position & view state survive tab/mode switches) */}
                <div
                  className={
                    section === 'workspace' && workbenchMode === 'hex'
                      ? 'flex-1 min-h-0 flex flex-col overflow-hidden'
                      : 'hidden'
                  }
                >
                  <HexDiffCanvas
                      bin={bin}
                      compareBin={compareBin}
                      binName={binName}
                      compareName={compareName}
                      definition={xdf}
                      candidates={coreCandidates}
                      jumpAddress={jumpAddress}
                      jumpNonce={hexJumpNonce}
                      cols={hexCols}
                      onColsChange={setHexCols}
                      selectedRange={selectedRange}
                      onSelectRange={setSelectedRange}
                      onAddCandidateToXdf={handleAddCoreCandidate}
                      onSelectXdfItem={selectMapById}
                      onApplyPatch={handleApplySinglePatch}
                      onFindTwins={handleFindTwins}
                      bookmarks={markers}
                      onAddBookmark={handleAddBookmark}
                      onClearBookmarks={handleClearBookmarks}
                      onOpenXdfModalForSelection={(range, cols, format) => {
                        const [start, end] = range;
                        const { bits, lsbFirst, isFloat } = wordFormatToLayout(format);
                        const elemBytes = bits / 8;
                        const byteLen = Math.max(1, end - start);
                        const totalElems = Math.max(1, Math.floor(byteLen / elemBytes));
                        const safeCols = Math.max(1, Math.min(cols, totalElems));
                        const rows = Math.max(1, Math.floor(totalElems / safeCols));
                        handleOpenXdfEditor(null, {
                          title: `Selection @ 0x${start.toString(16).toUpperCase()}`,
                          data: {
                            address: start,
                            rows,
                            cols: safeCols,
                            bits,
                            signed: false,
                            lsbFirst,
                            columnMajor: false,
                            isFloat,
                          },
                        });
                      }}
                      onOpenXdfModalForCandidate={(cand) => {
                        const item = candidateToXDFItem(cand, -1);
                        handleOpenXdfEditor(null, item);
                      }}
                      onIgnoreCandidate={(cand) => {
                        setDismissedCandidateKeys((prev) => {
                          const next = new Set(prev);
                          next.add(candidateKey(cand));
                          return next;
                        });
                        showToast(`Ignored candidate @ 0x${cand.address.toString(16).toUpperCase()}`);
                      }}
                      dismissedCandidateKeys={dismissedCandidateKeys}
                      onRestoreDismissed={() => {
                        setDismissedCandidateKeys(new Set());
                        showToast('Restored all dismissed candidates');
                      }}
                      onRescanCandidates={() => {
                        setCandidateScanNonce((n) => n + 1);
                        showToast('Rescanned binary for map candidates');
                      }}
                      heatmapPalette={heatmapPalette}
                      onPatchBytes={handleApplySinglePatch}
                      isVisible={section === 'workspace' && workbenchMode === 'hex'}
                    />
                </div>

                {section === 'workspace' && workbenchMode === 'map' && selectedItem && (
                  <div
                    className={`flex-1 min-h-0 overflow-hidden ${
                      showSplitMapView ? 'grid grid-cols-2 divide-x divide-white/[0.08]' : 'flex flex-col'
                    }`}
                  >
                    <div className="min-h-0 min-w-0 flex-1 flex flex-col overflow-hidden">
                      <MapEditorView
                        item={selectedItem}
                        bin={bin}
                        compareBin={compareBin}
                        onApplyPatches={(patches, label) =>
                          handleApplyPatchesWithMirror(patches, label, selectedItem)
                        }
                        onJumpToHex={handleJumpToHex}
                        onResetMap={handleResetMap}
                        categoryName={
                          selectedItem.categories[0] !== undefined
                            ? xdf?.categories[selectedItem.categories[0]]
                            : undefined
                        }
                        isLocked={isSelectedLocked}
                        onToggleLock={handleToggleLockSelected}
                        onOpenXdfEditor={() => handleOpenXdfEditor(selectedItem)}
                        xdf={xdf}
                        onSelectMap={selectMapById}
                        heatmapPalette={heatmapPalette}
                        isFavorite={favorites.has(String(selectedItem.id))}
                        onToggleFavorite={handleToggleFavoriteSelected}
                        safeRange={safeRanges[String(selectedItem.id)]}
                        onUpdateSafeRange={(range) =>
                          setSafeRanges((prev) => {
                            const next = { ...prev };
                            if (range) next[String(selectedItem.id)] = range;
                            else delete next[String(selectedItem.id)];
                            return next;
                          })
                        }
                        isPinned={pinnedItemId === selectedItem.id}
                        splitPinnedActive={Boolean(pinnedItemId)}
                        onTogglePin={() => handleTogglePinItem(selectedItem)}
                        mirrorPinnedEdits={mirrorPinnedEdits}
                        onToggleMirrorPinned={() => setMirrorPinnedEdits((v) => !v)}
                        openBins={openBins}
                        activeBinId={activeBinId}
                        unitSystem={unitSystem}
                        onCopyMapFrom={(src) => handleCopyMapFromSource(selectedItem, src)}
                        datalogHits={datalogOverlay.hits}
                        datalogActiveCell={datalogOverlay.activeCell}
                        datalogPoints={datalogOverlay.points3d}
                      />
                    </div>

                    {showSplitMapView && pinnedItem && (
                      <div className="min-h-0 min-w-0 flex-1 flex flex-col overflow-hidden">
                        <div className="flex h-7 shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#121319] px-3 text-[11px] text-sky-300">
                          <span className="flex items-center gap-1.5 font-medium truncate">
                            <Pin className="h-3 w-3 shrink-0" />
                            <span>{t('Pinned Split')}: {pinnedItem.title}</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => setPinnedItemId(null)}
                            className="text-zinc-400 hover:text-white cursor-pointer"
                            title={t('Close split view')}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-hidden flex flex-col">
                          <MapEditorView
                            item={pinnedItem}
                            bin={bin}
                            compareBin={compareBin}
                            onApplyPatches={(patches, label) =>
                              handleApplyPatchesWithMirror(patches, label, pinnedItem)
                            }
                            onJumpToHex={handleJumpToHex}
                            onResetMap={handleResetMap}
                            categoryName={
                              pinnedItem.categories[0] !== undefined
                                ? xdf?.categories[pinnedItem.categories[0]]
                                : undefined
                            }
                            isLocked={lockedItemIds.has(pinnedItem.id)}
                            onToggleLock={() => handleToggleLockItem(pinnedItem)}
                            onOpenXdfEditor={() => handleOpenXdfEditor(pinnedItem)}
                            xdf={xdf}
                            onSelectMap={selectMapById}
                            heatmapPalette={heatmapPalette}
                            isFavorite={favorites.has(String(pinnedItem.id))}
                            onToggleFavorite={() => handleToggleFavoriteItem(pinnedItem)}
                            safeRange={safeRanges[String(pinnedItem.id)]}
                            isPinned
                            splitPinnedActive={Boolean(pinnedItemId)}
                            onTogglePin={() => setPinnedItemId(null)}
                            mirrorPinnedEdits={mirrorPinnedEdits}
                            onToggleMirrorPinned={() => setMirrorPinnedEdits((v) => !v)}
                            openBins={openBins}
                            activeBinId={activeBinId}
                            unitSystem={unitSystem}
                            onCopyMapFrom={(src) => handleCopyMapFromSource(pinnedItem, src)}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Always-Mounted Sections (Zero State-Wipe when switching tabs!) */}
                <div className={section === 'overview' ? 'flex-1 min-h-0 flex flex-col overflow-hidden' : 'hidden'}>
                  <OverviewView
                    bytes={bin}
                    baselineBytes={compareBin}
                    fileName={binName}
                    compareName={compareName}
                    xdf={xdf}
                    checksumBlocks={uiChecksumBlocks}
                    invalidChecksumCount={checksumReport.invalidCount}
                    favorites={favoriteNumericIds}
                    outsideClusters={outsideClusters}
                    onSelectMap={selectMapById}
                    onJumpToHex={handleJumpToHex}
                    onSwitchSection={(sec, mode) => {
                      setSection(sec as TopSection);
                      if (mode) setWorkbenchMode(mode);
                    }}
                  />
                </div>

                <div className={section === 'compare' ? 'flex-1 min-h-0 flex flex-col overflow-hidden' : 'hidden'}>
                  <MultiCompareView
                    bin={bin}
                    binName={binName}
                    compareBin={compareBin}
                    compareName={compareName}
                    xdf={xdf}
                    snapshots={snapshots}
                    onSelectMap={selectMapById}
                    onJumpToHex={handleJumpToHex}
                    onAddExtraBin={(name, bytes) => {
                      const id = `bin-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
                      setOpenBins((prev) => [...prev, { id, name, bytes }]);
                      showToast(`Added ${name} to open BINs`);
                    }}
                    onOpenPairInHex={(baseBytes, cmpBytes, addr, bName, cName) => {
                      const bId = `pair-l-${Date.now()}`;
                      const cId = `pair-r-${Date.now()}`;
                      setOpenBins((prev) => [
                        ...prev,
                        { id: bId, name: bName, bytes: baseBytes },
                        { id: cId, name: cName, bytes: cmpBytes },
                      ]);
                      setActiveBinId(bId);
                      setCompareBinId(cId);
                      setOpenedSnapshot(baseBytes.slice());
                      setUndoStack([]);
                      setRedoStack([]);
                      setChecksumProfileId(detectChecksumPlugin(baseBytes).id);
                      handleJumpToHex(addr);
                    }}
                    onPortTune={() => setSection('discovery')}
                    onSwitchSection={(sec) => setSection(sec as TopSection)}
                    externalSlotToAdd={pendingCompareSlot}
                    onExternalSlotConsumed={() => setPendingCompareSlot(null)}
                  />
                </div>

                <div className={section === 'discovery' ? 'flex-1 min-h-0 flex flex-col overflow-hidden' : 'hidden'}>
                  <DiscoveryView
                    bytes={bin}
                    baselineBytes={compareBin}
                    xdf={xdf}
                    candidates={uiCandidates}
                    onCandidatesChange={setCustomUiCandidates}
                    onShowInHex={handleJumpToHex}
                    onAddCandidateToXdf={(cand) => handleAddCoreCandidate(fromUiCandidate(cand), true)}
                    onOpenXdfModal={(item) => handleOpenXdfEditor(null, item)}
                    onPatchBytes={handleApplyPatches}
                    onReplaceBytes={replaceBytesWithHistory}
                    onAddXdfItem={handleSaveXdfItem}
                    fileName={binName}
                  />
                </div>

                <div className={section === 'memory' ? 'flex-1 min-h-0 flex flex-col overflow-hidden' : 'hidden'}>
                  <MemoryMapView
                    bytes={bin}
                    baselineBytes={compareBin}
                    xdf={xdf}
                    diffClusters={clusters}
                    onJumpToHex={handleJumpToHex}
                    onSelectMap={selectMapById}
                  />
                </div>

                <div className={section === 'recipes' ? 'flex-1 min-h-0 flex flex-col overflow-hidden' : 'hidden'}>
                  <RecipesPluginsView
                    bin={bin}
                    xdf={xdf}
                    binName={binName}
                    onApplyPatches={handleApplyPatches}
                    onSelectMap={selectMapById}
                    onJumpToHex={handleJumpToHex}
                    onSaveSnapshot={handleSaveSnapshot}
                    onLoadReferenceXdf={(entry) => {
                      if (entry.xdfXml) {
                        const parsed = importDefinition(`${entry.name}.xdf`, entry.xdfXml);
                        setXdf(parsed);
                        setXdfName(`${entry.name}.xdf`);
                        setSelectedItemId(parsed.items[0]?.id ?? null);
                        showToast(`Loaded reference XDF: ${entry.xdfTitle}`);
                      }
                    }}
                    onCompareReferenceBin={(entry) => {
                      if (entry.bytes) {
                        const id = `ref-${Date.now()}`;
                        setOpenBins((prev) => [...prev, { id, name: entry.name, bytes: entry.bytes! }]);
                        setCompareBinId(id);
                        showToast(`Comparing against reference: ${entry.name}`);
                      }
                    }}
                  />
                </div>

                <div className={section === 'datalog' ? 'flex-1 min-h-0 flex flex-col overflow-hidden' : 'hidden'}>
                  <DatalogView
                    xdf={xdf}
                    bin={bin}
                    onApplyPatches={handleApplyPatches}
                    onDatalogOverlayChange={handleDatalogOverlayChange}
                    onSelectMap={selectMapById}
                  />
                </div>

                <div className={section === 'flash' ? 'flex-1 min-h-0 flex flex-col overflow-hidden' : 'hidden'}>
                  <FlashPreflightView
                    bytes={bin}
                    baselineBytes={compareBin}
                    fileName={binName}
                    compareName={compareName}
                    xdf={xdf}
                    blocks={uiChecksumBlocks}
                    cvnHex={checksumReport.cvnHex}
                    tprotProtectedCount={checksumReport.tprotBlockCount}
                    onFixChecksums={handleFixChecksums}
                    onJumpToHex={handleJumpToHex}
                    onSelectMap={selectMapById}
                    onReplaceBytes={replaceBytesWithHistory}
                    historyEntries={historyEntries}
                    onUndo={handleUndo}
                    selectedProfileId={checksumProfileId}
                    onSelectProfile={setChecksumProfileId}
                    snapshots={snapshots}
                    onSaveSnapshot={handleSaveSnapshot}
                    onRestoreSnapshot={(snap) => replaceBytesWithHistory(snap.bytes, `Restored snapshot: ${snap.name}`)}
                    onDeleteSnapshot={(id) => setSnapshots((prev) => prev.filter((s) => s.id !== id))}
                    onSetCompareFromSnapshot={(snap) => {
                      const id = `snap-cmp-${snap.id}`;
                      setOpenBins((prev) =>
                        prev.some((b) => b.id === id)
                          ? prev
                          : [...prev, { id, name: `Snapshot: ${snap.name}`, bytes: snap.bytes }],
                      );
                      setCompareBinId(id);
                      showToast(`Comparing against snapshot: ${snap.name}`);
                    }}
                    onAddSnapshotToMultiCompare={(snap) => {
                      setPendingCompareSlot({ id: snap.id, name: snap.name, bytes: snap.bytes });
                      setSection('compare');
                      showToast(`Added snapshot "${snap.name}" to Multi-Compare`);
                    }}
                    onUpdateHistoryNote={(index, note) => {
                      setUndoStack((prev) =>
                        prev.map((entry, idx) => (idx === index ? { ...entry, note } : entry)),
                      );
                    }}
                    onAutoFixDiagnostic={handleAutoFixDiagnostic}
                  />
                </div>
              </main>

              {/* Collapsible Xcode-style Bottom Drawer (⇧⌘Y) */}
              <BottomDrawer
                open={bottomDrawerOpen}
                onClose={() => setBottomDrawerOpen(false)}
                item={selectedItem}
                bin={bin}
                compareBin={compareBin}
                heatmapPalette={heatmapPalette}
                isLocked={isSelectedLocked}
                onApplyPatches={handleApplyPatches}
                onJumpToHex={handleJumpToHex}
                onOpenXdfEditor={selectedItem ? () => handleOpenXdfEditor(selectedItem) : undefined}
                onResetMap={handleResetMap}
                invalidChecksumCount={checksumReport.invalidCount}
                checksumPluginName={checksumReport.pluginName}
                selectedProfileId={checksumProfileId}
                onFixChecksums={handleFixChecksums}
                onOpenDatalogView={() => setSection('datalog')}
                onOpenFlashView={() => setSection('flash')}
                datalogSummary={{
                  enabled: datalogOverlay.enabled,
                  frameIndex: datalogOverlay.frameIndex,
                  xChannel: datalogOverlay.xChannel,
                  yChannel: datalogOverlay.yChannel,
                  xValue: datalogOverlay.xValue,
                  yValue: datalogOverlay.yValue,
                  hitCellCount: Object.keys(datalogOverlay.hits).length,
                  points3d: datalogOverlay.points3d,
                  activeCell: datalogOverlay.activeCell,
                }}
              />
            </div>

            {section === 'workspace' && layoutMode !== 'canvas' && (
              <InspectorPanel
                item={selectedItem}
                bin={bin}
                compareBin={compareBin}
                collapsed={inspectorCollapsed}
                onToggleCollapse={() => setInspectorCollapsed((v) => !v)}
                isLocked={isSelectedLocked}
                onToggleLock={handleToggleLockSelected}
                unitSystem={unitSystem}
                onUnitSystemChange={(sys) => setUnitSystem(sys)}
                translationMode={translationMode}
                onTranslationModeChange={setTranslationMode}
                onJumpToHex={handleJumpToHex}
                onOpenXdfEditor={() => handleOpenXdfEditor(selectedItem)}
                xdf={xdf}
                onSelectMap={selectMapById}
                onApplyPatches={handleApplyPatches}
                isPinned={selectedItem ? pinnedItemId === selectedItem.id : false}
                onTogglePin={selectedItem ? () => handleTogglePinItem(selectedItem) : undefined}
                diagnostics={diagnostics}
                onAutoFixDiagnostic={handleAutoFixDiagnostic}
                onFixChecksums={handleFixChecksums}
                checksumSummary={{
                  validCount: checksumReport.validCount,
                  invalidCount: checksumReport.invalidCount,
                  pluginName: checksumReport.pluginName,
                  canFix: checksumReport.invalidCount > 0,
                }}
                openBins={openBins.map((b) => ({ id: b.id, name: b.name, size: b.bytes.length }))}
                activeBinId={activeBinId}
                onSelectOpenBin={(id) => {
                  const found = openBins.find((b) => b.id === id);
                  if (found) {
                    setActiveBinId(found.id);
                    setOpenedSnapshot(found.bytes.slice());
                    setUndoStack([]);
                    setRedoStack([]);
                    setChecksumProfileId(detectChecksumPlugin(found.bytes).id);
                  }
                }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Bottom Status Bar (compact single-line at 1280x800, Checksum pill always visible) */}
      <footer className="flex h-7 shrink-0 items-center justify-between border-t border-white/[0.06] bg-[#101115] px-2.5 text-[10.5px] text-zinc-400 gap-1.5 whitespace-nowrap overflow-hidden">
        <div className="flex items-center gap-1.5 font-mono shrink-0 min-w-0">
          <span className="font-semibold text-slate-200 truncate max-w-[140px]">{ecuIdentity.ecuFamily}</span>
          <span>·</span>
          <span>{ecuIdentity.fileSizeKB} KB</span>
          {ecuIdentity.softwareNumber && (
            <span className="hidden xl:inline">· SW {ecuIdentity.softwareNumber}</span>
          )}
          <span className="hidden 2xl:inline">· {ecuIdentity.architecture}</span>
        </div>

        <div className="flex items-center gap-1 shrink-0 whitespace-nowrap">
          {/* Compare Quick-Switcher */}
          {openBins.length > 1 && (
            <label
              className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 transition cursor-pointer shrink-0"
              title={t('Comparison BIN / Reference (Right)')}
            >
              <ArrowLeftRight className="h-3 w-3 text-amber-400 shrink-0" />
              <select
                value={compareBinId ?? ''}
                onChange={(e) => setCompareBinId(e.target.value || null)}
                aria-label={t('Comparison')}
                className="bg-transparent text-[10px] text-zinc-300 outline-none cursor-pointer truncate max-w-[110px]"
              >
                <option value="" className="bg-[#17181d] text-zinc-100">
                  {t('No Comparison')}
                </option>
                {openBins
                  .filter((b) => b.id !== activeBinId)
                  .map((b) => (
                    <option key={b.id} value={b.id} className="bg-[#17181d] text-zinc-100">
                      vs {b.name}
                    </option>
                  ))}
              </select>
            </label>
          )}

          {/* Global Unit System Selector */}
          <label
            className="flex items-center gap-0.5 rounded-full px-1 py-0.5 text-[10px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 transition cursor-pointer shrink-0"
            title={t('Units')}
          >
            <Scale className="h-3 w-3 shrink-0" />
            <select
              value={unitSystem}
              onChange={(e) => setUnitSystem(e.target.value as UnitSystem)}
              aria-label={t('Units')}
              className="bg-transparent text-[10px] text-zinc-300 outline-none cursor-pointer"
            >
              <option value="original" className="bg-[#17181d] text-zinc-100">{t('Original')}</option>
              <option value="metric" className="bg-[#17181d] text-zinc-100">{t('Metric')}</option>
              <option value="imperial" className="bg-[#17181d] text-zinc-100">{t('Imperial')}</option>
            </select>
          </label>

          {/* Scientific Heatmap Palette Selector */}
          <label
            className="flex items-center gap-0.5 rounded-full px-1 py-0.5 text-[10px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 transition cursor-pointer shrink-0"
            title={t('Color Palette (Heatmap)')}
          >
            <Palette className="h-3 w-3 shrink-0 text-sky-400" />
            <select
              value={heatmapPalette}
              onChange={(e) => handleHeatmapPaletteChange(e.target.value as HeatmapPalette)}
              aria-label={t('Color Palette (Heatmap)')}
              className="bg-transparent text-[10px] text-zinc-300 outline-none cursor-pointer"
            >
              {HEATMAP_PALETTES.map((p) => (
                <option key={p.id} value={p.id} className="bg-[#17181d] text-zinc-100">
                  {t(p.label.split(' ')[0])}
                </option>
              ))}
            </select>
          </label>

          {/* Layout Mode Switcher */}
          <label
            className="flex items-center gap-0.5 rounded-full px-1 py-0.5 text-[10px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 transition cursor-pointer shrink-0"
            title={t('Layout Mode')}
          >
            <LayoutGrid className="h-3 w-3 shrink-0" />
            <select
              value={layoutMode}
              onChange={(e) => {
                const next = e.target.value as LayoutMode;
                setLayoutMode(next);
                if (next === 'ide') setBottomDrawerOpen(true);
              }}
              aria-label={t('Layout Mode')}
              className="bg-transparent text-[10px] text-zinc-300 outline-none cursor-pointer"
            >
              <option value="studio" className="bg-[#17181d] text-zinc-100">{t('Studio')}</option>
              <option value="ide" className="bg-[#17181d] text-zinc-100">{t('IDE')}</option>
              <option value="canvas" className="bg-[#17181d] text-zinc-100">{t('Canvas')}</option>
            </select>
          </label>

          {/* Bottom Drawer Toggle */}
          <button
            type="button"
            onClick={() => setBottomDrawerOpen((v) => !v)}
            title={`${t('Bottom Drawer')} (⇧⌘Y)`}
            className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium transition cursor-pointer shrink-0 ${
              bottomDrawerOpen
                ? 'bg-[#0a84ff]/20 text-sky-300'
                : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'
            }`}
          >
            <PanelBottom className="h-3 w-3" />
            <span className="hidden 2xl:inline">{t('Drawer')}</span>
          </button>

          <button
            type="button"
            onClick={handleSaveProject}
            title={t('Save Project')}
            className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 transition cursor-pointer shrink-0"
          >
            <Save className="h-3 w-3" />
            <span className="hidden 2xl:inline">.mtproj</span>
          </button>

          <label className="hidden xl:flex items-center gap-1 rounded-full px-1 py-0.5 text-[10px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 transition cursor-pointer shrink-0" title={t('Theme')}>
            <select
              value={themeId}
              onChange={(e) => setThemeId(e.target.value as AppThemeId)}
              aria-label={t('Theme')}
              className="bg-transparent text-[10px] text-zinc-300 outline-none cursor-pointer"
            >
              {THEME_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id} className="bg-[#17181d] text-zinc-100">
                  {t(opt.label)}
                </option>
              ))}
            </select>
          </label>

          <label className="hidden xl:flex items-center gap-1 rounded-full px-1 py-0.5 text-[10px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 transition cursor-pointer shrink-0" title={t('Language')}>
            <Globe className="h-3 w-3 shrink-0" />
            <select
              value={locale}
              onChange={(e) => handleLocaleChange(e.target.value as LocaleCode)}
              aria-label={t('Language')}
              className="bg-transparent text-[10px] text-zinc-300 outline-none cursor-pointer"
            >
              {AVAILABLE_LOCALES.map((loc) => (
                <option key={loc.code} value={loc.code} className="bg-[#17181d] text-zinc-100">
                  {loc.name}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => setUpdateModalOpen(true)}
            className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] font-medium transition cursor-pointer shrink-0 ${
              updateInfo?.available
                ? 'bg-[#0a84ff]/20 text-sky-300 hover:bg-[#0a84ff]/30'
                : 'text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200'
            }`}
            title={t('Check for Updates…')}
          >
            {updateInfo?.available ? `v${updateInfo.latestVersion}` : `v${APP_VERSION}`}
          </button>

          {/* Clickable "N maps changed" jump pill */}
          {changedItemIds.size > 0 && (
            <button
              type="button"
              onClick={() => handleCycleChangedMap(1)}
              title={t('Next change (⌥⌘↓)')}
              className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 hover:bg-amber-500/25 transition cursor-pointer shrink-0"
            >
              {t('%lld changed', changedItemIds.size)}
            </button>
          )}

          <button
            type="button"
            onClick={() => setSection('flash')}
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition cursor-pointer shrink-0 ${
              checksumReport.invalidCount === 0
                ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
                : 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
            }`}
          >
            {checksumReport.invalidCount === 0 ? (
              <>
                <CheckCircle2 className="h-3 w-3 shrink-0" />
                {t('Checksum OK')}
              </>
            ) : (
              <>
                <ShieldAlert className="h-3 w-3 shrink-0" />
                {t('Checksum Invalid (%lld)', checksumReport.invalidCount)}
              </>
            )}
          </button>
        </div>
      </footer>

      {/* Drag & Drop File Overlay */}
      {isDraggingFile && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="glass-card flex flex-col items-center gap-3 rounded-2xl px-10 py-8 text-center">
            <Upload className="h-10 w-10 text-sky-400" />
            <div className="text-base font-semibold text-white">{t('Open XDF, A2L/KP, BIN, Project, or Datalog')}</div>
            <div className="text-xs text-slate-400">{t('Hold Shift while dropping a BIN to load as Comparison BIN')}</div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div className="glass-popover fixed bottom-10 right-5 z-50 rounded-xl px-4 py-2 text-xs font-medium text-white">
          {toast}
        </div>
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={xdf?.items ?? []}
        candidates={coreCandidates}
        onSelectMap={(it) => selectMapById(it.id)}
        onJumpAddress={handleJumpToHex}
        onSelectHexRange={(range) => {
          setSelectedRange(range);
          handleJumpToHex(range[0]);
          showToast(
            `Selected 0x${range[0].toString(16).toUpperCase()}..0x${range[1].toString(16).toUpperCase()}`,
          );
        }}
        onSetHexColumns={(cols) => {
          setHexCols(cols);
          setSection('workspace');
          setWorkbenchMode('hex');
          showToast(`Hex-Diff column width set to ${cols}`);
        }}
        onSwitchSection={(sec, mode) => {
          setSection(sec);
          if (mode) setWorkbenchMode(mode);
        }}
        onFixChecksums={handleFixChecksums}
        onSwapBins={handleSwapBins}
        onSetLayoutMode={(m) => {
          setLayoutMode(m);
          if (m === 'ide') setBottomDrawerOpen(true);
          showToast(`Layout: ${m.toUpperCase()}`);
        }}
        onToggleBottomDrawer={() => setBottomDrawerOpen((v) => !v)}
        onToggleInspector={() => setInspectorCollapsed((v) => !v)}
        onToggleLock={handleToggleLockSelected}
        onToggleFavorite={handleToggleFavoriteSelected}
        onNextChangedMap={() => handleCycleChangedMap(1)}
        onPrevChangedMap={() => handleCycleChangedMap(-1)}
        onQuickSnapshot={handleQuickSnapshot}
        onExportBin={() => setExportReviewOpen(true)}
        onExportDefinition={handleExportDefinition}
        onPrint={() => window.print()}
        onSetHeatmapPalette={(p) => {
          handleHeatmapPaletteChange(p);
          showToast(`Heatmap palette: ${p}`);
        }}
        onSetUnitSystem={(u) => {
          setUnitSystem(u);
          showToast(`Unit system: ${u}`);
        }}
      />

      <XdfEditorModal
        open={xdfEditorOpen}
        item={xdfEditorItem}
        initialDraft={xdfModalDraft}
        bin={bin}
        categories={xdf?.categories ?? {}}
        xdfCategories={xdf?.categories ?? {}}
        onSave={handleSaveXdfItem}
        onCreateNew={(item) => {
          if (item) handleSaveXdfItem(item);
          else {
            setXdfEditorItem(null);
            setXdfModalDraft(null);
          }
        }}
        onDelete={handleDeleteXdfItem}
        onAddCategory={handleAddCategory}
        onClose={() => {
          setXdfEditorOpen(false);
          setXdfModalDraft(null);
        }}
      />

      <PreSaveReviewModal
        open={exportReviewOpen}
        onClose={() => setExportReviewOpen(false)}
        bin={bin}
        baselineBin={compareBin}
        openedSnapshot={openedSnapshot}
        fileName={binName}
        xdf={xdf}
        checksumBlocks={uiChecksumBlocks}
        invalidChecksumCount={checksumReport.invalidCount}
        onFixChecksums={handleFixChecksums}
        onConfirmExport={handleDownloadBin}
        onSelectMap={(id) => {
          setExportReviewOpen(false);
          selectMapById(id);
        }}
      />

      <UpdateModal
        open={updateModalOpen}
        info={updateInfo}
        checking={checkingUpdate}
        onCheckNow={() => void runUpdateCheck()}
        onClose={() => setUpdateModalOpen(false)}
      />
    </div>
    </I18nProvider>
  );
}
