import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeftRight,
  CheckCircle2,
  ChevronDown,
  Columns3,
  Cpu,
  Download,
  FileDown,
  FolderOpen,
  Globe,
  HardDrive,
  Layers,
  Palette,
  PanelRight,
  Redo2,
  Save,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Undo2,
  Upload,
} from 'lucide-react';
import {
  applyPatches,
  candidateToXDFItem,
  countChangedBytes,
  countChangedCells,
  createMed17DemoBundle,
  detectChecksumPlugin,
  diffClusters,
  exportDefinition,
  findTwinMaps,
  fixChecksums,
  identifyECU,
  importBinaryDefinition,
  importDefinition,
  isWinOLSBinary,
  layoutByteRange,
  parseBinaryFile,
  parseProject,
  scanMaps,
  serializeProject,
  verifyChecksums,
  type DefinitionExportFormat,
  type MapCandidate as CoreMapCandidate,
  type Patch,
  type XDFDefinition,
  type XDFItem,
} from '@mactuner/core';
import { Sidebar, type HexMarker, type MapCandidate as UiMapCandidate, type SidebarTab, type WorkbenchMode } from './components/Sidebar';
import { HexDiffCanvas } from './components/HexDiffCanvas';
import { MapEditorView } from './components/MapEditorView';
import { DiscoveryView } from './components/DiscoveryView';
import { MemoryMapView } from './components/MemoryMapView';
import { FlashPreflightView, type ChecksumBlock as UiChecksumBlock, type EditHistoryItem } from './components/FlashPreflightView';
import { DatalogView } from './components/DatalogView';
import { MultiCompareView } from './components/MultiCompareView';
import { RecipesPluginsView } from './components/RecipesPluginsView';
import { InspectorPanel } from './components/InspectorPanel';
import { XdfEditorModal } from './components/XdfEditorModal';
import { PreSaveReviewModal } from './components/PreSaveReviewModal';
import { CommandPalette } from './components/CommandPalette';
import { UpdateModal } from './components/UpdateModal';
import { APP_VERSION, checkForUpdates, type UpdateInfo } from './lib/updater';
import { AVAILABLE_LOCALES, getInitialLocale, saveLocale, translate, type LocaleCode } from './lib/i18n';
import { THEME_OPTIONS, applyTheme, getInitialTheme, type AppThemeId } from './lib/theme';

type TopSection = 'workspace' | 'compare' | 'discovery' | 'memory' | 'recipes' | 'datalog' | 'flash';

interface HistoryEntry {
  patches: Patch[];
  label: string;
  timestamp: number;
}

const DEF_EXPORT_OPTIONS: Array<{ format: DefinitionExportFormat; ext: string; label: string; desc: string }> = [
  { format: 'xdf', ext: 'xdf', label: 'TunerPro (.xdf)', desc: 'Full XDF v1.70 XML' },
  { format: 'a2l', ext: 'a2l', label: 'ASAP2 (.a2l)', desc: 'Standard ECU calibration' },
  { format: 'csv', ext: 'csv', label: 'WinOLS CSV (.csv)', desc: 'Map list table export' },
  { format: 'kp', ext: 'kp', label: 'WinOLS Map Pack (.kp)', desc: 'Binary WinOLS map pack' },
];

function stripExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
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
  return {
    id: c.id,
    address: c.address,
    rows: c.rows,
    cols: c.cols,
    bits: c.bits,
    signed: c.signed,
    isFloat: false,
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
      isFloat: false,
      rows: c.rows,
      cols: c.cols,
    },
  };
}

export default function App() {
  const initialDemo = useMemo(() => createMed17DemoBundle(), []);

  const [bin, setBin] = useState<Uint8Array>(initialDemo.stage1Bin);
  const [compareBin, setCompareBin] = useState<Uint8Array | null>(initialDemo.stockBin);
  const [binName, setBinName] = useState<string>(initialDemo.stage1Name);
  const [compareName, setCompareName] = useState<string>(initialDemo.stockName);
  const [xdfName, setXdfName] = useState<string>(initialDemo.xdfName);
  const [xdf, setXdf] = useState<XDFDefinition | null>(initialDemo.xdf);

  const [section, setSection] = useState<TopSection>('workspace');
  const [workbenchMode, setWorkbenchMode] = useState<WorkbenchMode>('hex');
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('detected');
  const [selectedItemId, setSelectedItemId] = useState<number | null>(initialDemo.xdf.items[0]?.id ?? null);
  const [jumpAddress, setJumpAddress] = useState<number | null>(0x24024);
  const [selectedRange, setSelectedRange] = useState<[number, number] | null>(null);
  const [markers, setMarkers] = useState<HexMarker[]>([
    { id: 'm1', address: 0x20044, label: 'Target Boost Pressure (LDRXN)', color: '#2589ff' },
    { id: 'm2', address: 0x24024, label: 'Stage 1 Detected Diff Map', color: '#f59e0b' },
  ]);

  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  // v4.1 Pro Studio states
  const [inspectorCollapsed, setInspectorCollapsed] = useState(true);
  const [lockedItemIds, setLockedItemIds] = useState<Set<number>>(() => new Set());
  const [xdfEditorOpen, setXdfEditorOpen] = useState(false);
  const [xdfEditorItem, setXdfEditorItem] = useState<XDFItem | null>(null);
  const [exportDefMenuOpen, setExportDefMenuOpen] = useState(false);
  const [exportReviewOpen, setExportReviewOpen] = useState(false);
  const [checksumProfileId, setChecksumProfileId] = useState<string>('bosch-me7');
  const [locale, setLocale] = useState<LocaleCode>(() => getInitialLocale());
  const [themeId, setThemeId] = useState<AppThemeId>(() => getInitialTheme());

  const t = useCallback((key: string) => translate(locale, key), [locale]);

  useEffect(() => {
    applyTheme(themeId);
  }, [themeId]);

  const exportDefRef = useRef<HTMLDivElement>(null);

  const runUpdateCheck = useCallback(async () => {
    setCheckingUpdate(true);
    const info = await checkForUpdates();
    setUpdateInfo(info);
    setCheckingUpdate(false);
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void runUpdateCheck();
    }, 1800);
    return () => window.clearTimeout(t);
  }, [runUpdateCheck]);

  // Close Export Def dropdown on outside click or Escape
  useEffect(() => {
    if (!exportDefMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (exportDefRef.current && !exportDefRef.current.contains(e.target as Node)) {
        setExportDefMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExportDefMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [exportDefMenuOpen]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const compareInputRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 2800);
  }, []);

  const ecuIdentity = useMemo(() => identifyECU(bin), [bin]);

  const clusters = useMemo(
    () => (compareBin ? diffClusters(bin, compareBin, 16) : []),
    [bin, compareBin],
  );

  const coveredRanges = useMemo<Array<[number, number]>>(() => {
    if (!xdf) return [];
    return xdf.items.map((it) => layoutByteRange(it.data));
  }, [xdf]);

  const coreCandidates = useMemo(
    () => scanMaps(bin, coveredRanges),
    [bin, coveredRanges],
  );

  const uiCandidates = useMemo(
    () => coreCandidates.map((c) => toUiCandidate(c, bin, compareBin)),
    [coreCandidates, bin, compareBin],
  );

  const changedItemIds = useMemo(() => {
    const out = new Set<number>();
    if (!xdf || !compareBin) return out;
    for (const item of xdf.items) {
      if (countChangedCells(item, bin, compareBin) > 0) out.add(item.id);
    }
    return out;
  }, [xdf, bin, compareBin]);

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

  const isSelectedLocked = selectedItem ? lockedItemIds.has(selectedItem.id) : false;

  const historyEntries = useMemo<EditHistoryItem[]>(
    () =>
      undoStack.map((entry) => ({
        label: entry.label,
        bytes: entry.patches.reduce((sum, p) => sum + p.next.length, 0),
        timestamp: entry.timestamp,
      })),
    [undoStack],
  );

  const handleToggleLockSelected = useCallback(() => {
    if (!selectedItem) return;
    setLockedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(selectedItem.id)) {
        next.delete(selectedItem.id);
        showToast(`Unlocked: ${selectedItem.title}`);
      } else {
        next.add(selectedItem.id);
        showToast(`Locked: ${selectedItem.title}`);
      }
      return next;
    });
  }, [selectedItem, showToast]);

  const handleOpenXdfEditor = useCallback((targetItem: XDFItem | null) => {
    setXdfEditorItem(targetItem);
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
      setXdfEditorOpen(false);
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

  const handleApplyPatches = useCallback(
    (patches: Patch[], label: string) => {
      if (patches.length === 0) return;
      setBin((prev) => applyPatches(prev, patches));
      setUndoStack((prev) => [...prev.slice(-49), { patches, label, timestamp: Date.now() }]);
      setRedoStack([]);
      showToast(label);
    },
    [showToast],
  );

  const handleApplySinglePatch = useCallback(
    (offset: number, next: Uint8Array, label: string) => {
      const old = bin.slice(offset, offset + next.length);
      handleApplyPatches([{ offset, old, next }], label);
    },
    [bin, handleApplyPatches],
  );

  const handleUndo = useCallback(() => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      const inv: Patch[] = last.patches.map((p) => ({ offset: p.offset, old: p.next, next: p.old }));
      setBin((cur) => applyPatches(cur, inv));
      setRedoStack((r) => [...r, last]);
      showToast(`Undo: ${last.label}`);
      return prev.slice(0, -1);
    });
  }, [showToast]);

  const handleRedo = useCallback(() => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setBin((cur) => applyPatches(cur, last.patches));
      setUndoStack((u) => [...u, last]);
      showToast(`Redo: ${last.label}`);
      return prev.slice(0, -1);
    });
  }, [showToast]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA';

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        setInspectorCollapsed((v) => !v);
        return;
      }
      if (!isInput && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleUndo, handleRedo]);

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

  const handleSwapBins = useCallback(() => {
    if (!compareBin) return;
    const prevBin = bin;
    const prevName = binName;
    setBin(compareBin);
    setBinName(compareName);
    setCompareBin(prevBin);
    setCompareName(prevName);
    showToast(`Swapped active BIN → ${compareName}`);
  }, [bin, binName, compareBin, compareName, showToast]);

  const handleFiles = useCallback(
    async (files: FileList | File[], asCompare = false) => {
      for (const file of Array.from(files)) {
        const lower = file.name.toLowerCase();
        try {
          if (lower.endsWith('.mtproj')) {
            const text = await file.text();
            const proj = parseProject(text);
            setBin(proj.bin);
            setBinName(proj.binName);
            setCompareBin(proj.compareBin ?? null);
            if (proj.compareName) setCompareName(proj.compareName);
            setXdf(proj.xdf ?? null);
            if (proj.xdfName) setXdfName(proj.xdfName);
            if (proj.markers) setMarkers(proj.markers);
            if (proj.lockedItemIds) setLockedItemIds(new Set(proj.lockedItemIds));
            if (proj.selectedProfileId) setChecksumProfileId(proj.selectedProfileId);
            setSelectedItemId(proj.xdf?.items[0]?.id ?? null);
            setUndoStack([]);
            setRedoStack([]);
            showToast(`Opened project: ${file.name}`);
          } else if (lower.endsWith('.ols') || lower.endsWith('.kp')) {
            const rawBuf = new Uint8Array(await file.arrayBuffer());
            const parsed = importBinaryDefinition(file.name, rawBuf);
            setXdf(parsed);
            setXdfName(file.name);
            setSelectedItemId(parsed.items[0]?.id ?? null);
            showToast(`Loaded WinOLS definition: ${file.name} (${parsed.items.length} items)`);
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
            if (asCompare) {
              setCompareBin(buf);
              setCompareName(file.name);
              showToast(`Loaded comparison BIN: ${file.name}`);
            } else {
              setBin(buf);
              setBinName(file.name);
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
    [showToast],
  );

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
    });
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${stripExt(binName || 'MacTuner')}.mtproj`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Saved project ${a.download}`);
  }, [binName, bin, compareName, compareBin, xdfName, xdf, markers, lockedItemIds, checksumProfileId, showToast]);

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

  const handleJumpToHex = useCallback((address: number) => {
    setSection('workspace');
    setWorkbenchMode('hex');
    setJumpAddress(address);
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

  // Native Tauri menu bar event listener (macOS / Windows / Linux)
  useEffect(() => {
    const tauriGlobal = (window as unknown as {
      __TAURI__?: {
        event?: {
          listen: (event: string, cb: (ev: { payload: string }) => void) => Promise<() => void>;
        };
      };
    }).__TAURI__;
    if (!tauriGlobal?.event?.listen) return;
    let unlisten: (() => void) | undefined;
    void tauriGlobal.event
      .listen('mactuner-menu', (ev) => {
        switch (ev.payload) {
          case 'check-updates': setUpdateModalOpen(true); void runUpdateCheck(); break;
          case 'open-file': fileInputRef.current?.click(); break;
          case 'open-compare': compareInputRef.current?.click(); break;
          case 'save-project': handleSaveProject(); break;
          case 'export-bin': setExportReviewOpen(true); break;
          case 'export-xdf': handleExportDefinition('xdf', 'xdf'); break;
          case 'edit-undo': handleUndo(); break;
          case 'edit-redo': handleRedo(); break;
          case 'view-hex': setSection('workspace'); setWorkbenchMode('hex'); break;
          case 'view-map': setSection('workspace'); setWorkbenchMode('map'); break;
          case 'view-compare': setSection('compare'); break;
          case 'view-memory': setSection('memory'); break;
          case 'view-flash': setSection('flash'); break;
          case 'toggle-inspector': setInspectorCollapsed((v) => !v); break;
          case 'command-palette': setPaletteOpen((v) => !v); break;
          case 'fix-checksums': handleFixChecksums(); break;
          case 'swap-bins': handleSwapBins(); break;
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, [runUpdateCheck, handleSaveProject, handleExportDefinition, handleUndo, handleRedo, handleFixChecksums, handleSwapBins]);

  const navItems: Array<{ id: TopSection; label: string; icon: React.ReactNode }> = [
    { id: 'workspace', label: t('Workspace'), icon: <Layers className="h-3.5 w-3.5" /> },
    { id: 'compare', label: t('Compare'), icon: <Columns3 className="h-3.5 w-3.5" /> },
    { id: 'discovery', label: t('Discovery'), icon: <Search className="h-3.5 w-3.5" /> },
    { id: 'memory', label: t('Memory'), icon: <HardDrive className="h-3.5 w-3.5" /> },
    { id: 'recipes', label: t('Recipes'), icon: <Sparkles className="h-3.5 w-3.5" /> },
    { id: 'datalog', label: t('Datalog'), icon: <Activity className="h-3.5 w-3.5" /> },
    { id: 'flash', label: t('Flash'), icon: <ShieldCheck className="h-3.5 w-3.5" /> },
  ];

  return (
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
        accept=".bin,.ori,.mod,.hex,.ihx,.s19,.s28,.s37,.srec,.mot,.xdf,.xml,.a2l,.csv,.ols,.kp"
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

      {/* Top Native-Style Title & Workbench Bar */}
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-white/[0.065] bg-[#131418]/95 px-3.5 backdrop-blur-xl">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-b from-[#2b95ff] to-[#0066dc] shadow-[0_2px_10px_rgba(10,132,255,0.35),inset_0_1px_0_rgba(255,255,255,0.28)]">
            <Cpu className="h-3.5 w-3.5 text-white" />
          </div>
          <div className="min-w-0 leading-tight">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-semibold tracking-[-0.01em] text-white max-w-[160px]">
                {binName}
              </span>
              {undoStack.length > 0 && (
                <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9.5px] font-medium text-amber-300 shrink-0">
                  edited
                </span>
              )}
            </div>
            <div className="truncate text-[10.5px] text-zinc-400">
              {ecuIdentity.ecuFamily} · MacTuner
            </div>
          </div>
        </div>

        {/* Center Apple Pro Segmented Navigation */}
        <nav className="flex items-center gap-0.5 rounded-full border border-white/[0.07] bg-white/[0.035] p-0.5 overflow-x-auto">
          {navItems.map((n) => {
            const active = section === n.id;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => setSection(n.id)}
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-all shrink-0 cursor-pointer ${
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
            title="Command Palette (⌘K)"
            className="flex items-center gap-1.5 rounded-lg bg-white/[0.05] px-2 py-1.5 text-[11.5px] text-zinc-300 hover:bg-white/[0.09] hover:text-white transition cursor-pointer"
          >
            <Search className="h-3.5 w-3.5 text-zinc-400" />
            <kbd className="font-mono text-[10px] text-zinc-400 hidden 2xl:inline">⌘K</kbd>
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Open BIN, XDF, A2L, CSV, WinOLS (.ols / .kp)"
            className="flex items-center gap-1.5 rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[11.5px] text-zinc-200 hover:bg-white/[0.09] transition cursor-pointer"
          >
            <FolderOpen className="h-3.5 w-3.5 text-zinc-400" />
            <span className="hidden xl:inline">Open</span>
          </button>
          <button
            type="button"
            onClick={handleUndo}
            disabled={undoStack.length === 0}
            title="Undo (⌘Z)"
            className="rounded-lg bg-white/[0.04] p-1.5 text-zinc-300 hover:bg-white/[0.09] disabled:opacity-25 transition cursor-pointer disabled:cursor-not-allowed"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleRedo}
            disabled={redoStack.length === 0}
            title="Redo (⇧⌘Z)"
            className="rounded-lg bg-white/[0.04] p-1.5 text-zinc-300 hover:bg-white/[0.09] disabled:opacity-25 transition cursor-pointer disabled:cursor-not-allowed"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </button>

          {/* Export Def Dropdown (.xdf, .a2l, .csv, .kp) */}
          <div ref={exportDefRef} className="relative">
            <button
              type="button"
              onClick={() => setExportDefMenuOpen((v) => !v)}
              title="Export Definition (.xdf, .a2l, .csv, .kp)"
              className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium transition cursor-pointer ${
                exportDefMenuOpen
                  ? 'bg-white/[0.12] text-white'
                  : 'bg-white/[0.05] text-zinc-200 hover:bg-white/[0.09]'
              }`}
            >
              <Download className="h-3.5 w-3.5 text-zinc-400" />
              <span className="hidden xl:inline">Export Def</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
            {exportDefMenuOpen && (
              <div className="glass-popover absolute right-0 top-full mt-1.5 z-40 w-52 rounded-xl py-1">
                <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500 border-b border-white/[0.06]">
                  Export Definition
                </div>
                {DEF_EXPORT_OPTIONS.map((opt) => (
                  <button
                    key={opt.format}
                    type="button"
                    onClick={() => handleExportDefinition(opt.format, opt.ext)}
                    className="w-full px-3 py-2 text-left hover:bg-white/[0.08] transition-colors cursor-pointer"
                  >
                    <div className="text-xs font-medium text-zinc-100">{opt.label}</div>
                    <div className="text-[10px] text-zinc-400">{opt.desc}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Export BIN -> PreSaveReviewModal */}
          <button
            type="button"
            onClick={() => setExportReviewOpen(true)}
            title="Review changes & export .bin"
            className="flex items-center gap-1.5 rounded-lg bg-[#0a84ff] px-2.5 py-1.5 text-[11.5px] font-semibold text-white hover:bg-[#1e8fff] shadow-[0_1px_8px_rgba(10,132,255,0.35)] transition cursor-pointer"
          >
            <FileDown className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">Export BIN</span>
          </button>

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
            title="Toggle Right Inspector (⌥⌘I)"
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

      {/* Main Content Area: Sidebar + Active Document Bar + Viewport (+ Optional Inspector) */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar
          mode={workbenchMode}
          onModeChange={(m) => {
            setWorkbenchMode(m);
            setSection('workspace');
          }}
          xdf={xdf}
          selectedItemId={selectedItem?.id ?? null}
          onSelectItem={(item) => {
            setSelectedItemId(item.id);
            setSection('workspace');
            setWorkbenchMode('map');
          }}
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
        />

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Document Tab Strip */}
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#101115] px-3">
            <div className="flex items-center gap-1.5 overflow-x-auto">
              {xdf && (
                <span className="flex items-center gap-1.5 rounded-md bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-zinc-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-purple-400" />
                  {xdfName}
                </span>
              )}
              <span className="flex items-center gap-1.5 rounded-md bg-white/[0.07] px-2 py-0.5 text-[11px] font-medium text-zinc-100">
                <span className="h-1.5 w-1.5 rounded-full bg-[#0a84ff]" />
                {binName}
              </span>
              {compareBin && (
                <span className="flex items-center gap-1.5 rounded-md bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-zinc-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  {compareName}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1">
              {compareBin && (
                <button
                  type="button"
                  onClick={handleSwapBins}
                  title="Swap Active (L) and Comparison (R) BINs"
                  className="rounded-md p-1 text-zinc-400 hover:bg-white/[0.06] hover:text-white transition cursor-pointer"
                >
                  <ArrowLeftRight className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => compareInputRef.current?.click()}
                className="flex items-center gap-1 rounded-md bg-white/[0.05] px-2 py-0.5 text-[11px] font-medium text-zinc-300 hover:bg-white/[0.09] hover:text-white transition cursor-pointer"
              >
                + BIN
              </button>
            </div>
          </div>

          {/* Active Workbench Pane (+ Collapsible Right Inspector in Workspace) */}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
              {section === 'workspace' && workbenchMode === 'hex' && (
                <HexDiffCanvas
                  bin={bin}
                  compareBin={compareBin}
                  binName={binName}
                  compareName={compareName}
                  definition={xdf}
                  candidates={coreCandidates}
                  jumpAddress={jumpAddress}
                  selectedRange={selectedRange}
                  onSelectRange={setSelectedRange}
                  onAddCandidateToXdf={handleAddCoreCandidate}
                  onSelectXdfItem={(id) => {
                    setSelectedItemId(id);
                    setWorkbenchMode('map');
                  }}
                  onApplyPatch={handleApplySinglePatch}
                  onFindTwins={handleFindTwins}
                />
              )}

              {section === 'workspace' && workbenchMode === 'map' && selectedItem && (
                <MapEditorView
                  item={selectedItem}
                  bin={bin}
                  compareBin={compareBin}
                  onApplyPatches={handleApplyPatches}
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
                />
              )}

              {section === 'compare' && (
                <MultiCompareView
                  bin={bin}
                  binName={binName}
                  compareBin={compareBin}
                  compareName={compareName}
                  xdf={xdf}
                  onSelectMap={(id) => {
                    setSelectedItemId(id);
                    setSection('workspace');
                    setWorkbenchMode('map');
                  }}
                  onJumpToHex={handleJumpToHex}
                />
              )}

              {section === 'discovery' && (
                <DiscoveryView
                  bytes={bin}
                  baselineBytes={compareBin}
                  xdf={xdf}
                  candidates={uiCandidates}
                  onShowInHex={handleJumpToHex}
                  onAddCandidateToXdf={(cand) => handleAddCoreCandidate(fromUiCandidate(cand), true)}
                />
              )}

              {section === 'memory' && (
                <MemoryMapView
                  bytes={bin}
                  baselineBytes={compareBin}
                  xdf={xdf}
                  diffClusters={clusters}
                  onJumpToHex={handleJumpToHex}
                  onSelectMap={(id) => {
                    setSelectedItemId(id);
                    setSection('workspace');
                    setWorkbenchMode('map');
                  }}
                />
              )}

              {section === 'recipes' && (
                <RecipesPluginsView
                  bin={bin}
                  xdf={xdf}
                  binName={binName}
                  onApplyPatches={handleApplyPatches}
                  onSelectMap={(id) => {
                    setSelectedItemId(id);
                    setSection('workspace');
                    setWorkbenchMode('map');
                  }}
                  onJumpToHex={handleJumpToHex}
                />
              )}

              {section === 'datalog' && (
                <DatalogView
                  xdf={xdf}
                  bin={bin}
                  onApplyPatches={handleApplyPatches}
                />
              )}

              {section === 'flash' && (
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
                  onSelectMap={(id) => {
                    setSelectedItemId(id);
                    setSection('workspace');
                    setWorkbenchMode('map');
                  }}
                  onReplaceBytes={(nextBytes, label) => {
                    setBin(nextBytes);
                    showToast(label);
                  }}
                  historyEntries={historyEntries}
                  onUndo={handleUndo}
                  selectedProfileId={checksumProfileId}
                  onSelectProfile={setChecksumProfileId}
                />
              )}
            </main>

            {section === 'workspace' && (
              <InspectorPanel
                item={selectedItem}
                bin={bin}
                compareBin={compareBin}
                collapsed={inspectorCollapsed}
                onToggleCollapse={() => setInspectorCollapsed((v) => !v)}
                isLocked={isSelectedLocked}
                onToggleLock={handleToggleLockSelected}
                onJumpToHex={handleJumpToHex}
                onOpenXdfEditor={() => handleOpenXdfEditor(selectedItem)}
              />
            )}
          </div>
        </div>
      </div>

      {/* Bottom Status Bar */}
      <footer className="flex h-7 shrink-0 items-center justify-between border-t border-white/[0.06] bg-[#101115] px-4 text-[11px] text-zinc-400">
        <div className="flex items-center gap-3 font-mono">
          <span className="font-semibold text-slate-200">{ecuIdentity.ecuFamily}</span>
          <span>·</span>
          <span>{ecuIdentity.fileSizeKB} KB</span>
          {ecuIdentity.softwareNumber && (
            <>
              <span>·</span>
              <span>SW {ecuIdentity.softwareNumber}</span>
            </>
          )}
          <span>·</span>
          <span>{ecuIdentity.architecture}</span>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={handleSaveProject}
            title="Save full workspace archive (.mtproj)"
            className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 transition cursor-pointer"
          >
            <Save className="h-3 w-3" />
            <span>.mtproj</span>
          </button>

          <label className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 transition cursor-pointer" title="Switch Theme">
            <Palette className="h-3 w-3 shrink-0" />
            <select
              value={themeId}
              onChange={(e) => setThemeId(e.target.value as AppThemeId)}
              aria-label="Theme"
              className="bg-transparent text-[10px] text-zinc-300 outline-none cursor-pointer"
            >
              {THEME_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id} className="bg-[#17181d] text-zinc-100">
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 transition cursor-pointer" title="Switch Language (25 languages)">
            <Globe className="h-3 w-3 shrink-0" />
            <select
              value={locale}
              onChange={(e) => {
                const next = e.target.value as LocaleCode;
                setLocale(next);
                saveLocale(next);
              }}
              aria-label="Language"
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
            className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-medium transition cursor-pointer ${
              updateInfo?.available
                ? 'bg-[#0a84ff]/20 text-sky-300 hover:bg-[#0a84ff]/30'
                : 'text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200'
            }`}
            title="Check for MacTuner updates"
          >
            {updateInfo?.available ? `Update v${updateInfo.latestVersion}` : `v${APP_VERSION}`}
          </button>
          {changedItemIds.size > 0 && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
              {changedItemIds.size} maps changed
            </span>
          )}
          <button
            type="button"
            onClick={() => setSection('flash')}
            className={`flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-semibold transition cursor-pointer ${
              checksumReport.invalidCount === 0
                ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
                : 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
            }`}
          >
            {checksumReport.invalidCount === 0 ? (
              <>
                <CheckCircle2 className="h-3 w-3" />
                Checksum OK
              </>
            ) : (
              <>
                <ShieldAlert className="h-3 w-3" />
                Checksum Invalid ({checksumReport.invalidCount})
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
            <div className="text-base font-semibold text-white">Drop ECU .bin, .xdf, .a2l, .ols or .kp file</div>
            <div className="text-xs text-slate-400">Hold Shift while dropping a BIN to load as Comparison BIN</div>
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
        onSelectMap={(it) => {
          setSelectedItemId(it.id);
          setSection('workspace');
          setWorkbenchMode('map');
        }}
        onJumpAddress={handleJumpToHex}
        onSwitchSection={setSection}
        onFixChecksums={handleFixChecksums}
        onSwapBins={handleSwapBins}
      />

      <XdfEditorModal
        open={xdfEditorOpen}
        item={xdfEditorItem}
        bin={bin}
        categories={xdf?.categories ?? {}}
        onSave={handleSaveXdfItem}
        onCreateNew={() => setXdfEditorItem(null)}
        onDelete={handleDeleteXdfItem}
        onClose={() => setXdfEditorOpen(false)}
      />

      <PreSaveReviewModal
        open={exportReviewOpen}
        onClose={() => setExportReviewOpen(false)}
        bin={bin}
        baselineBin={compareBin}
        fileName={binName}
        xdf={xdf}
        checksumBlocks={uiChecksumBlocks}
        invalidChecksumCount={checksumReport.invalidCount}
        onFixChecksums={handleFixChecksums}
        onConfirmExport={handleDownloadBin}
        onSelectMap={(id) => {
          setExportReviewOpen(false);
          setSelectedItemId(id);
          setSection('workspace');
          setWorkbenchMode('map');
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
  );
}
