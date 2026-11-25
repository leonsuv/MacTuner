import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Binary,
  Cpu,
  Database,
  GitBranch,
  HardDrive,
  Layers,
  Link2,
  Lock,
  Search,
} from 'lucide-react';
import {
  DiffCluster,
  PflashPartition,
  XDFDefinition,
  findSharedAxes,
  parsePflashPartitions,
} from '@mactuner/core';

export interface FlashPartition {
  id: string;
  name: string;
  kind: 'boot' | 'code' | 'calibration' | 'checksum' | 'free';
  start: number;
  end: number; // exclusive
  color: string;
  description?: string;
  tprotLocked?: boolean;
}

export interface MemoryMapViewProps {
  bytes: Uint8Array;
  baselineBytes: Uint8Array | null;
  xdf: XDFDefinition | null;
  diffClusters: DiffCluster[];
  partitions?: FlashPartition[];
  onJumpToHex: (address: number) => void;
  onSelectMap?: (itemId: number) => void;
}

type MemorySubTab = 'partitions' | 'shared-axes';

function formatHex(addr: number): string {
  return `0x${Math.max(0, addr).toString(16).toUpperCase().padStart(5, '0')}`;
}

function formatSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function mapPflashToUi(p: PflashPartition): FlashPartition {
  const kindMap: Record<PflashPartition['kind'], FlashPartition['kind']> = {
    boot: 'boot',
    tprot: 'boot',
    asw: 'code',
    cal: 'calibration',
    checksum: 'checksum',
    empty: 'free',
  };
  const colorMap: Record<PflashPartition['kind'], string> = {
    boot: '#6366f1',
    tprot: '#ef4444',
    asw: '#0a84ff',
    cal: '#10b981',
    checksum: '#a855f7',
    empty: '#3f3f46',
  };
  const descParts: string[] = [];
  if (p.tprotLocked) descParts.push('TPROT / OTP Protected');
  if (p.swIdentifier) descParts.push(`SW: ${p.swIdentifier}`);
  if (p.variantString) descParts.push(p.variantString);
  if (descParts.length === 0) {
    if (p.kind === 'boot') descParts.push('Reset vectors & flash loader');
    else if (p.kind === 'tprot') descParts.push('Protected RSA / OTP sector');
    else if (p.kind === 'cal') descParts.push('Calibration tables & scalars');
    else if (p.kind === 'checksum') descParts.push('Checksum / signature footer');
    else if (p.kind === 'empty') descParts.push('Erased 0xFF / 0x00 flash');
    else descParts.push('ECU application program code');
  }
  return {
    id: p.id,
    name: p.name,
    kind: kindMap[p.kind],
    start: p.start,
    end: p.end,
    color: colorMap[p.kind],
    description: descParts.join(' · '),
    tprotLocked: p.tprotLocked,
  };
}

export const MemoryMapView: React.FC<MemoryMapViewProps> = ({
  bytes,
  baselineBytes,
  xdf,
  diffClusters,
  partitions: customPartitions,
  onJumpToHex,
  onSelectMap,
}) => {
  const [subTab, setSubTab] = useState<MemorySubTab>('partitions');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [axisSearch, setAxisSearch] = useState<string>('');

  const partitions = useMemo(
    () => customPartitions ?? parsePflashPartitions(bytes).map(mapPflashToUi),
    [customPartitions, bytes],
  );

  const sharedAxes = useMemo(() => findSharedAxes(bytes, xdf), [bytes, xdf]);

  const filteredSharedAxes = useMemo(() => {
    const q = axisSearch.trim().toLowerCase();
    if (!q) return sharedAxes;
    return sharedAxes.filter(
      (ax) =>
        formatHex(ax.address).toLowerCase().includes(q) ||
        ax.units.toLowerCase().includes(q) ||
        ax.preview.toLowerCase().includes(q) ||
        ax.referencingMaps.some((m) => m.title.toLowerCase().includes(q)),
    );
  }, [sharedAxes, axisSearch]);

  const totalSharedRefs = useMemo(
    () => sharedAxes.reduce((acc, ax) => acc + ax.referencingMaps.length, 0),
    [sharedAxes],
  );

  const stats = useMemo(() => {
    const totalSize = bytes.length;
    let modifiedBytes = 0;
    if (baselineBytes && baselineBytes.length === bytes.length) {
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== baselineBytes[i]) modifiedBytes++;
      }
    } else {
      modifiedBytes = diffClusters.reduce((acc, c) => acc + c.changedBytes, 0);
    }

    let freeBytes = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0xff || bytes[i] === 0x00) freeBytes++;
    }

    const calBytes = partitions
      .filter((p) => p.kind === 'calibration')
      .reduce((acc, p) => acc + (p.end - p.start), 0);

    return { totalSize, calBytes, modifiedBytes, freeBytes };
  }, [bytes, baselineBytes, diffClusters, partitions]);

  const partitionMeta = useMemo(() => {
    return partitions.map((part) => {
      const size = Math.max(0, part.end - part.start);
      let diffCount = 0;
      if (baselineBytes && baselineBytes.length >= part.end) {
        for (let i = part.start; i < part.end; i++) {
          if (bytes[i] !== baselineBytes[i]) diffCount++;
        }
      } else {
        for (const c of diffClusters) {
          const ovStart = Math.max(part.start, c.start);
          const ovEnd = Math.min(part.end, c.end);
          if (ovEnd > ovStart) diffCount += ovEnd - ovStart;
        }
      }
      const pct = bytes.length > 0 ? (size / bytes.length) * 100 : 0;
      return { part, size, diffCount, pct };
    });
  }, [partitions, bytes, baselineBytes, diffClusters]);

  const hoveredEntry = partitionMeta.find((m) => m.part.id === hoveredId) ?? null;

  const handleOpenReferencingMap = (mapId: number, fallbackAddr: number) => {
    if (onSelectMap) {
      onSelectMap(mapId);
      return;
    }
    const found = xdf?.items.find((it) => it.id === mapId);
    onJumpToHex(found ? found.data.address : fallbackAddr);
  };

  return (
    <div className="h-full flex flex-col bg-[#0c0d10] text-zinc-100 overflow-hidden">
      {/* Sub-Tab Header */}
      <div className="px-5 py-3 border-b border-white/[0.065] bg-[#121317] flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] border border-white/[0.065]">
          <button
            type="button"
            onClick={() => setSubTab('partitions')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[11.5px] font-medium transition-all cursor-pointer ${
              subTab === 'partitions'
                ? 'bg-[#0a84ff] text-white shadow-[0_1px_10px_rgba(10,132,255,0.4)]'
                : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
            }`}
          >
            <HardDrive className="w-3.5 h-3.5" />
            <span>Flash Partitions</span>
          </button>
          <button
            type="button"
            onClick={() => setSubTab('shared-axes')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[11.5px] font-medium transition-all cursor-pointer ${
              subTab === 'shared-axes'
                ? 'bg-[#0a84ff] text-white shadow-[0_1px_10px_rgba(10,132,255,0.4)]'
                : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
            }`}
          >
            <GitBranch className="w-3.5 h-3.5" />
            <span>Shared-Axis Pool ({sharedAxes.length})</span>
          </button>
        </div>

        <div className="text-[11.5px] font-mono tabular-nums text-zinc-400">
          0x00000 — {formatHex(bytes.length)} · {formatSize(bytes.length)}
        </div>
      </div>

      {/* TAB 1: FLASH PARTITIONS */}
      {subTab === 'partitions' && (
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* 4 KPI Tiles */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                <span>FLASH SIZE</span>
                <HardDrive className="w-3.5 h-3.5 text-[#0a84ff]" />
              </div>
              <div className="mt-2 text-xl font-mono tabular-nums font-bold text-white">
                {formatSize(stats.totalSize)}
              </div>
              <div className="mt-0.5 text-[11px] font-mono tabular-nums text-zinc-500">
                {stats.totalSize.toLocaleString()} bytes
              </div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                <span>CALIBRATION</span>
                <Layers className="w-3.5 h-3.5 text-emerald-400" />
              </div>
              <div className="mt-2 text-xl font-mono tabular-nums font-bold text-emerald-400">
                {formatSize(stats.calBytes)}
              </div>
              <div className="mt-0.5 text-[11px] font-mono tabular-nums text-zinc-500">
                {stats.totalSize > 0 ? ((stats.calBytes / stats.totalSize) * 100).toFixed(1) : '0.0'}% of flash
              </div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                <span>MODIFIED BYTES</span>
                <Cpu className="w-3.5 h-3.5 text-amber-400" />
              </div>
              <div className="mt-2 text-xl font-mono tabular-nums font-bold text-amber-400">
                {stats.modifiedBytes.toLocaleString()} B
              </div>
              <div className="mt-0.5 text-[11px] font-mono tabular-nums text-zinc-500">
                {diffClusters.length} diff cluster{diffClusters.length === 1 ? '' : 's'}
              </div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                <span>FREE SPACE</span>
                <Database className="w-3.5 h-3.5 text-zinc-400" />
              </div>
              <div className="mt-2 text-xl font-mono tabular-nums font-bold text-zinc-200">
                {formatSize(stats.freeBytes)}
              </div>
              <div className="mt-0.5 text-[11px] font-mono tabular-nums text-zinc-500">
                0xFF / 0x00 padding
              </div>
            </div>
          </div>

          {/* macOS Storage-style Proportional Flash Partition Bar */}
          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 space-y-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <h2 className="text-sm font-semibold tracking-[-0.01em] text-white">
                  Flash Partition Layout
                </h2>
                <p className="text-xs text-zinc-400">
                  Click any segment to jump directly to its start offset in the Hex Editor.
                </p>
              </div>
              {hoveredEntry ? (
                <div className="text-right font-mono tabular-nums text-xs">
                  <span className="text-white font-semibold">{hoveredEntry.part.name}</span>
                  <span className="text-zinc-400 ml-2">
                    {formatHex(hoveredEntry.part.start)}–{formatHex(hoveredEntry.part.end)} (
                    {formatSize(hoveredEntry.size)})
                  </span>
                </div>
              ) : (
                <span className="text-xs font-mono tabular-nums text-zinc-500">
                  0x00000 — {formatHex(bytes.length)}
                </span>
              )}
            </div>

            {/* Horizontal Bar */}
            <div className="relative h-10 w-full rounded-lg overflow-hidden bg-[#0c0d10] border border-white/[0.065] flex gap-[2px] p-0.5">
              {partitionMeta.map(({ part, size, diffCount, pct }) => {
                const isHovered = hoveredId === part.id;
                return (
                  <button
                    key={part.id}
                    type="button"
                    onMouseEnter={() => setHoveredId(part.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    onClick={() => onJumpToHex(part.start)}
                    style={{
                      width: `${Math.max(pct, 2)}%`,
                      backgroundColor: part.color,
                    }}
                    title={`${part.name} · ${formatHex(part.start)}–${formatHex(part.end)} (${formatSize(size)})${diffCount > 0 ? ` · ${diffCount} B modified` : ''}`}
                    className={`relative h-full rounded-[4px] transition-all cursor-pointer overflow-hidden ${
                      isHovered
                        ? 'brightness-125 ring-2 ring-white/60 z-10'
                        : 'opacity-90 hover:opacity-100'
                    }`}
                  >
                    {pct >= 12 && (
                      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-medium text-white drop-shadow truncate px-2">
                        {part.name}
                      </span>
                    )}
                    {diffCount > 0 && (
                      <span
                        className="absolute bottom-0 left-0 right-0 h-1.5 bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.9)]"
                        aria-label={`${diffCount} bytes modified`}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Legend Row */}
            <div className="flex items-center flex-wrap gap-x-5 gap-y-1.5 pt-1 text-xs">
              {partitionMeta.map(({ part, size, diffCount }) => (
                <button
                  key={part.id}
                  type="button"
                  onClick={() => onJumpToHex(part.start)}
                  onMouseEnter={() => setHoveredId(part.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  className="flex items-center gap-1.5 text-zinc-300 hover:text-white transition-colors cursor-pointer"
                >
                  <span
                    className="w-2.5 h-2.5 rounded-sm shrink-0"
                    style={{ backgroundColor: part.color }}
                  />
                  <span>{part.name}</span>
                  <span className="font-mono tabular-nums text-zinc-500">{formatSize(size)}</span>
                  {diffCount > 0 && (
                    <span className="text-[10px] font-mono tabular-nums text-amber-400">
                      (Δ{diffCount} B)
                    </span>
                  )}
                </button>
              ))}
              <div className="flex items-center gap-1.5 text-zinc-400 ml-auto">
                <span className="w-3 h-1.5 rounded-sm bg-amber-400" />
                <span className="text-[11px]">Modified region</span>
              </div>
            </div>
          </div>

          {/* Sector / Partition Breakdown Table */}
          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="px-4 py-3 border-b border-white/[0.065] flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                Sector / Partition Breakdown
              </h3>
              <span className="text-[11px] font-mono tabular-nums text-zinc-500">
                {partitionMeta.length} regions
              </span>
            </div>

            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/[0.065] bg-white/[0.02] text-[10.5px] uppercase tracking-wider text-zinc-500">
                  <th className="py-2.5 px-4 font-semibold">Partition / Region</th>
                  <th className="py-2.5 px-4 font-semibold">Address Range</th>
                  <th className="py-2.5 px-4 font-semibold">Size</th>
                  <th className="py-2.5 px-4 font-semibold">Status / Diff</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05] text-xs">
                {partitionMeta.map(({ part, size, diffCount, pct }) => (
                  <tr
                    key={part.id}
                    onMouseEnter={() => setHoveredId(part.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    className="hover:bg-white/[0.025] transition-colors"
                  >
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2.5">
                        <span
                          className="w-2.5 h-2.5 rounded-sm shrink-0"
                          style={{ backgroundColor: part.color }}
                        />
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-zinc-100">{part.name}</span>
                            {part.tprotLocked && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/35 text-[10px] font-semibold">
                                <Lock className="w-2.5 h-2.5" />
                                TPROT / OTP
                              </span>
                            )}
                          </div>
                          {part.description && (
                            <div className="text-[11px] text-zinc-500">{part.description}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-zinc-300">
                      {formatHex(part.start)} – {formatHex(part.end)}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-zinc-300">
                      {formatSize(size)}{' '}
                      <span className="text-zinc-500 text-[11px]">({pct.toFixed(1)}%)</span>
                    </td>
                    <td className="py-3 px-4">
                      {diffCount > 0 ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 font-mono tabular-nums text-[11px]">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                          {diffCount} B modified
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.04] text-zinc-400 border border-white/[0.065] text-[11px]">
                          Unmodified
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => onJumpToHex(part.start)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/[0.05] hover:bg-[#0a84ff]/20 hover:text-[#5ac8fa] text-zinc-200 border border-white/[0.08] text-[11px] font-medium transition-colors cursor-pointer"
                      >
                        <Binary className="w-3 h-3" />
                        <span>In Hex</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: SHARED-AXIS POOL (COM_AXIS) */}
      {subTab === 'shared-axes' && (
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 flex items-center justify-between gap-4 flex-wrap shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
                <Link2 className="w-4 h-4 text-amber-400" />
              </div>
              <div>
                <h2 className="text-sm font-semibold tracking-[-0.01em] text-white">
                  Shared-Axis Pool (COM_AXIS)
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  {sharedAxes.length} shared axis address{sharedAxes.length === 1 ? '' : 'es'} referenced by{' '}
                  {totalSharedRefs} map axes. Editing a shared breakpoint updates every linked map simultaneously.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={axisSearch}
                  onChange={(e) => setAxisSearch(e.target.value)}
                  placeholder="Filter address, unit, map..."
                  className="pl-8 pr-3 py-1.5 rounded-lg bg-[#0c0d10] border border-white/[0.08] text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-[#0a84ff] w-56"
                />
              </div>
              {sharedAxes.length > 0 && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[11px] font-medium">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Coupled Breakpoints
                </span>
              )}
            </div>
          </div>

          {filteredSharedAxes.length === 0 ? (
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-12 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <GitBranch className="w-9 h-9 text-zinc-600 mx-auto mb-3" />
              <h3 className="text-sm font-semibold text-zinc-200">
                {sharedAxes.length > 0
                  ? 'No shared axes match your search'
                  : 'No shared COM_AXIS addresses found'}
              </h3>
              <p className="text-xs text-zinc-500 max-w-md mx-auto mt-1">
                {sharedAxes.length > 0
                  ? 'Try clearing the search query above.'
                  : xdf
                    ? 'All X/Y axes in the current XDF definition occupy distinct binary addresses.'
                    : 'Load an XDF definition to analyze shared axis references across maps.'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredSharedAxes.map((entry) => (
                <div
                  key={entry.address}
                  className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 space-y-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] hover:border-white/[0.12] transition-colors"
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span className="px-2.5 py-1 rounded-md bg-[#0a84ff]/15 border border-[#0a84ff]/35 font-mono tabular-nums text-xs font-semibold text-[#5ac8fa]">
                        {formatHex(entry.address)}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-white/[0.05] border border-white/[0.065] font-mono tabular-nums text-[11px] text-zinc-300">
                        {entry.count} pts · {entry.bits}-bit
                      </span>
                      {entry.units && (
                        <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/25 text-[11px] font-medium text-emerald-300">
                          {entry.units}
                        </span>
                      )}
                      <span className="text-[11px] font-medium text-amber-300">
                        {entry.referencingMaps.length} referencing maps
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => onJumpToHex(entry.address)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/[0.05] hover:bg-[#0a84ff]/20 hover:text-[#5ac8fa] text-zinc-200 border border-white/[0.08] text-[11px] font-medium transition-colors cursor-pointer"
                    >
                      <Binary className="w-3 h-3" />
                      <span>Axis in Hex</span>
                    </button>
                  </div>

                  {/* Breakpoint Preview */}
                  <div className="px-3 py-2 rounded-lg bg-[#0c0d10] border border-white/[0.06] font-mono tabular-nums text-xs text-zinc-300 overflow-x-auto">
                    <span className="text-zinc-500 mr-2 select-none">Breakpoints:</span>
                    {entry.preview}
                    {entry.units ? <span className="text-zinc-500 ml-1.5">{entry.units}</span> : null}
                  </div>

                  {/* Clickable Referencing Maps */}
                  <div className="flex items-center flex-wrap gap-2">
                    {entry.referencingMaps.map((ref, idx) => (
                      <button
                        key={`${ref.id}-${ref.axis}-${idx}`}
                        type="button"
                        onClick={() => handleOpenReferencingMap(ref.id, entry.address)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-[#0a84ff]/15 hover:border-[#0a84ff]/40 border border-white/[0.07] text-xs text-zinc-200 transition-colors cursor-pointer"
                      >
                        <span className="px-1.5 py-0.2 rounded bg-white/[0.08] font-mono text-[10px] font-semibold text-zinc-300">
                          {ref.axis}
                        </span>
                        <span>{ref.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
