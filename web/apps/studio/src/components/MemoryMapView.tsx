import React, { useMemo, useState } from 'react';
import { Binary, Cpu, Database, HardDrive, Layers } from 'lucide-react';
import { DiffCluster, XDFDefinition, layoutByteRange } from '@mactuner/core';

export interface FlashPartition {
  id: string;
  name: string;
  kind: 'boot' | 'code' | 'calibration' | 'checksum' | 'free';
  start: number;
  end: number; // exclusive
  color: string;
  description?: string;
}

export interface MemoryMapViewProps {
  bytes: Uint8Array;
  baselineBytes: Uint8Array | null;
  xdf: XDFDefinition | null;
  diffClusters: DiffCluster[];
  partitions?: FlashPartition[];
  onJumpToHex: (address: number) => void;
}

function formatHex(addr: number): string {
  return `0x${Math.max(0, addr).toString(16).toUpperCase().padStart(5, '0')}`;
}

function formatSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function inferPartitions(bytes: Uint8Array, xdf: XDFDefinition | null): FlashPartition[] {
  const total = Math.max(1, bytes.length);

  // Derive calibration bounds from XDF if available
  let calStart = Math.floor(total * 0.35);
  let calEnd = Math.floor(total * 0.72);
  if (xdf && xdf.items.length > 0) {
    let minA = Infinity;
    let maxA = 0;
    for (const item of xdf.items) {
      const [s, e] = layoutByteRange(item.data);
      if (s < minA) minA = s;
      if (e > maxA) maxA = e;
    }
    if (Number.isFinite(minA) && maxA > minA) {
      calStart = Math.max(0, Math.floor(minA / 4096) * 4096);
      calEnd = Math.min(total, Math.ceil(maxA / 4096) * 4096);
    }
  }

  const bootEnd = Math.min(calStart, Math.max(4096, Math.floor(total * 0.12)));
  const cksStart = Math.min(total, Math.max(calEnd, total - Math.max(4096, Math.floor(total * 0.06))));

  const parts: FlashPartition[] = [];
  if (bootEnd > 0) {
    parts.push({
      id: 'boot',
      name: 'Bootloader / TPROT',
      kind: 'boot',
      start: 0,
      end: bootEnd,
      color: '#6366f1',
      description: 'Reset vectors, RSA/TPROT signatures & flash loader',
    });
  }
  if (calStart > bootEnd) {
    parts.push({
      id: 'code',
      name: 'ASW Program Code',
      kind: 'code',
      start: bootEnd,
      end: calStart,
      color: '#2589ff',
      description: 'ECU operating system & control algorithms',
    });
  }
  if (calEnd > calStart) {
    parts.push({
      id: 'calibration',
      name: 'Calibration Data (Maps)',
      kind: 'calibration',
      start: calStart,
      end: calEnd,
      color: '#10b981',
      description: 'Fuel, ignition, boost, torque & limiter tables',
    });
  }
  if (cksStart > calEnd) {
    parts.push({
      id: 'free',
      name: 'Free / 0xFF Erased Flash',
      kind: 'free',
      start: calEnd,
      end: cksStart,
      color: '#334155',
      description: 'Unused flash sectors available for patch routines',
    });
  }
  if (total > cksStart) {
    parts.push({
      id: 'checksum',
      name: 'Checksum / CVN Footer',
      kind: 'checksum',
      start: cksStart,
      end: total,
      color: '#a855f7',
      description: 'CRC32 / ADD32 verification blocks & ECU ID',
    });
  }

  return parts;
}

export const MemoryMapView: React.FC<MemoryMapViewProps> = ({
  bytes,
  baselineBytes,
  xdf,
  diffClusters,
  partitions: customPartitions,
  onJumpToHex,
}) => {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const partitions = useMemo(
    () => customPartitions ?? inferPartitions(bytes, xdf),
    [customPartitions, bytes, xdf],
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

  return (
    <div className="h-full overflow-y-auto bg-[#0d1016] text-slate-100 p-5 space-y-5">
      {/* 4 KPI Tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl bg-[#141821] border border-white/10 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
          <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            <span>FLASH SIZE</span>
            <HardDrive className="w-3.5 h-3.5 text-[#2589ff]" />
          </div>
          <div className="mt-2 text-xl font-mono tabular-nums font-bold text-white">
            {formatSize(stats.totalSize)}
          </div>
          <div className="mt-0.5 text-[11px] font-mono tabular-nums text-slate-500">
            {stats.totalSize.toLocaleString()} bytes
          </div>
        </div>

        <div className="rounded-xl bg-[#141821] border border-white/10 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
          <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            <span>CALIBRATION</span>
            <Layers className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <div className="mt-2 text-xl font-mono tabular-nums font-bold text-emerald-400">
            {formatSize(stats.calBytes)}
          </div>
          <div className="mt-0.5 text-[11px] font-mono tabular-nums text-slate-500">
            {stats.totalSize > 0 ? ((stats.calBytes / stats.totalSize) * 100).toFixed(1) : '0.0'}% of flash
          </div>
        </div>

        <div className="rounded-xl bg-[#141821] border border-white/10 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
          <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            <span>MODIFIED BYTES</span>
            <Cpu className="w-3.5 h-3.5 text-[#f59e0b]" />
          </div>
          <div className="mt-2 text-xl font-mono tabular-nums font-bold text-[#fbbf24]">
            {stats.modifiedBytes.toLocaleString()} B
          </div>
          <div className="mt-0.5 text-[11px] font-mono tabular-nums text-slate-500">
            {diffClusters.length} diff cluster{diffClusters.length === 1 ? '' : 's'}
          </div>
        </div>

        <div className="rounded-xl bg-[#141821] border border-white/10 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
          <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            <span>FREE SPACE</span>
            <Database className="w-3.5 h-3.5 text-slate-400" />
          </div>
          <div className="mt-2 text-xl font-mono tabular-nums font-bold text-slate-200">
            {formatSize(stats.freeBytes)}
          </div>
          <div className="mt-0.5 text-[11px] font-mono tabular-nums text-slate-500">
            0xFF / 0x00 padding
          </div>
        </div>
      </div>

      {/* macOS Storage-style Proportional Flash Partition Bar */}
      <div className="rounded-xl bg-[#141821] border border-white/10 p-4 space-y-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-white">Flash Partition Layout</h2>
            <p className="text-xs text-slate-400">
              Click any segment to jump directly to its start offset in the Hex Editor.
            </p>
          </div>
          {hoveredEntry ? (
            <div className="text-right font-mono tabular-nums text-xs">
              <span className="text-white font-semibold">{hoveredEntry.part.name}</span>
              <span className="text-slate-400 ml-2">
                {formatHex(hoveredEntry.part.start)}–{formatHex(hoveredEntry.part.end)} ({formatSize(hoveredEntry.size)})
              </span>
            </div>
          ) : (
            <span className="text-xs font-mono tabular-nums text-slate-500">
              0x00000 — {formatHex(bytes.length)}
            </span>
          )}
        </div>

        {/* Horizontal Bar */}
        <div className="relative h-10 w-full rounded-lg overflow-hidden bg-[#0d1016] border border-white/10 flex gap-[2px] p-0.5">
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
                  isHovered ? 'brightness-125 ring-2 ring-white/60 z-10' : 'opacity-90 hover:opacity-100'
                }`}
              >
                {pct >= 12 && (
                  <span className="absolute inset-0 flex items-center justify-center text-[11px] font-medium text-white drop-shadow truncate px-2">
                    {part.name}
                  </span>
                )}
                {/* Orange diff bottom strip */}
                {diffCount > 0 && (
                  <span
                    className="absolute bottom-0 left-0 right-0 h-1.5 bg-[#f59e0b] shadow-[0_0_8px_rgba(245,158,11,0.9)]"
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
              className="flex items-center gap-1.5 text-slate-300 hover:text-white transition-colors"
            >
              <span
                className="w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: part.color }}
              />
              <span>{part.name}</span>
              <span className="font-mono tabular-nums text-slate-500">{formatSize(size)}</span>
              {diffCount > 0 && (
                <span className="text-[10px] font-mono tabular-nums text-[#fbbf24]">
                  (Δ{diffCount} B)
                </span>
              )}
            </button>
          ))}
          <div className="flex items-center gap-1.5 text-slate-400 ml-auto">
            <span className="w-3 h-1.5 rounded-sm bg-[#f59e0b]" />
            <span className="text-[11px]">Modified region</span>
          </div>
        </div>
      </div>

      {/* Sector / Partition Breakdown Table */}
      <div className="rounded-xl bg-[#141821] border border-white/10 overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Sector / Partition Breakdown
          </h3>
          <span className="text-[11px] font-mono tabular-nums text-slate-500">
            {partitionMeta.length} regions
          </span>
        </div>

        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-white/10 bg-white/[0.02] text-[11px] uppercase tracking-wider text-slate-400">
              <th className="py-2.5 px-4 font-semibold">Partition / Region</th>
              <th className="py-2.5 px-4 font-semibold">Address Range</th>
              <th className="py-2.5 px-4 font-semibold">Size</th>
              <th className="py-2.5 px-4 font-semibold">Status / Diff</th>
              <th className="py-2.5 px-4 font-semibold text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.06] text-xs">
            {partitionMeta.map(({ part, size, diffCount, pct }) => (
              <tr
                key={part.id}
                onMouseEnter={() => setHoveredId(part.id)}
                onMouseLeave={() => setHoveredId(null)}
                className="hover:bg-white/[0.03] transition-colors"
              >
                <td className="py-3 px-4">
                  <div className="flex items-center gap-2.5">
                    <span
                      className="w-2.5 h-2.5 rounded-sm shrink-0"
                      style={{ backgroundColor: part.color }}
                    />
                    <div>
                      <div className="font-medium text-slate-100">{part.name}</div>
                      {part.description && (
                        <div className="text-[11px] text-slate-500">{part.description}</div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="py-3 px-4 font-mono tabular-nums text-slate-300">
                  {formatHex(part.start)} – {formatHex(part.end)}
                </td>
                <td className="py-3 px-4 font-mono tabular-nums text-slate-300">
                  {formatSize(size)}{' '}
                  <span className="text-slate-500 text-[11px]">({pct.toFixed(1)}%)</span>
                </td>
                <td className="py-3 px-4">
                  {diffCount > 0 ? (
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#f59e0b]/15 text-[#fbbf24] border border-[#f59e0b]/35 font-mono tabular-nums text-[11px]">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b]" />
                      {diffCount} B modified
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.05] text-slate-400 border border-white/10 text-[11px]">
                      Unmodified
                    </span>
                  )}
                </td>
                <td className="py-3 px-4 text-right">
                  <button
                    type="button"
                    onClick={() => onJumpToHex(part.start)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/[0.06] hover:bg-[#2589ff]/20 hover:text-[#6ab0ff] text-slate-200 border border-white/10 text-[11px] font-medium transition-colors"
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
  );
};
