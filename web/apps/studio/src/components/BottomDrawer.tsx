import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Box,
  CheckCircle2,
  ExternalLink,
  HardDrive,
  ShieldAlert,
  Wand2,
  X,
} from 'lucide-react';
import {
  BinCodec,
  cellOffset,
  elementBytes,
  parsePflashPartitions,
  scalingRawFor,
  scalingValue,
  type Cell,
  type HeatmapPalette,
  type Patch,
  type XDFItem,
} from '@mactuner/core';
import { Surface3DCanvas, type DatalogPoint3D } from './Surface3DCanvas';

export type BottomDrawerTab = 'surface3d' | 'datalog' | 'preflight';

export interface BottomDrawerDatalogSummary {
  enabled: boolean;
  frameIndex: number;
  xChannel: string;
  yChannel: string;
  xValue?: number;
  yValue?: number;
  hitCellCount: number;
  points3d: DatalogPoint3D[];
  activeCell: Cell | null;
}

export interface BottomDrawerProps {
  open: boolean;
  onClose: () => void;
  item: XDFItem | null;
  bin: Uint8Array;
  compareBin: Uint8Array | null;
  heatmapPalette: HeatmapPalette;
  isLocked?: boolean;
  onApplyPatches: (patches: Patch[], label: string) => void;
  onJumpToHex: (address: number) => void;
  onOpenXdfEditor?: () => void;
  onResetMap?: (item: XDFItem) => void;
  invalidChecksumCount: number;
  checksumPluginName?: string;
  onFixChecksums: () => void;
  onOpenDatalogView: () => void;
  onOpenFlashView: () => void;
  datalogSummary: BottomDrawerDatalogSummary;
}

const MIN_HEIGHT = 180;
const MAX_HEIGHT = 460;

function formatHex(addr: number): string {
  return `0x${Math.max(0, addr).toString(16).toUpperCase().padStart(5, '0')}`;
}

function partitionColor(kind: string): string {
  switch (kind) {
    case 'boot':
      return '#6366f1';
    case 'tprot':
      return '#ef4444';
    case 'asw':
      return '#0a84ff';
    case 'cal':
      return '#10b981';
    case 'checksum':
      return '#a855f7';
    default:
      return '#3f3f46';
  }
}

export const BottomDrawer: React.FC<BottomDrawerProps> = ({
  open,
  onClose,
  item,
  bin,
  compareBin,
  heatmapPalette,
  isLocked = false,
  onApplyPatches,
  onJumpToHex,
  onOpenXdfEditor,
  onResetMap,
  invalidChecksumCount,
  checksumPluginName,
  onFixChecksums,
  onOpenDatalogView,
  onOpenFlashView,
  datalogSummary,
}) => {
  const [tab, setTab] = useState<BottomDrawerTab>('surface3d');
  const [height, setHeight] = useState<number>(260);
  const [hoveredCell, setHoveredCell] = useState<Cell | null>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startH: height };
      const onMove = (ev: PointerEvent) => {
        if (!dragRef.current) return;
        const delta = dragRef.current.startY - ev.clientY;
        setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, dragRef.current.startH + delta)));
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [height],
  );

  const surfaceData = useMemo(() => {
    if (!item || item.itemKind.kind !== 'table' || item.data.rows < 2 || item.data.cols < 2) {
      return null;
    }
    const layout = item.data;
    const values: (number | null)[][] = [];
    const compareValues: (number | null)[][] | null = compareBin ? [] : null;
    for (let r = 0; r < layout.rows; r++) {
      const row: (number | null)[] = [];
      const cmpRow: (number | null)[] = [];
      for (let c = 0; c < layout.cols; c++) {
        const raw = BinCodec.raw(layout, { r, c }, bin);
        row.push(raw === null ? null : scalingValue(item.scaling, raw));
        if (compareBin) {
          const cRaw = BinCodec.raw(layout, { r, c }, compareBin);
          cmpRow.push(cRaw === null ? null : scalingValue(item.scaling, cRaw));
        }
      }
      values.push(row);
      if (compareValues) compareValues.push(cmpRow);
    }
    const xLabels = BinCodec.axisLabels(item.itemKind.x, layout.cols, bin);
    const yLabels = BinCodec.axisLabels(item.itemKind.y, layout.rows, bin);
    return { values, compareValues, xLabels, yLabels };
  }, [item, bin, compareBin]);

  const handleEditCell = useCallback(
    (cell: Cell, newValue: number) => {
      if (!item || isLocked) return;
      const layout = item.data;
      const offset = cellOffset(layout, cell);
      const size = elementBytes(layout);
      if (offset < 0 || offset + size > bin.length) return;
      const raw = scalingRawFor(item.scaling, newValue, layout);
      if (raw === null) return;
      const next = BinCodec.encode(layout, raw);
      const old = bin.slice(offset, offset + size);
      onApplyPatches([{ offset, old, next }], `3D Edit ${item.title} [${cell.r},${cell.c}]`);
    },
    [item, isLocked, bin, onApplyPatches],
  );

  const partitions = useMemo(() => parsePflashPartitions(bin), [bin]);

  if (!open) return null;

  return (
    <section
      style={{ height }}
      className="shrink-0 flex flex-col border-t border-white/[0.08] bg-[#111216] select-none"
    >
      {/* Drag Resize Handle */}
      <div
        onPointerDown={onResizePointerDown}
        className="h-1.5 w-full cursor-ns-resize bg-transparent hover:bg-[#0a84ff]/40 transition-colors"
        title="Drag to resize bottom drawer"
      />

      {/* Drawer Tab Bar */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-white/[0.06] px-3">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTab('surface3d')}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition cursor-pointer ${
              tab === 'surface3d'
                ? 'bg-[#0a84ff]/20 text-sky-300'
                : 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200'
            }`}
          >
            <Box className="h-3.5 w-3.5" />
            <span>3D Surface</span>
            {item && <span className="text-[10px] text-zinc-500 max-w-[140px] truncate">· {item.title}</span>}
          </button>
          <button
            type="button"
            onClick={() => setTab('datalog')}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition cursor-pointer ${
              tab === 'datalog'
                ? 'bg-emerald-500/20 text-emerald-300'
                : 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200'
            }`}
          >
            <Activity className="h-3.5 w-3.5" />
            <span>Datalog Trace</span>
            {datalogSummary.enabled && (
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setTab('preflight')}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition cursor-pointer ${
              tab === 'preflight'
                ? 'bg-purple-500/20 text-purple-300'
                : 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200'
            }`}
          >
            <HardDrive className="h-3.5 w-3.5" />
            <span>Preflight & Atlas</span>
            {invalidChecksumCount > 0 && (
              <span className="rounded-full bg-rose-500/20 px-1.5 text-[10px] font-mono text-rose-300">
                {invalidChecksumCount}
              </span>
            )}
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          title="Close Bottom Drawer (⇧⌘Y)"
          className="rounded-md p-1 text-zinc-400 hover:bg-white/[0.06] hover:text-white transition cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Drawer Body */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'surface3d' && (
          <div className="h-full w-full">
            {surfaceData && item ? (
              <Surface3DCanvas
                values={surfaceData.values}
                compareValues={surfaceData.compareValues}
                xLabels={surfaceData.xLabels}
                yLabels={surfaceData.yLabels}
                units={item.scaling.units}
                decimals={item.scaling.decimals}
                hoveredCell={hoveredCell}
                onHoverCell={setHoveredCell}
                onEditCell={handleEditCell}
                isLocked={isLocked}
                heatmapPalette={heatmapPalette}
                datalogPoints={datalogSummary.points3d}
                datalogActiveCell={datalogSummary.activeCell}
                onJumpToHex={() => onJumpToHex(item.data.address)}
                onOpenXdfEditor={onOpenXdfEditor}
                onResetToOriginal={onResetMap ? () => onResetMap(item) : undefined}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-zinc-500">
                Select a 2D table map (at least 2×2) to preview its live 3D surface.
              </div>
            )}
          </div>
        )}

        {tab === 'datalog' && (
          <div className="flex h-full items-center justify-between gap-4 px-5 py-3 overflow-y-auto">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                    datalogSummary.enabled
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : 'bg-white/[0.06] text-zinc-400'
                  }`}
                >
                  <Activity className="h-3 w-3" />
                  {datalogSummary.enabled ? 'Overlay Active' : 'Overlay Idle'}
                </span>
                <span className="font-mono text-xs text-zinc-400">
                  Frame #{datalogSummary.frameIndex}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500">X Channel</div>
                  <div className="font-mono text-zinc-100 mt-0.5">
                    {datalogSummary.xChannel || 'RPM'}
                    {datalogSummary.xValue !== undefined ? ` = ${datalogSummary.xValue.toFixed(1)}` : ''}
                  </div>
                </div>
                <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500">Y Channel</div>
                  <div className="font-mono text-zinc-100 mt-0.5">
                    {datalogSummary.yChannel || 'Load'}
                    {datalogSummary.yValue !== undefined ? ` = ${datalogSummary.yValue.toFixed(1)}` : ''}
                  </div>
                </div>
                <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500">Hit Cells</div>
                  <div className="font-mono text-emerald-300 mt-0.5">
                    {datalogSummary.hitCellCount} cells · {datalogSummary.points3d.length} 3D pts
                  </div>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={onOpenDatalogView}
              className="flex items-center gap-1.5 rounded-lg bg-[#0a84ff] px-3 py-2 text-xs font-semibold text-white hover:bg-[#1e8fff] transition shrink-0 cursor-pointer"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>Open Datalog & Dyno</span>
            </button>
          </div>
        )}

        {tab === 'preflight' && (
          <div className="flex h-full flex-col justify-between px-5 py-3 overflow-y-auto gap-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                {invalidChecksumCount === 0 ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-300">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    All Checksums Valid
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/15 px-3 py-1 text-xs font-semibold text-rose-300">
                    <ShieldAlert className="h-3.5 w-3.5" />
                    {invalidChecksumCount} Invalid Checksum Block(s)
                  </span>
                )}
                {checksumPluginName && (
                  <span className="text-xs text-zinc-400 font-mono">{checksumPluginName}</span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {invalidChecksumCount > 0 && (
                  <button
                    type="button"
                    onClick={onFixChecksums}
                    className="flex items-center gap-1.5 rounded-lg bg-emerald-500/20 border border-emerald-500/35 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/30 transition cursor-pointer"
                  >
                    <Wand2 className="h-3.5 w-3.5" />
                    <span>Fix Checksums</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={onOpenFlashView}
                  className="flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-white/[0.1] transition cursor-pointer"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>Full Preflight</span>
                </button>
              </div>
            </div>

            {/* Compact PFLASH Partition Bar */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[10.5px] text-zinc-400">
                <span className="font-medium uppercase tracking-wider">PFLASH Partition Atlas</span>
                <span className="font-mono">{partitions.length} partitions · {Math.round(bin.length / 1024)} KB</span>
              </div>
              <div className="flex h-7 w-full overflow-hidden rounded-lg border border-white/[0.08] bg-[#0b0c0f]">
                {partitions.map((p) => {
                  const pct = Math.max(2, ((p.end - p.start) / Math.max(1, bin.length)) * 100);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => onJumpToHex(p.start)}
                      style={{ width: `${pct}%`, backgroundColor: `${partitionColor(p.kind)}cc` }}
                      title={`${p.name} (${formatHex(p.start)}–${formatHex(p.end)})${p.tprotLocked ? ' · TPROT' : ''}`}
                      className="h-full border-r border-black/30 px-1 text-[10px] font-mono text-white/90 truncate hover:brightness-125 transition cursor-pointer"
                    >
                      {p.name}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
