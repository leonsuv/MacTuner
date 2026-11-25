import React, { useMemo, useState } from 'react';
import {
  Binary,
  Bookmark,
  ChevronDown,
  ChevronRight,
  GitCompare,
  Layers,
  Plus,
  Search,
  Sparkles,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import {
  DiffCluster,
  XDFDefinition,
  XDFItem,
  layoutByteRange,
} from '@mactuner/core';

export type WorkbenchMode = 'hex' | 'map';
export type SidebarTab = 'maps' | 'diffs' | 'detected' | 'markers';

export interface MapCandidate {
  id: string;
  address: number;
  headerAddress?: number;
  rows: number;
  cols: number;
  bits: number;
  signed: boolean;
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
}

function formatHex(addr: number): string {
  return `0x${Math.max(0, addr).toString(16).toUpperCase().padStart(5, '0')}`;
}

function formatByteSize(bytes: number): string {
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export const Sidebar: React.FC<SidebarProps> = ({
  mode,
  onModeChange,
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
}) => {
  const [internalTab, setInternalTab] = useState<SidebarTab>('maps');
  const [search, setSearch] = useState('');
  const [mapFilter, setMapFilter] = useState<'all' | 'changed'>('all');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  const activeTab = controlledTab ?? internalTab;
  const setActiveTab = (tab: SidebarTab) => {
    setInternalTab(tab);
    onTabChange?.(tab);
  };

  const query = search.trim().toLowerCase();

  const groupedMaps = useMemo(() => {
    const items = xdf?.items ?? [];
    const categoriesMap = xdf?.categories ?? {};

    const filtered = items.filter((item) => {
      if (mapFilter === 'changed' && !changedItemIds.has(item.id)) return false;
      if (!query) return true;
      const addrHex = formatHex(item.data.address).toLowerCase();
      return (
        item.title.toLowerCase().includes(query) ||
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
  }, [xdf, mapFilter, changedItemIds, query]);

  const filteredDiffs = useMemo(() => {
    if (!query) return diffClusters;
    return diffClusters.filter((c) => {
      const s = formatHex(c.start).toLowerCase();
      const e = formatHex(c.end).toLowerCase();
      return s.includes(query) || e.includes(query) || String(c.changedBytes).includes(query);
    });
  }, [diffClusters, query]);

  const filteredDetected = useMemo(() => {
    if (!query) return detectedCandidates;
    return detectedCandidates.filter((c) => {
      const addr = formatHex(c.address).toLowerCase();
      const dims = `${c.rows}x${c.cols}`;
      return (
        addr.includes(query) ||
        dims.includes(query) ||
        (c.domainHint?.toLowerCase().includes(query) ?? false) ||
        (c.patternLabel?.toLowerCase().includes(query) ?? false)
      );
    });
  }, [detectedCandidates, query]);

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

  const totalMaps = xdf?.items.length ?? 0;

  const tabs: { id: SidebarTab; label: string; count: number; icon: React.ReactNode }[] = [
    { id: 'maps', label: 'Maps', count: totalMaps, icon: <Layers className="w-3.5 h-3.5" /> },
    { id: 'diffs', label: 'Diffs', count: diffClusters.length, icon: <GitCompare className="w-3.5 h-3.5" /> },
    { id: 'detected', label: 'Detected', count: detectedCandidates.length, icon: <Sparkles className="w-3.5 h-3.5" /> },
    { id: 'markers', label: 'Markers', count: markers.length, icon: <Bookmark className="w-3.5 h-3.5" /> },
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
              mode === 'hex'
                ? 'bg-[#0a84ff] text-white shadow-[0_1px_8px_rgba(10,132,255,0.38)]'
                : 'text-zinc-400 hover:text-zinc-100'
            }`}
          >
            <Binary className="w-3.5 h-3.5" />
            <span>Hex Editor</span>
          </button>
          <button
            type="button"
            onClick={() => onModeChange('map')}
            className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-medium transition-all cursor-pointer ${
              mode === 'map'
                ? 'bg-[#0a84ff] text-white shadow-[0_1px_8px_rgba(10,132,255,0.38)]'
                : 'text-zinc-400 hover:text-zinc-100'
            }`}
          >
            <Table2 className="w-3.5 h-3.5" />
            <span>Map Editor</span>
          </button>
        </div>
      </div>

      {/* 4 Nav Tabs with live counts */}
      <div className="grid grid-cols-4 gap-0.5 px-2 py-1.5 border-b border-white/[0.065]">
        {tabs.map((t) => {
          const isActive = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`flex flex-col items-center justify-center gap-0.5 py-1.5 px-1 rounded-lg transition-colors cursor-pointer ${
                isActive
                  ? 'bg-white/[0.08] text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.035]'
              }`}
            >
              <div className="flex items-center gap-1">
                <span className={isActive ? 'text-zinc-100' : 'text-zinc-500'}>{t.icon}</span>
                <span className="text-[10px] font-mono tabular-nums text-zinc-400">
                  {t.count}
                </span>
              </div>
              <span className="text-[10px] font-medium tracking-tight">{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* Search Input */}
      <div className="px-2.5 py-2 border-b border-white/[0.065]">
        <div className="relative flex items-center">
          <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={
              activeTab === 'maps'
                ? 'Search maps…'
                : activeTab === 'diffs'
                  ? 'Filter hex address…'
                  : activeTab === 'detected'
                    ? 'Filter candidates…'
                    : 'Filter markers…'
            }
            className="w-full pl-8 pr-7 py-1.5 text-xs bg-[#101115] text-zinc-100 placeholder:text-zinc-500 rounded-lg border border-white/[0.065] focus:outline-none focus:border-[#0a84ff]/70 transition-colors"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 text-zinc-500 hover:text-zinc-200 cursor-pointer"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* All / Changed filter pills (Maps tab) */}
        {activeTab === 'maps' && (
          <div className="flex items-center gap-1 mt-2">
            <button
              type="button"
              onClick={() => setMapFilter('all')}
              className={`px-2.5 py-0.5 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                mapFilter === 'all'
                  ? 'bg-white/[0.09] text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]'
              }`}
            >
              All <span className="font-mono tabular-nums ml-0.5 opacity-75">{totalMaps}</span>
            </button>
            <button
              type="button"
              onClick={() => setMapFilter('changed')}
              className={`px-2.5 py-0.5 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                mapFilter === 'changed'
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]'
              }`}
            >
              Changed{' '}
              <span className="font-mono tabular-nums ml-0.5 opacity-75">
                {changedItemIds.size}
              </span>
            </button>
          </div>
        )}
      </div>

      {/* Scrollable Borderless Inset List Content */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
        {/* MAPS TAB */}
        {activeTab === 'maps' && (
          <>
            {groupedMaps.length === 0 ? (
              <div className="text-center py-10 px-4">
                <Layers className="w-5 h-5 text-zinc-600 mx-auto mb-2" />
                <p className="text-xs text-zinc-500">
                  {mapFilter === 'changed'
                    ? 'No modified maps match your filter.'
                    : 'No maps found.'}
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
                          const dims =
                            item.itemKind.kind === 'table'
                              ? `${item.data.rows}×${item.data.cols}`
                              : item.itemKind.kind === 'flag'
                                ? 'FLAG'
                                : '1×1';
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => onSelectItem(item)}
                              className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors cursor-pointer ${
                                isSelected
                                  ? 'bg-[#0a84ff]/16 text-white'
                                  : 'text-zinc-300 hover:bg-white/[0.045] hover:text-zinc-100'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-medium truncate">
                                  {item.title}
                                </span>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  {isChanged && (
                                    <span
                                      className="w-1.5 h-1.5 rounded-full bg-amber-400"
                                      title="Modified vs Stock"
                                    />
                                  )}
                                  <span
                                    className={`text-[10px] font-mono tabular-nums ${
                                      isSelected ? 'text-blue-200/80' : 'text-zinc-500'
                                    }`}
                                  >
                                    {dims}
                                  </span>
                                </div>
                              </div>
                              <div
                                className={`flex items-center justify-between mt-0.5 text-[10px] font-mono tabular-nums ${
                                  isSelected ? 'text-blue-200/65' : 'text-zinc-500'
                                }`}
                              >
                                <span>{formatHex(item.data.address)}</span>
                                <span>
                                  {item.data.bits}b
                                  {item.scaling.units ? ` · ${item.scaling.units}` : ''}
                                </span>
                              </div>
                            </button>
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
                <p className="text-xs text-zinc-500">No diff clusters vs baseline.</p>
              </div>
            ) : (
              filteredDiffs.map((cluster, idx) => {
                const span = Math.max(1, cluster.end - cluster.start);
                const matchingMap = xdf?.items.find((it) => {
                  const [s, e] = layoutByteRange(it.data);
                  return cluster.start < e && cluster.end > s;
                });
                return (
                  <button
                    key={`${cluster.start}-${idx}`}
                    type="button"
                    onClick={() => onJumpToAddress(cluster.start, true)}
                    className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-white/[0.045] transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-mono tabular-nums font-medium text-amber-300">
                        {formatHex(cluster.start)} · {formatByteSize(cluster.changedBytes)}
                      </span>
                      <span className="text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded bg-amber-500/12 text-amber-300">
                        Δ {span} B
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-[10.5px] text-zinc-400">
                      <span className="truncate">
                        {matchingMap ? matchingMap.title : 'Unmapped region'}
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
                  No detected map candidates yet. Run Map Finder in Discovery.
                </p>
              </div>
            ) : (
              filteredDetected.map((cand) => {
                const dims = `${cand.rows}×${cand.cols}`;
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
                        title="Quick-add to XDF"
                        className="w-6 h-6 rounded-md flex items-center justify-center bg-white/[0.05] hover:bg-[#0a84ff] text-zinc-400 hover:text-white transition-colors shrink-0 cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-zinc-500 truncate">
                      {cand.hasHeaderProof !== false && (
                        <span className="text-[10px] font-medium px-1.5 py-0 rounded bg-amber-500/12 text-amber-300 shrink-0">
                          Header
                        </span>
                      )}
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
                  No bookmarks saved. Press <kbd className="px-1 py-0.5 rounded bg-white/[0.07] font-mono text-[10px] text-zinc-300">M</kbd> in Hex Editor to bookmark an offset.
                </p>
              </div>
            ) : (
              filteredMarkers.map((marker) => (
                <div
                  key={marker.id}
                  onClick={() => onJumpToAddress(marker.address, true)}
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
                      title="Delete marker"
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
    </aside>
  );
};
