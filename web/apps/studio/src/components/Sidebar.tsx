import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Binary,
  Bookmark,
  ChevronDown,
  ChevronRight,
  Copy,
  Edit3,
  FileWarning,
  GitCompare,
  Grid3X3,
  Layers,
  Lock,
  Pin,
  Plus,
  RotateCcw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Spline,
  Star,
  Table2,
  ToggleLeft,
  Trash2,
  Unlock,
  Wrench,
  X,
} from 'lucide-react';
import {
  DiffCluster,
  XDFDefinition,
  XDFItem,
  layoutByteRange,
  translateMapName,
  type TranslationMode,
} from '@mactuner/core';
import { useI18n } from '../lib/i18n';

export type WorkbenchMode = 'hex' | 'map';
export type SidebarTab = 'maps' | 'diffs' | 'detected' | 'markers';
export type SidebarMapScope = 'all' | 'changed' | 'favorites';

export interface MapCandidate {
  id: string;
  address: number;
  headerAddress?: number;
  rows: number;
  cols: number;
  bits: number;
  signed: boolean;
  isFloat?: boolean;
  lsbFirst: boolean;
  confidence: number; // 0..1
  patternLabel?: string;
  hasHeaderProof?: boolean;
  hasAxes?: boolean;
  hasDiff?: boolean;
  xAxisAddress?: number;
  yAxisAddress?: number;
  domainHint?: string;
}

export interface HexMarker {
  id: string;
  address: number;
  label: string;
  note?: string;
  color?: string;
  createdAt?: number;
}

export interface SidebarProps {
  mode: WorkbenchMode;
  onModeChange: (mode: WorkbenchMode) => void;
  /** True when the Workspace section is active (prevents Hex/Map from glowing on Overview/Compare/Flash/etc.) */
  isWorkspaceActive?: boolean;
  xdf: XDFDefinition | null;
  selectedItemId: number | null;
  onSelectItem: (item: XDFItem) => void;
  changedItemIds: Set<number>;
  diffClusters: DiffCluster[];
  onJumpToAddress: (address: number, switchToHex?: boolean) => void;
  detectedCandidates: MapCandidate[];
  onSelectCandidate?: (candidate: MapCandidate) => void;
  onAddCandidateToXdf?: (candidate: MapCandidate) => void;
  markers: HexMarker[];
  onDeleteMarker?: (id: string) => void;
  activeTab?: SidebarTab;
  onTabChange?: (tab: SidebarTab) => void;
  // Swift MacTuner parity props (all optional & backwards-compatible)
  mapScope?: SidebarMapScope;
  onMapScopeChange?: (scope: SidebarMapScope) => void;
  favoriteIds?: Set<string>;
  onToggleFavorite?: (item: XDFItem) => void;
  lockedItemIds?: Set<number>;
  onToggleLock?: (item: XDFItem) => void;
  pinnedItemId?: number | null;
  onTogglePin?: (item: XDFItem) => void;
  outOfSafeRangeItemIds?: Set<number>;
  diagnosticWarningItemIds?: Set<number>;
  autoAlignConfidenceByItemId?: Record<number, number>;
  translationMode?: TranslationMode;
  outsideOfXdfBytes?: number;
  onClickOutsideOfXdf?: () => void;
  diffClusterGap?: number;
  onDiffClusterGapChange?: (gap: number) => void;
  // Context menu actions
  onCopyMapFromCompare?: (item: XDFItem) => void;
  onResetMap?: (item: XDFItem) => void;
  onEditMapInXdfModal?: (item: XDFItem) => void;
  onDeleteMap?: (item: XDFItem) => void;
  onCreateXdfFromDiff?: (cluster: DiffCluster) => void;
  onCopyDiffFromCompare?: (cluster: DiffCluster) => void;
  onEditCandidateInXdfModal?: (candidate: MapCandidate) => void;
  onIgnoreCandidate?: (candidate: MapCandidate) => void;
}

type ContextMenuState =
  | { kind: 'map'; x: number; y: number; item: XDFItem }
  | { kind: 'diff'; x: number; y: number; cluster: DiffCluster }
  | { kind: 'candidate'; x: number; y: number; candidate: MapCandidate }
  | { kind: 'marker'; x: number; y: number; marker: HexMarker }
  | null;

const DIFF_GAP_OPTIONS = [0, 16, 32, 64] as const;
const CONFIDENCE_OPTIONS = [0.85, 0.7, 0.55] as const;

function formatHex(addr: number): string {
  return `0x${Math.max(0, addr).toString(16).toUpperCase().padStart(5, '0')}`;
}

function formatByteSize(bytes: number): string {
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function guessDiffShapeBadge(spanBytes: number): string {
  if (spanBytes === 512) return '16×16?';
  if (spanBytes === 256) return '16×8?';
  if (spanBytes === 128) return '8×8?';
  if (spanBytes === 200) return '10×10?';
  if (spanBytes === 288) return '12×12?';
  if (spanBytes === 72) return '6×6?';
  if (spanBytes >= 16 && spanBytes <= 64 && spanBytes % 2 === 0) return '1D?';
  if (spanBytes <= 4) return 'Scalar?';
  if (spanBytes > 512 && spanBytes % 32 === 0) return '2D?';
  return 'Block';
}

function renderMapKindIcon(item: XDFItem): React.ReactNode {
  switch (item.itemKind.kind) {
    case 'table':
      if (item.data.rows <= 1 || item.data.cols <= 1) {
        return <Spline className="w-3 h-3 text-cyan-400 shrink-0" />;
      }
      return <Grid3X3 className="w-3 h-3 text-sky-400 shrink-0" />;
    case 'constant':
      return <SlidersHorizontal className="w-3 h-3 text-amber-400 shrink-0" />;
    case 'flag':
      return <ToggleLeft className="w-3 h-3 text-emerald-400 shrink-0" />;
    case 'patch':
      return <Wrench className="w-3 h-3 text-purple-400 shrink-0" />;
  }
}

export const Sidebar: React.FC<SidebarProps> = ({
  mode,
  onModeChange,
  isWorkspaceActive = true,
  xdf,
  selectedItemId,
  onSelectItem,
  changedItemIds,
  diffClusters,
  onJumpToAddress,
  detectedCandidates,
  onSelectCandidate,
  onAddCandidateToXdf,
  markers,
  onDeleteMarker,
  activeTab: controlledTab,
  onTabChange,
  mapScope: controlledScope,
  onMapScopeChange,
  favoriteIds,
  onToggleFavorite,
  lockedItemIds,
  onToggleLock,
  pinnedItemId,
  onTogglePin,
  outOfSafeRangeItemIds,
  diagnosticWarningItemIds,
  autoAlignConfidenceByItemId,
  translationMode = 'original',
  outsideOfXdfBytes = 0,
  onClickOutsideOfXdf,
  diffClusterGap = 16,
  onDiffClusterGapChange,
  onCopyMapFromCompare,
  onResetMap,
  onEditMapInXdfModal,
  onDeleteMap,
  onCreateXdfFromDiff,
  onCopyDiffFromCompare,
  onEditCandidateInXdfModal,
  onIgnoreCandidate,
}) => {
  const { t } = useI18n();
  const [internalTab, setInternalTab] = useState<SidebarTab>('maps');
  const [search, setSearch] = useState('');
  const [internalScope, setInternalScope] = useState<SidebarMapScope>('all');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [minConfidence, setMinConfidence] = useState<number>(0.55);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const activeTab = controlledTab ?? internalTab;
  const setActiveTab = (tab: SidebarTab) => {
    setInternalTab(tab);
    onTabChange?.(tab);
  };

  const mapFilter = controlledScope ?? internalScope;
  const setMapFilter = (scope: SidebarMapScope) => {
    setInternalScope(scope);
    onMapScopeChange?.(scope);
  };

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  const query = search.trim().toLowerCase();

  const favoritesCount = useMemo(() => {
    if (!xdf || !favoriteIds) return 0;
    return xdf.items.filter((it) => favoriteIds.has(String(it.id))).length;
  }, [xdf, favoriteIds]);

  const groupedMaps = useMemo(() => {
    const items = xdf?.items ?? [];
    const categoriesMap = xdf?.categories ?? {};

    const filtered = items.filter((item) => {
      if (mapFilter === 'changed' && !changedItemIds.has(item.id)) return false;
      if (mapFilter === 'favorites' && !(favoriteIds?.has(String(item.id)) ?? false)) return false;
      if (!query) return true;
      const addrHex = formatHex(item.data.address).toLowerCase();
      const displayTitle =
        translationMode !== 'original'
          ? translateMapName(item.title, translationMode).toLowerCase()
          : item.title.toLowerCase();
      return (
        item.title.toLowerCase().includes(query) ||
        displayTitle.includes(query) ||
        item.description.toLowerCase().includes(query) ||
        addrHex.includes(query)
      );
    });

    const groups = new Map<string, XDFItem[]>();
    for (const item of filtered) {
      const catId = item.categories[0];
      const catName =
        catId !== undefined && categoriesMap[catId]
          ? categoriesMap[catId]
          : 'Uncategorized';
      const list = groups.get(catName) ?? [];
      list.push(item);
      groups.set(catName, list);
    }

    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [xdf, mapFilter, changedItemIds, favoriteIds, query, translationMode]);

  const filteredDiffs = useMemo(() => {
    if (!query) return diffClusters;
    return diffClusters.filter((c) => {
      const s = formatHex(c.start).toLowerCase();
      const e = formatHex(c.end).toLowerCase();
      return s.includes(query) || e.includes(query) || String(c.changedBytes).includes(query);
    });
  }, [diffClusters, query]);

  const detectedStats = useMemo(() => {
    let count2D = 0;
    let count1D = 0;
    let countPtr = 0;
    for (const c of detectedCandidates) {
      if (c.patternLabel?.toLowerCase().includes('ptr')) countPtr++;
      if (c.rows > 1 && c.cols > 1) count2D++;
      else count1D++;
    }
    return { count2D, count1D, countPtr };
  }, [detectedCandidates]);

  const filteredDetected = useMemo(() => {
    return detectedCandidates.filter((c) => {
      if (c.confidence < minConfidence) return false;
      if (!query) return true;
      const addr = formatHex(c.address).toLowerCase();
      const dims = `${c.rows}x${c.cols}`;
      return (
        addr.includes(query) ||
        dims.includes(query) ||
        (c.domainHint?.toLowerCase().includes(query) ?? false) ||
        (c.patternLabel?.toLowerCase().includes(query) ?? false)
      );
    });
  }, [detectedCandidates, minConfidence, query]);

  const filteredMarkers = useMemo(() => {
    if (!query) return markers;
    return markers.filter((m) => {
      const addr = formatHex(m.address).toLowerCase();
      return (
        m.label.toLowerCase().includes(query) ||
        (m.note?.toLowerCase().includes(query) ?? false) ||
        addr.includes(query)
      );
    });
  }, [markers, query]);

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const openMenuAt = (e: React.MouseEvent, next: Exclude<ContextMenuState, null>) => {
    e.preventDefault();
    e.stopPropagation();
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 310);
    setContextMenu({ ...next, x: Math.max(8, x), y: Math.max(8, y) });
  };

  const totalMaps = xdf?.items.length ?? 0;

  const tabs: { id: SidebarTab; label: string; count: number; icon: React.ReactNode }[] = [
    { id: 'maps', label: t('Maps'), count: totalMaps, icon: <Layers className="w-3.5 h-3.5" /> },
    { id: 'diffs', label: t('Diffs'), count: diffClusters.length, icon: <GitCompare className="w-3.5 h-3.5" /> },
    { id: 'detected', label: t('Detected'), count: detectedCandidates.length, icon: <Sparkles className="w-3.5 h-3.5" /> },
    { id: 'markers', label: t('Markers'), count: markers.length, icon: <Bookmark className="w-3.5 h-3.5" /> },
  ];

  return (
    <aside className="w-64 shrink-0 h-full flex flex-col bg-[#121317] border-r border-white/[0.065] select-none">
      {/* Top macOS Segmented Mode Toggle */}
      <div className="p-2.5 border-b border-white/[0.065]">
        <div className="grid grid-cols-2 p-0.5 rounded-lg bg-white/[0.05]">
          <button
            type="button"
            onClick={() => onModeChange('hex')}
            className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-medium transition-all cursor-pointer ${
              isWorkspaceActive && mode === 'hex'
                ? 'bg-[#0a84ff] text-white shadow-[0_1px_8px_rgba(10,132,255,0.38)]'
                : 'text-zinc-400 hover:text-zinc-100'
            }`}
          >
            <Binary className="w-3.5 h-3.5" />
            <span className="truncate">{t('Hex Editor')}</span>
          </button>
          <button
            type="button"
            onClick={() => onModeChange('map')}
            className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-medium transition-all cursor-pointer ${
              isWorkspaceActive && mode === 'map'
                ? 'bg-[#0a84ff] text-white shadow-[0_1px_8px_rgba(10,132,255,0.38)]'
                : 'text-zinc-400 hover:text-zinc-100'
            }`}
          >
            <Table2 className="w-3.5 h-3.5" />
            <span className="truncate">{t('Map Editor')}</span>
          </button>
        </div>
      </div>

      {/* 4 Nav Tabs with live counts */}
      <div className="grid grid-cols-4 gap-0.5 px-2 py-1.5 border-b border-white/[0.065]">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex flex-col items-center justify-center gap-0.5 py-1.5 px-1 rounded-lg transition-colors cursor-pointer ${
                isActive
                  ? 'bg-white/[0.08] text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.035]'
              }`}
            >
              <div className="flex items-center gap-1">
                <span className={isActive ? 'text-zinc-100' : 'text-zinc-500'}>{tab.icon}</span>
                <span className="text-[10px] font-mono tabular-nums text-zinc-400">
                  {tab.count}
                </span>
              </div>
              <span className="text-[10px] font-medium tracking-tight truncate max-w-full">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Search Input & Contextual Filters */}
      <div className="px-2.5 py-2 border-b border-white/[0.065]">
        <div className="relative flex items-center">
          <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={
              activeTab === 'maps'
                ? t('Filter maps…')
                : activeTab === 'diffs'
                  ? t('Address 0x…')
                  : activeTab === 'detected'
                    ? t('Filter')
                    : t('Filter')
            }
            className="w-full pl-8 pr-7 py-1.5 text-xs bg-[#101115] text-zinc-100 placeholder:text-zinc-500 rounded-lg border border-white/[0.065] focus:outline-none focus:border-[#0a84ff]/70 transition-colors"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 text-zinc-500 hover:text-zinc-200 cursor-pointer"
              aria-label={t('Clear All')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* All / Changed / Favorites scope pills (Maps tab) */}
        {activeTab === 'maps' && (
          <div className="flex items-center gap-1 mt-2">
            <button
              type="button"
              onClick={() => setMapFilter('all')}
              className={`px-2 py-0.5 rounded-md text-[10.5px] font-medium transition-colors cursor-pointer ${
                mapFilter === 'all'
                  ? 'bg-white/[0.09] text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]'
              }`}
            >
              {t('All')} <span className="font-mono tabular-nums ml-0.5 opacity-75">{totalMaps}</span>
            </button>
            <button
              type="button"
              onClick={() => setMapFilter('changed')}
              className={`px-2 py-0.5 rounded-md text-[10.5px] font-medium transition-colors cursor-pointer ${
                mapFilter === 'changed'
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]'
              }`}
            >
              {t('Changed')}{' '}
              <span className="font-mono tabular-nums ml-0.5 opacity-75">
                {changedItemIds.size}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setMapFilter('favorites')}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-medium transition-colors cursor-pointer ${
                mapFilter === 'favorites'
                  ? 'bg-amber-400/15 text-amber-300'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]'
              }`}
              title={`${t('Favorites')} (⌘3)`}
            >
              <Star className="w-2.5 h-2.5 fill-current" />
              <span className="font-mono tabular-nums">{favoritesCount}</span>
            </button>
          </div>
        )}

        {/* Diff cluster gap selector (Diffs tab) */}
        {activeTab === 'diffs' && (
          <div className="flex items-center justify-between gap-1 mt-2">
            <span className="text-[10px] font-medium text-zinc-500">{t('Cluster:')}</span>
            <div className="flex items-center gap-0.5">
              {DIFF_GAP_OPTIONS.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => onDiffClusterGapChange?.(g)}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-mono tabular-nums transition-colors cursor-pointer ${
                    diffClusterGap === g
                      ? 'bg-[#0a84ff]/20 text-sky-300'
                      : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04]'
                  }`}
                >
                  {g}B
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ECU completeness header & confidence filter (Detected tab) */}
        {activeTab === 'detected' && (
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 bg-white/[0.03] rounded-md px-2 py-1">
              <span>2D: {detectedStats.count2D}</span>
              <span className="text-zinc-600">·</span>
              <span>1D: {detectedStats.count1D}</span>
              <span className="text-zinc-600">·</span>
              <span>Ptr: {detectedStats.countPtr}</span>
            </div>
            <div className="flex items-center justify-between gap-1">
              <span className="text-[10px] font-medium text-zinc-500">{t('Confidence Threshold')}</span>
              <div className="flex items-center gap-0.5">
                {CONFIDENCE_OPTIONS.map((thr) => (
                  <button
                    key={thr}
                    type="button"
                    onClick={() => setMinConfidence(thr)}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono tabular-nums transition-colors cursor-pointer ${
                      Math.abs(minConfidence - thr) < 0.001
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04]'
                    }`}
                  >
                    {Math.round(thr * 100)}%
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Scrollable Borderless Inset List Content */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
        {/* MAPS TAB */}
        {activeTab === 'maps' && (
          <>
            {/* Outside of XDF row in Changed scope */}
            {mapFilter === 'changed' && outsideOfXdfBytes > 0 && (
              <button
                type="button"
                onClick={() => onClickOutsideOfXdf?.()}
                className="w-full text-left px-2.5 py-2 mb-1.5 rounded-lg bg-amber-500/10 border border-amber-500/25 hover:bg-amber-500/15 transition-colors cursor-pointer"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-amber-300">
                    <FileWarning className="w-3.5 h-3.5 shrink-0" />
                    <span>{t('Outside of XDF')}</span>
                  </span>
                  <span className="text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200">
                    {formatByteSize(outsideOfXdfBytes)}
                  </span>
                </div>
                <p className="mt-0.5 text-[10px] text-amber-200/70">
                  {t('Outside-XDF Changes')}
                </p>
              </button>
            )}

            {groupedMaps.length === 0 ? (
              <div className="text-center py-10 px-4">
                <Layers className="w-5 h-5 text-zinc-600 mx-auto mb-2" />
                <p className="text-xs text-zinc-500">
                  {mapFilter === 'changed'
                    ? t('No Changes')
                    : mapFilter === 'favorites'
                      ? t('Add maps with the star or by right-clicking (⌘D).')
                      : t('No maps found.')}
                </p>
              </div>
            ) : (
              groupedMaps.map(([category, items]) => {
                const isCollapsed = collapsedCategories.has(category);
                const catChangedCount = items.filter((it) => changedItemIds.has(it.id)).length;
                return (
                  <div key={category} className="pb-1">
                    <button
                      type="button"
                      onClick={() => toggleCategory(category)}
                      className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03] transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-1 truncate">
                        {isCollapsed ? (
                          <ChevronRight className="w-3 h-3 shrink-0" />
                        ) : (
                          <ChevronDown className="w-3 h-3 shrink-0" />
                        )}
                        <span className="truncate">{category}</span>
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0 font-mono tabular-nums text-[10px]">
                        {catChangedCount > 0 && (
                          <span className="px-1.5 py-0 rounded-full bg-amber-500/15 text-amber-300">
                            {catChangedCount}
                          </span>
                        )}
                        <span className="text-zinc-600">{items.length}</span>
                      </span>
                    </button>

                    {!isCollapsed && (
                      <div className="space-y-0.5 mt-0.5">
                        {items.map((item) => {
                          const isSelected = item.id === selectedItemId;
                          const isChanged = changedItemIds.has(item.id);
                          const isFav = favoriteIds?.has(String(item.id)) ?? false;
                          const isLocked = lockedItemIds?.has(item.id) ?? false;
                          const isPinned = pinnedItemId === item.id;
                          const isOutOfSafe = outOfSafeRangeItemIds?.has(item.id) ?? false;
                          const hasDiagWarn = diagnosticWarningItemIds?.has(item.id) ?? false;
                          const alignConf = autoAlignConfidenceByItemId?.[item.id];
                          const displayTitle =
                            translationMode !== 'original'
                              ? translateMapName(item.title, translationMode)
                              : item.title;
                          const dims =
                            item.itemKind.kind === 'table'
                              ? `${item.data.rows}×${item.data.cols}`
                              : item.itemKind.kind === 'flag'
                                ? 'FLAG'
                                : item.itemKind.kind === 'patch'
                                  ? 'PATCH'
                                  : '1×1';
                          return (
                            <div
                              key={item.id}
                              role="button"
                              tabIndex={0}
                              onClick={() => onSelectItem(item)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  onSelectItem(item);
                                }
                              }}
                              onContextMenu={(e) => openMenuAt(e, { kind: 'map', x: e.clientX, y: e.clientY, item })}
                              className={`w-full text-left px-2 py-1.5 rounded-lg transition-colors cursor-pointer group ${
                                isSelected
                                  ? 'bg-[#0a84ff]/16 text-white'
                                  : 'text-zinc-300 hover:bg-white/[0.045] hover:text-zinc-100'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-1.5">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  {renderMapKindIcon(item)}
                                  <span
                                    className="text-xs font-medium truncate"
                                    title={translationMode !== 'original' ? `${displayTitle} (${item.title})` : item.title}
                                  >
                                    {displayTitle}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  {isLocked && (
                                    <span title={t('Locked')}>
                                      <Lock className="w-3 h-3 text-amber-400" />
                                    </span>
                                  )}
                                  {isPinned && (
                                    <span title={t('Pin for Split')}>
                                      <Pin className="w-3 h-3 text-sky-400" />
                                    </span>
                                  )}
                                  {isOutOfSafe && (
                                    <span title={t('Outside safety range')}>
                                      <AlertTriangle className="w-3 h-3 text-rose-400" />
                                    </span>
                                  )}
                                  {hasDiagWarn && (
                                    <span title={t('Diagnostic notice (axis, outlier, or saturation)')}>
                                      <ShieldAlert className="w-3 h-3 text-amber-400" />
                                    </span>
                                  )}
                                  {alignConf !== undefined && (
                                    <span
                                      className="text-[9.5px] font-mono px-1 rounded bg-emerald-500/15 text-emerald-300"
                                      title={t('Auto-Align Definition')}
                                    >
                                      {alignConf > 1 ? Math.round(alignConf) : Math.round(alignConf * 100)}%
                                    </span>
                                  )}
                                  {isChanged && (
                                    <span
                                      className="w-1.5 h-1.5 rounded-full bg-amber-400"
                                      title={t('Differs from comparison')}
                                    />
                                  )}
                                  {onToggleFavorite && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onToggleFavorite(item);
                                      }}
                                      title={isFav ? t('Remove from Favorites') : t('Add to Favorites')}
                                      className={`p-0.5 rounded transition cursor-pointer ${
                                        isFav
                                          ? 'text-amber-400 opacity-100'
                                          : 'text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-amber-300'
                                      }`}
                                    >
                                      <Star className={`w-3 h-3 ${isFav ? 'fill-current' : ''}`} />
                                    </button>
                                  )}
                                </div>
                              </div>
                              <div
                                className={`flex items-center justify-between mt-0.5 text-[10px] font-mono tabular-nums ${
                                  isSelected ? 'text-blue-200/65' : 'text-zinc-500'
                                }`}
                              >
                                <span>{formatHex(item.data.address)}</span>
                                <span>
                                  {dims} · {item.data.bits}b
                                  {item.scaling.units ? ` · ${item.scaling.units}` : ''}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </>
        )}

        {/* DIFFS TAB */}
        {activeTab === 'diffs' && (
          <>
            {filteredDiffs.length === 0 ? (
              <div className="text-center py-10 px-4">
                <GitCompare className="w-5 h-5 text-zinc-600 mx-auto mb-2" />
                <p className="text-xs text-zinc-500">{t('No Byte Differences')}</p>
              </div>
            ) : (
              filteredDiffs.map((cluster, idx) => {
                const span = Math.max(1, cluster.end - cluster.start);
                const shapeBadge = guessDiffShapeBadge(span);
                const matchingMap = xdf?.items.find((it) => {
                  const [s, e] = layoutByteRange(it.data);
                  return cluster.start < e && cluster.end > s;
                });
                return (
                  <button
                    key={`${cluster.start}-${idx}`}
                    type="button"
                    onClick={() => onJumpToAddress(cluster.start, true)}
                    onContextMenu={(e) => openMenuAt(e, { kind: 'diff', x: e.clientX, y: e.clientY, cluster })}
                    className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-white/[0.045] transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="text-xs font-mono tabular-nums font-medium text-amber-300">
                        {formatHex(cluster.start)} · {formatByteSize(cluster.changedBytes)}
                      </span>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-[9.5px] font-mono px-1 py-0.5 rounded bg-sky-500/15 text-sky-300">
                          {shapeBadge}
                        </span>
                        <span className="text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded bg-amber-500/12 text-amber-300">
                          Δ {span}B
                        </span>
                      </div>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-[10.5px] text-zinc-400">
                      <span className="truncate">
                        {matchingMap ? matchingMap.title : t('Not in XDF')}
                      </span>
                      <span className="font-mono tabular-nums text-zinc-500 shrink-0 ml-2">
                        → {formatHex(cluster.end)}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </>
        )}

        {/* DETECTED TAB */}
        {activeTab === 'detected' && (
          <>
            {filteredDetected.length === 0 ? (
              <div className="text-center py-10 px-4">
                <Sparkles className="w-5 h-5 text-zinc-600 mx-auto mb-2" />
                <p className="text-xs text-zinc-500">
                  {t('No Recognized Maps')} ({Math.round(minConfidence * 100)}%)
                </p>
              </div>
            ) : (
              filteredDetected.map((cand) => {
                const dims = `${cand.rows}×${cand.cols}`;
                const evidenceLabel =
                  cand.hasHeaderProof
                    ? 'Header'
                    : cand.hasAxes
                      ? 'Axes'
                      : 'Pattern';
                const evidenceCls =
                  cand.hasHeaderProof
                    ? 'bg-amber-500/15 text-amber-300'
                    : cand.hasAxes
                      ? 'bg-sky-500/15 text-sky-300'
                      : 'bg-white/[0.08] text-zinc-300';
                const subtitle =
                  cand.patternLabel ??
                  `Bosch ${dims}${cand.hasAxes ? ' + Axes' : ''}${cand.hasDiff ? ' · Diff' : ''}`;
                return (
                  <div
                    key={cand.id}
                    onClick={() => {
                      if (onSelectCandidate) onSelectCandidate(cand);
                      else onJumpToAddress(cand.address, true);
                    }}
                    onContextMenu={(e) =>
                      openMenuAt(e, { kind: 'candidate', x: e.clientX, y: e.clientY, candidate: cand })
                    }
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        if (onSelectCandidate) onSelectCandidate(cand);
                        else onJumpToAddress(cand.address, true);
                      }
                    }}
                    className="px-2.5 py-2 rounded-lg hover:bg-white/[0.045] transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-xs font-mono tabular-nums font-medium text-zinc-100">
                          {formatHex(cand.address)}
                        </span>
                        <span className="text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded bg-white/[0.06] text-zinc-300 shrink-0">
                          {dims}
                        </span>
                        <span className="text-[10px] font-mono tabular-nums text-emerald-400">
                          {Math.round(cand.confidence * 100)}%
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAddCandidateToXdf?.(cand);
                        }}
                        title={t('Add to XDF (1-Click)')}
                        className="w-6 h-6 rounded-md flex items-center justify-center bg-white/[0.05] hover:bg-[#0a84ff] text-zinc-400 hover:text-white transition-colors shrink-0 cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-zinc-500 truncate">
                      <span className={`text-[9.5px] font-medium px-1.5 py-0 rounded shrink-0 ${evidenceCls}`}>
                        {evidenceLabel}
                      </span>
                      <span className="truncate">{subtitle}</span>
                    </div>
                  </div>
                );
              })
            )}
          </>
        )}

        {/* MARKERS TAB */}
        {activeTab === 'markers' && (
          <>
            {filteredMarkers.length === 0 ? (
              <div className="text-center py-10 px-4">
                <Bookmark className="w-5 h-5 text-zinc-600 mx-auto mb-2" />
                <p className="text-xs text-zinc-500">
                  {t('No Bookmarks')}. {t('Add bookmarks in Hex-Diff via right-click or the bookmark menu.')}
                </p>
              </div>
            ) : (
              filteredMarkers.map((marker) => (
                <div
                  key={marker.id}
                  onClick={() => onJumpToAddress(marker.address, true)}
                  onContextMenu={(e) =>
                    openMenuAt(e, { kind: 'marker', x: e.clientX, y: e.clientY, marker })
                  }
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onJumpToAddress(marker.address, true);
                    }
                  }}
                  className="px-2.5 py-2 rounded-lg hover:bg-white/[0.045] transition-colors cursor-pointer flex items-start justify-between gap-2 group"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: marker.color ?? '#0a84ff' }}
                      />
                      <span className="text-xs font-medium text-zinc-100 truncate">
                        {marker.label}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[10px] font-mono tabular-nums text-zinc-500">
                      {formatHex(marker.address)}
                    </div>
                    {marker.note && (
                      <p className="mt-0.5 text-[11px] text-zinc-500 truncate">
                        {marker.note}
                      </p>
                    )}
                  </div>
                  {onDeleteMarker && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteMarker(marker.id);
                      }}
                      title={t('Delete')}
                      className="p-1 rounded-md text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 opacity-0 group-hover:opacity-100 transition-all shrink-0 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))
            )}
          </>
        )}
      </div>

      {/* Right-click Context Menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          className="glass-popover fixed z-50 w-52 rounded-xl py-1 text-xs shadow-2xl border border-white/10"
        >
          {contextMenu.kind === 'map' && (
            <>
              <button
                type="button"
                onClick={() => {
                  onSelectItem(contextMenu.item);
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-200 hover:bg-white/10 cursor-pointer"
              >
                <Table2 className="w-3.5 h-3.5 text-sky-400" />
                <span>{t('Open in Editor')}</span>
              </button>
              {onTogglePin && (
                <button
                  type="button"
                  onClick={() => {
                    onTogglePin(contextMenu.item);
                    setContextMenu(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-200 hover:bg-white/10 cursor-pointer"
                >
                  <Pin className="w-3.5 h-3.5 text-sky-400" />
                  <span>{pinnedItemId === contextMenu.item.id ? t('Close split view') : t('Pin for Split')}</span>
                </button>
              )}
              {onToggleFavorite && (
                <button
                  type="button"
                  onClick={() => {
                    onToggleFavorite(contextMenu.item);
                    setContextMenu(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-200 hover:bg-white/10 cursor-pointer"
                >
                  <Star className="w-3.5 h-3.5 text-amber-400" />
                  <span>
                    {favoriteIds?.has(String(contextMenu.item.id)) ? t('Remove from Favorites') : t('Add to Favorites')}
                  </span>
                </button>
              )}
              {onToggleLock && (
                <button
                  type="button"
                  onClick={() => {
                    onToggleLock(contextMenu.item);
                    setContextMenu(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-200 hover:bg-white/10 cursor-pointer"
                >
                  {lockedItemIds?.has(contextMenu.item.id) ? (
                    <Unlock className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Lock className="w-3.5 h-3.5 text-amber-400" />
                  )}
                  <span>{lockedItemIds?.has(contextMenu.item.id) ? t('Unlock Map') : t('Lock Map')}</span>
                </button>
              )}
              <div className="my-1 border-t border-white/[0.08]" />
              {onCopyMapFromCompare && (
                <button
                  type="button"
                  onClick={() => {
                    onCopyMapFromCompare(contextMenu.item);
                    setContextMenu(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-200 hover:bg-white/10 cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5 text-zinc-400" />
                  <span>{t('Copy Selection from Compare')}</span>
                </button>
              )}
              {onResetMap && (
                <button
                  type="button"
                  onClick={() => {
                    onResetMap(contextMenu.item);
                    setContextMenu(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-200 hover:bg-white/10 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-zinc-400" />
                  <span>{t('Reset Map')}</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  onJumpToAddress(contextMenu.item.data.address, true);
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-200 hover:bg-white/10 cursor-pointer"
              >
                <Binary className="w-3.5 h-3.5 text-zinc-400" />
                <span>{t('Open Hex-Diff')}</span>
              </button>
              {onEditMapInXdfModal && (
                <button
                  type="button"
                  onClick={() => {
                    onEditMapInXdfModal(contextMenu.item);
                    setContextMenu(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-200 hover:bg-white/10 cursor-pointer"
                >
                  <Edit3 className="w-3.5 h-3.5 text-zinc-400" />
                  <span>{t('Edit XDF Item…')}</span>
                </button>
              )}
              {onDeleteMap && (
                <>
                  <div className="my-1 border-t border-white/[0.08]" />
                  <button
                    type="button"
                    onClick={() => {
                      onDeleteMap(contextMenu.item);
                      setContextMenu(null);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-rose-400 hover:bg-rose-500/15 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{t('Delete')}</span>
                  </button>
                </>
              )}
            </>
          )}

          {contextMenu.kind === 'diff' && (
            <>
              {onCreateXdfFromDiff && (
                <button
                  type="button"
                  onClick={() => {
                    onCreateXdfFromDiff(contextMenu.cluster);
                    setContextMenu(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-200 hover:bg-white/10 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5 text-sky-400" />
                  <span>{t('Create as XDF Map …')}</span>
                </button>
              )}
              {onCopyDiffFromCompare && (
                <button
                  type="button"
                  onClick={() => {
                    onCopyDiffFromCompare(contextMenu.cluster);
                    setContextMenu(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-200 hover:bg-white/10 cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5 text-amber-400" />
                  <span>{t('Copy Block from Compare (←)')}</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  onJumpToAddress(contextMenu.cluster.start, true);
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-200 hover:bg-white/10 cursor-pointer"
              >
                <Binary className="w-3.5 h-3.5 text-zinc-400" />
                <span>{t('Open Hex-Diff')}</span>
              </button>
            </>
          )}

          {contextMenu.kind === 'candidate' && (
            <>
              {onAddCandidateToXdf && (
                <button
                  type="button"
                  onClick={() => {
                    onAddCandidateToXdf(contextMenu.candidate);
                    setContextMenu(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-200 hover:bg-white/10 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{t('Add to XDF')}</span>
                </button>
              )}
              {onEditCandidateInXdfModal && (
                <button
                  type="button"
                  onClick={() => {
                    onEditCandidateInXdfModal(contextMenu.candidate);
                    setContextMenu(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-200 hover:bg-white/10 cursor-pointer"
                >
                  <Edit3 className="w-3.5 h-3.5 text-sky-400" />
                  <span>{t('Customize & Save as XDF Item …')}</span>
                </button>
              )}
              {onIgnoreCandidate && (
                <>
                  <div className="my-1 border-t border-white/[0.08]" />
                  <button
                    type="button"
                    onClick={() => {
                      onIgnoreCandidate(contextMenu.candidate);
                      setContextMenu(null);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-rose-400 hover:bg-rose-500/15 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>{t('Hide Candidate (Ignore)')}</span>
                  </button>
                </>
              )}
            </>
          )}

          {contextMenu.kind === 'marker' && (
            <>
              <button
                type="button"
                onClick={() => {
                  onJumpToAddress(contextMenu.marker.address, true);
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-200 hover:bg-white/10 cursor-pointer"
              >
                <Binary className="w-3.5 h-3.5 text-sky-400" />
                <span>{t('Open Hex-Diff')}</span>
              </button>
              {onDeleteMarker && (
                <button
                  type="button"
                  onClick={() => {
                    onDeleteMarker(contextMenu.marker.id);
                    setContextMenu(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-rose-400 hover:bg-rose-500/15 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>{t('Delete')}</span>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
};
