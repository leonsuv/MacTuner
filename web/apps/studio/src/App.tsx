import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeftRight,
  CheckCircle2,
  Cpu,
  Download,
  FolderOpen,
  HardDrive,
  Layers,
  Redo2,
  Search,
  ShieldAlert,
  ShieldCheck,
  Undo2,
  Upload,
} from 'lucide-react';
import {
  applyPatches,
  candidateToXDFItem,
  countChangedBytes,
  countChangedCells,
  createMed17DemoBundle,
  diffClusters,
  findTwinMaps,
  fixChecksums,
  identifyECU,
  importDefinition,
  layoutByteRange,
  parseBinaryFile,
  scanMaps,
  serializeXDF,
  verifyChecksums,
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
import { FlashPreflightView, type ChecksumBlock as UiChecksumBlock } from './components/FlashPreflightView';
import { DatalogView } from './components/DatalogView';
import { CommandPalette } from './components/CommandPalette';

type TopSection = 'workspace' | 'discovery' | 'memory' | 'datalog' | 'flash';

interface HistoryEntry {
  patches: Patch[];
  label: string;
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
    () => verifyChecksums(bin, compareBin ?? undefined, 'bosch-me7'),
    [bin, compareBin],
  );

  const uiChecksumBlocks = useMemo<UiChecksumBlock[]>(() => {
    return checksumReport.blocks.map((b) => ({
      id: b.id,
      name: b.name,
      algorithm: b.algorithm,
      start: b.start,
      end: b.end,
      storeAddress: Math.max(b.start, b.end - 8),
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

  const handleApplyPatches = useCallback(
    (patches: Patch[], label: string) => {
      if (patches.length === 0) return;
      setBin((prev) => applyPatches(prev, patches));
      setUndoStack((prev) => [...prev.slice(-49), { patches, label }]);
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
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
    const res = fixChecksums(bin, 'bosch-me7');
    if (res.patches.length === 0) {
      showToast('All checksums are already valid');
      return;
    }
    handleApplyPatches(res.patches, `Fixed ${res.fixedCount} checksum block(s)`);
  }, [bin, handleApplyPatches, showToast]);

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
        if (lower.endsWith('.xdf') || lower.endsWith('.xml') || lower.endsWith('.a2l') || lower.endsWith('.csv')) {
          const text = await file.text();
          const parsed = importDefinition(file.name, text);
          setXdf(parsed);
          setXdfName(file.name);
          setSelectedItemId(parsed.items[0]?.id ?? null);
          showToast(`Loaded definition: ${file.name} (${parsed.items.length} items)`);
        } else {
          const rawBuf = new Uint8Array(await file.arrayBuffer());
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
            showToast(`Loaded BIN: ${file.name} (${Math.round(buf.length / 1024)} KB)`);
          }
        }
      }
    },
    [showToast],
  );

  const handleExportXdf = useCallback(() => {
    if (!xdf) return;
    const xml = serializeXDF(xdf);
    const blob = new Blob([xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = xdfName || 'MacTuner.xdf';
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${a.download}`);
  }, [xdf, xdfName, showToast]);

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
      showToast(`Found ${twins.length} twin map(s) — jumped to 0x${first.address.toString(16).toUpperCase()} (${Math.round(first.similarity * 100)}%)`);
    },
    [bin, showToast],
  );

  const navItems: Array<{ id: TopSection; label: string; icon: React.ReactNode }> = [
    { id: 'workspace', label: 'Workspace', icon: <Layers className="h-3.5 w-3.5" /> },
    { id: 'discovery', label: 'Discovery & DTCs', icon: <Search className="h-3.5 w-3.5" /> },
    { id: 'memory', label: 'Memory Map', icon: <HardDrive className="h-3.5 w-3.5" /> },
    { id: 'datalog', label: 'Datalog', icon: <Activity className="h-3.5 w-3.5" /> },
    { id: 'flash', label: 'Flash', icon: <ShieldCheck className="h-3.5 w-3.5" /> },
  ];

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden bg-[#0b0e14] text-[#e6eaf2]"
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
        accept=".bin,.ori,.mod,.hex,.ihx,.s19,.s28,.s37,.srec,.xdf,.xml,.a2l,.csv"
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void handleFiles(e.target.files, false);
          e.target.value = '';
        }}
      />
      <input
        ref={compareInputRef}
        type="file"
        accept=".bin,.ori,.mod,.hex"
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void handleFiles(e.target.files, true);
          e.target.value = '';
        }}
      />

      {/* Top Native-Style Title & Workbench Bar */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.065] bg-[#131418]/95 px-4 backdrop-blur-xl">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-b from-[#2b95ff] to-[#0066dc] shadow-[0_2px_10px_rgba(10,132,255,0.35),inset_0_1px_0_rgba(255,255,255,0.28)]">
            <Cpu className="h-3.5 w-3.5 text-white" />
          </div>
          <div className="min-w-0 leading-tight">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-semibold tracking-[-0.01em] text-white">{binName}</span>
              {undoStack.length > 0 && (
                <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9.5px] font-medium text-amber-300">
                  edited
                </span>
              )}
            </div>
            <div className="truncate text-[10.5px] text-zinc-400">
              {ecuIdentity.ecuFamily} · MacTuner
            </div>
          </div>
        </div>

        {/* Center 5-Mode Apple Pro Segmented Navigation */}
        <nav className="flex items-center gap-0.5 rounded-full border border-white/[0.07] bg-white/[0.035] p-0.5">
          {navItems.map((n) => {
            const active = section === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setSection(n.id)}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-[11.5px] font-medium transition-all ${
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
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPaletteOpen(true)}
            title="Command Palette (⌘K)"
            className="flex items-center gap-1.5 rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[11.5px] text-zinc-300 hover:bg-white/[0.09] hover:text-white transition"
          >
            <Search className="h-3.5 w-3.5 text-zinc-400" />
            <kbd className="font-mono text-[10px] text-zinc-400">⌘K</kbd>
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            title="Open BIN or XDF"
            className="flex items-center gap-1.5 rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[11.5px] text-zinc-200 hover:bg-white/[0.09] transition"
          >
            <FolderOpen className="h-3.5 w-3.5 text-zinc-400" />
            <span className="hidden xl:inline">Open</span>
          </button>
          <button
            onClick={handleUndo}
            disabled={undoStack.length === 0}
            title="Undo (⌘Z)"
            className="rounded-lg bg-white/[0.04] p-1.5 text-zinc-300 hover:bg-white/[0.09] disabled:opacity-25 transition"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleRedo}
            disabled={redoStack.length === 0}
            title="Redo (⇧⌘Z)"
            className="rounded-lg bg-white/[0.04] p-1.5 text-zinc-300 hover:bg-white/[0.09] disabled:opacity-25 transition"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleExportXdf}
            title="Export XDF Definition"
            className="flex items-center gap-1 rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[11.5px] text-zinc-200 hover:bg-white/[0.09] transition"
          >
            <Download className="h-3.5 w-3.5 text-zinc-400" />
            <span className="hidden xl:inline">XDF</span>
          </button>
        </div>
      </header>

      {/* Main Content Area: Sidebar + Active Document Bar + Viewport */}
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
                  onClick={handleSwapBins}
                  title="Swap Active (L) and Comparison (R) BINs"
                  className="rounded-md p-1 text-zinc-400 hover:bg-white/[0.06] hover:text-white transition"
                >
                  <ArrowLeftRight className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                onClick={() => compareInputRef.current?.click()}
                className="flex items-center gap-1 rounded-md bg-white/[0.05] px-2 py-0.5 text-[11px] font-medium text-zinc-300 hover:bg-white/[0.09] hover:text-white transition"
              >
                + BIN
              </button>
            </div>
          </div>

          {/* Active Workbench Pane */}
          <main className="relative min-h-0 flex-1 overflow-hidden">
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

            {section === 'datalog' && <DatalogView />}

            {section === 'flash' && (
              <FlashPreflightView
                bytes={bin}
                baselineBytes={compareBin}
                fileName={binName}
                compareName={compareName}
                xdf={xdf}
                blocks={uiChecksumBlocks}
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
              />
            )}
          </main>
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

        <div className="flex items-center gap-3">
          {changedItemIds.size > 0 && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
              {changedItemIds.size} maps changed
            </span>
          )}
          <button
            onClick={() => setSection('flash')}
            className={`flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-semibold transition ${
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
            <div className="text-base font-semibold text-white">Drop ECU .bin or .xdf file</div>
            <div className="text-xs text-slate-400">Hold Shift while dropping to load as Comparison BIN</div>
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
    </div>
  );
}
