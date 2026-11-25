import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  ArrowUpRight,
  Binary,
  CheckCircle2,
  FileDiff,
  FilePlus2,
  History,
  Layers,
  Plus,
  Search,
  Sparkles,
  Star,
  Table2,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  BinCodec,
  applyPatches,
  cellDiffers,
  countChangedBytes,
  countChangedCells,
  diffClusters,
  importDefinition,
  parseBinaryFile,
  scalingDisplay,
  scalingFormat,
  scalingValue,
  type DataLayout,
  type Scaling,
  type Snapshot,
  type XDFDefinition,
  type XDFItem,
} from '@mactuner/core';

export interface MultiCompareViewProps {
  bin: Uint8Array;
  binName?: string;
  compareBin?: Uint8Array | null;
  compareName?: string;
  xdf?: XDFDefinition | null;
  snapshots?: Snapshot[];
  onSelectMap?: (itemId: number) => void;
  onJumpToHex?: (address: number) => void;
  onAddExtraBin?: (fileName: string, bytes: Uint8Array) => void;
  onOpenPairInHex?: (
    baseBytes: Uint8Array,
    compareBytes: Uint8Array,
    address: number,
    baseName: string,
    compareName: string,
  ) => void;
  onPortTune?: () => void;
  onSwitchSection?: (section: string) => void;
}

type CompareDisplayMode = 'values' | 'delta' | 'percent';

interface ExtraSlot {
  id: string;
  name: string;
  bytes: Uint8Array;
}

interface CompareSlot {
  id: string;
  name: string;
  bytes: Uint8Array;
  color: string;
  removable: boolean;
  role: string;
}

const SLOT_COLORS = ['#0a84ff', '#f59e0b', '#10b981', '#a855f7', '#ec4899', '#06b6d4'];

function formatHexAddr(addr: number): string {
  return `0x${Math.max(0, addr).toString(16).toUpperCase().padStart(5, '0')}`;
}

function formatHexBytes(bytes: Uint8Array, start: number, maxCount = 10): string {
  const end = Math.min(bytes.length, start + maxCount);
  const parts: string[] = [];
  for (let i = start; i < end; i++) {
    parts.push(bytes[i].toString(16).toUpperCase().padStart(2, '0'));
  }
  return parts.join(' ');
}

function formatCellValue(
  raw: number | null,
  val: number | null,
  baseVal: number | null,
  layout: DataLayout,
  scaling: Scaling,
  mode: CompareDisplayMode,
  isBase: boolean,
  diff: boolean,
): string {
  if (raw === null || val === null) return '—';
  if (isBase || mode === 'values' || scaling.output === 3) {
    return scalingDisplay(scaling, raw, layout);
  }
  if (!diff || baseVal === null) return '·';
  const d = val - baseVal;
  if (mode === 'percent') {
    if (Math.abs(baseVal) < 1e-9) return '—';
    const pct = (d / Math.abs(baseVal)) * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  }
  const f = scalingFormat(scaling, d);
  return d > 0 && !f.startsWith('+') ? `+${f}` : f;
}

function resolveCrossDefItem(
  item: XDFItem,
  slotIdx: number,
  baseIdx: number,
  compareDef: XDFDefinition | null,
): XDFItem {
  if (slotIdx === baseIdx || !compareDef) return item;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(item.title);
  const exact = compareDef.items.find((it) => norm(it.title) === target);
  if (exact) return exact;
  const byShape = compareDef.items.find(
    (it) =>
      it.data.rows === item.data.rows &&
      it.data.cols === item.data.cols &&
      it.scaling.units.length > 0 &&
      it.scaling.units === item.scaling.units,
  );
  return byShape ?? item;
}

export const MultiCompareView: React.FC<MultiCompareViewProps> = ({
  bin,
  binName = 'Active BIN',
  compareBin = null,
  compareName = 'Stock Baseline',
  xdf = null,
  snapshots = [],
  onSelectMap,
  onJumpToHex,
  onAddExtraBin,
  onOpenPairInHex,
  onPortTune,
  onSwitchSection,
}) => {
  const [extraSlots, setExtraSlots] = useState<ExtraSlot[]>([]);
  const [snapshotMenuOpen, setSnapshotMenuOpen] = useState<boolean>(false);
  const [baselineId, setBaselineId] = useState<string>(compareBin ? 'compare' : 'active');
  const [mode, setMode] = useState<CompareDisplayMode>('values');
  const [onlyChanged, setOnlyChanged] = useState<boolean>(true);
  const [search, setSearch] = useState<string>('');
  const [selectedItemId, setSelectedItemId] = useState<number | null>(
    () => xdf?.items[0]?.id ?? null,
  );
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [compareDef, setCompareDef] = useState<XDFDefinition | null>(null);
  const [compareDefName, setCompareDefName] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const binInputRef = useRef<HTMLInputElement | null>(null);
  const defInputRef = useRef<HTMLInputElement | null>(null);

  const slots = useMemo<CompareSlot[]>(() => {
    const out: CompareSlot[] = [];
    if (compareBin) {
      out.push({
        id: 'compare',
        name: compareName,
        bytes: compareBin,
        color: SLOT_COLORS[1],
        removable: false,
        role: 'Comparison',
      });
    }
    out.push({
      id: 'active',
      name: binName,
      bytes: bin,
      color: SLOT_COLORS[0],
      removable: false,
      role: 'Active',
    });
    extraSlots.forEach((slot, idx) => {
      out.push({
        id: slot.id,
        name: slot.name,
        bytes: slot.bytes,
        color: SLOT_COLORS[(idx + 2) % SLOT_COLORS.length],
        removable: true,
        role: `Extra #${idx + 1}`,
      });
    });
    return out;
  }, [bin, binName, compareBin, compareName, extraSlots]);

  const baseIdx = useMemo(() => {
    const found = slots.findIndex((s) => s.id === baselineId);
    return found >= 0 ? found : 0;
  }, [slots, baselineId]);

  const baseSlot = slots[baseIdx] ?? slots[0];

  const handleAddBinFiles = useCallback(
    async (files: FileList | File[]) => {
      const added: ExtraSlot[] = [];
      for (const file of Array.from(files)) {
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.xdf') || lower.endsWith('.xml') || lower.endsWith('.a2l') || lower.endsWith('.csv')) {
          const text = await file.text();
          const parsed = importDefinition(file.name, text);
          setCompareDef(parsed);
          setCompareDefName(file.name);
          setNotice(`Loaded cross-definition: ${file.name} (${parsed.items.length} items)`);
          continue;
        }
        const raw = new Uint8Array(await file.arrayBuffer());
        const parsed = parseBinaryFile(file.name, raw);
        added.push({
          id: `extra-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          bytes: parsed,
        });
        onAddExtraBin?.(file.name, parsed);
      }
      if (added.length > 0) {
        setExtraSlots((prev) => [...prev, ...added]);
        setNotice(`Added ${added.length} binary file${added.length > 1 ? 's' : ''} to multi-compare.`);
      }
    },
    [onAddExtraBin],
  );

  // Quick synthetic Stage 2+ variant generator so users can immediately inspect 3-file comparison
  const handleAddSimulatedStage2 = useCallback(() => {
    const variant = new Uint8Array(bin);
    if (xdf) {
      const patches = [];
      for (const item of xdf.items) {
        const title = item.title.toLowerCase();
        const factor =
          title.includes('boost') || title.includes('ldrxn')
            ? 1.07
            : title.includes('torque')
              ? 1.09
              : title.includes('rev')
                ? 1.03
                : 1;
        if (factor === 1) continue;
        const l = item.data;
        for (let r = 0; r < l.rows; r++) {
          for (let c = 0; c < l.cols; c++) {
            const raw = BinCodec.raw(l, { r, c }, variant);
            if (raw === null) continue;
            const nextRaw = l.rows > 1 && r < Math.floor(l.rows * 0.45) ? raw : Math.round(raw * factor);
            if (nextRaw === raw) continue;
            const encoded = BinCodec.encode(l, nextRaw);
            const off =
              l.address + (l.columnMajor ? c * l.rows + r : r * l.cols + c) * Math.max(1, Math.floor(l.bits / 8));
            if (off >= 0 && off + encoded.length <= variant.length) {
              patches.push({
                offset: off,
                old: variant.slice(off, off + encoded.length),
                next: encoded,
              });
            }
          }
        }
      }
      const patched = patches.length > 0 ? applyPatches(variant, patches) : variant;
      const idx = extraSlots.length + 2;
      const name = `Stage${idx}_Variant.bin`;
      setExtraSlots((prev) => [
        ...prev,
        { id: `sim-${Date.now()}`, name, bytes: patched },
      ]);
      onAddExtraBin?.(name, patched);
      setNotice(`Generated ${name} (+7% boost, +9% torque, +3% rev limit) for 3-way comparison.`);
    } else {
      // Flip a few calibration-region bytes for raw comparison
      const start = Math.min(0x10100, Math.max(0, variant.length - 64));
      for (let i = 0; i < 32 && start + i < variant.length; i++) {
        variant[start + i] = (variant[start + i] + 12) & 0xff;
      }
      const name = `Variant_${extraSlots.length + 1}.bin`;
      setExtraSlots((prev) => [...prev, { id: `sim-${Date.now()}`, name, bytes: variant }]);
      onAddExtraBin?.(name, variant);
    }
  }, [bin, xdf, extraSlots.length, onAddExtraBin]);

  const filteredItems = useMemo(() => {
    if (!xdf || !baseSlot) return [];
    const q = search.trim().toLowerCase();
    return xdf.items.filter((item) => {
      if (q && !item.title.toLowerCase().includes(q) && !item.description.toLowerCase().includes(q)) {
        return false;
      }
      if (onlyChanged && slots.length >= 2) {
        return slots.some(
          (slot, idx) => idx !== baseIdx && countChangedCells(item, slot.bytes, baseSlot.bytes) > 0,
        );
      }
      return true;
    });
  }, [xdf, baseSlot, search, onlyChanged, slots, baseIdx]);

  const selectedItem = useMemo(() => {
    if (!xdf) return null;
    return (
      filteredItems.find((it) => it.id === selectedItemId) ??
      xdf.items.find((it) => it.id === selectedItemId) ??
      filteredItems[0] ??
      xdf.items[0] ??
      null
    );
  }, [xdf, filteredItems, selectedItemId]);

  // Raw multi-diff clusters when no XDF is loaded
  const rawClusters = useMemo(() => {
    if (xdf || slots.length < 2 || !baseSlot) return [];
    const minLen = Math.min(...slots.map((s) => s.bytes.length));
    // Build synthetic union buffer where any byte differing in any slot differs from baseline
    const unionBuf = new Uint8Array(baseSlot.bytes.slice(0, minLen));
    for (let i = 0; i < minLen; i++) {
      const b0 = baseSlot.bytes[i];
      for (let s = 0; s < slots.length; s++) {
        if (s !== baseIdx && slots[s].bytes[i] !== b0) {
          unionBuf[i] = b0 ^ 0xff;
          break;
        }
      }
    }
    return diffClusters(unionBuf, baseSlot.bytes.slice(0, minLen), 16);
  }, [xdf, slots, baseSlot, baseIdx]);

  const tableRows = useMemo(() => {
    if (!selectedItem || selectedItem.itemKind.kind !== 'table' || !baseSlot) return [];
    const l = selectedItem.data;
    const xs = BinCodec.axisLabels(selectedItem.itemKind.x, l.cols, baseSlot.bytes);
    const ys = BinCodec.axisLabels(selectedItem.itemKind.y, l.rows, baseSlot.bytes);
    const rows: Array<{
      key: string;
      r: number;
      c: number;
      coordLabel: string;
      baseVal: number | null;
      cells: Array<{
        slotId: string;
        text: string;
        diff: boolean;
        deltaSign: number;
      }>;
    }> = [];

    for (let r = 0; r < l.rows; r++) {
      for (let c = 0; c < l.cols; c++) {
        const cell = { r, c };
        const baseRaw = BinCodec.raw(l, cell, baseSlot.bytes);
        const baseVal = baseRaw !== null ? scalingValue(selectedItem.scaling, baseRaw) : null;

        let anyDiff = false;
        const cells = slots.map((slot, idx) => {
          const effItem = resolveCrossDefItem(selectedItem, idx, baseIdx, compareDef);
          const raw = BinCodec.raw(effItem.data, cell, slot.bytes);
          const val = raw !== null ? scalingValue(effItem.scaling, raw) : null;
          let diff = false;
          if (idx !== baseIdx) {
            if (effItem.data.address === l.address) {
              diff = cellDiffers(l, cell, slot.bytes, baseSlot.bytes);
            } else if (val !== null && baseVal !== null) {
              diff = Math.abs(val - baseVal) > 1e-6;
            }
          }
          if (diff) anyDiff = true;
          const deltaSign =
            diff && val !== null && baseVal !== null ? Math.sign(val - baseVal) : 0;
          return {
            slotId: slot.id,
            text: formatCellValue(
              raw,
              val,
              baseVal,
              effItem.data,
              effItem.scaling,
              mode,
              idx === baseIdx,
              diff,
            ),
            diff,
            deltaSign,
          };
        });

        if (onlyChanged && slots.length >= 2 && !anyDiff) continue;
        rows.push({
          key: `${r}:${c}`,
          r,
          c,
          coordLabel: l.rows > 1 ? `[${ys[r]} / ${xs[c]}]` : `[${xs[c]}]`,
          baseVal,
          cells,
        });
      }
    }
    return rows;
  }, [selectedItem, baseSlot, slots, baseIdx, compareDef, mode, onlyChanged]);

  return (
    <div
      className="h-full flex flex-col bg-[#0c0d10] text-zinc-100 overflow-hidden relative"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setIsDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        if (e.dataTransfer.files.length > 0) void handleAddBinFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={binInputRef}
        type="file"
        multiple
        accept=".bin,.ori,.mod,.hex,.ihx,.s19,.s28,.s37,.srec"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void handleAddBinFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={defInputRef}
        type="file"
        accept=".xdf,.xml,.a2l,.csv"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void handleAddBinFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {/* Top Header & Controls */}
      <div className="px-5 py-3 border-b border-white/[0.065] bg-[#121317] space-y-2.5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#0a84ff]/15 border border-[#0a84ff]/30 flex items-center justify-center">
              <FileDiff className="w-4 h-4 text-[#5ac8fa]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold tracking-[-0.01em] text-white">
                  Multi-File BIN Compare
                </h2>
                <span className="px-2 py-0.5 rounded-full bg-white/[0.06] border border-white/[0.08] font-mono text-[10.5px] text-zinc-300">
                  {slots.length} {slots.length === 1 ? 'File' : 'Files'}
                </span>
              </div>
              <p className="text-[11px] text-zinc-400">
                Compare Stock, Stage 1, Stage 2, and custom BIN snapshots side-by-side simultaneously
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {snapshots.length > 0 && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setSnapshotMenuOpen((v) => !v)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
                >
                  <History className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Add Snapshot</span>
                </button>
                {snapshotMenuOpen && (
                  <div className="absolute right-0 mt-1.5 w-60 rounded-xl bg-[#17181d] border border-white/[0.1] shadow-2xl z-30 py-1 overflow-hidden">
                    {snapshots.map((snap) => (
                      <button
                        key={snap.id}
                        type="button"
                        onClick={() => {
                          setExtraSlots((prev) => [
                            ...prev,
                            {
                              id: `snap-slot-${snap.id}-${Date.now()}`,
                              name: snap.name,
                              bytes: snap.bytes.slice(),
                            },
                          ]);
                          setSnapshotMenuOpen(false);
                          setNotice(`Added snapshot "${snap.name}" to multi-compare.`);
                        }}
                        className="w-full text-left px-3 py-2 hover:bg-white/[0.06] text-xs text-zinc-200 flex items-center justify-between gap-2 cursor-pointer"
                      >
                        <span className="truncate">{snap.name}</span>
                        <span className="font-mono text-[10px] text-zinc-500 shrink-0">
                          {Math.round(snap.bytes.length / 1024)} KB
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                if (onPortTune) onPortTune();
                else if (onSwitchSection) onSwitchSection('discovery');
                else setNotice('Open Discovery → Tune Porting to transfer deltas across versions.');
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
              title="Port tune deltas to another software version"
            >
              <ArrowRightLeft className="w-3.5 h-3.5 text-[#5ac8fa]" />
              <span>Port Tune</span>
            </button>
            <button
              type="button"
              onClick={handleAddSimulatedStage2}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
              title="Generate a synthetic Stage 2 BIN variant to preview 3-way comparison"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span>+ Stage 2 Demo</span>
            </button>
            <button
              type="button"
              onClick={() => defInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
              title="Load a second XDF/A2L/CSV definition for cross-software comparison"
            >
              <FilePlus2 className="w-3.5 h-3.5 text-purple-400" />
              <span>{compareDefName ? `2nd Def: ${compareDefName}` : '2nd Def'}</span>
              {compareDefName && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    setCompareDef(null);
                    setCompareDefName(null);
                  }}
                  className="ml-1 text-zinc-400 hover:text-white"
                >
                  <X className="w-3 h-3" />
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => binInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-semibold shadow-[0_2px_10px_rgba(10,132,255,0.35)] transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add .bin File</span>
            </button>
          </div>
        </div>

        {/* Controls Bar: Baseline, Mode, Filter, Loaded Slots */}
        <div className="flex items-center justify-between gap-3 flex-wrap pt-1 border-t border-white/[0.05]">
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-1.5 text-xs text-zinc-400">
              <Star className="w-3.5 h-3.5 text-amber-400" />
              <span>Baseline</span>
              <select
                value={baseSlot?.id ?? 'active'}
                onChange={(e) => setBaselineId(e.target.value)}
                className="px-2.5 py-1 rounded-lg bg-[#0c0d10] border border-white/[0.08] text-xs text-zinc-100 focus:outline-none focus:border-[#0a84ff]"
              >
                {slots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>

            {/* Display Mode Segmented Control */}
            <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] border border-white/[0.065]">
              {(
                [
                  { id: 'values', label: 'Values' },
                  { id: 'delta', label: 'Δ vs Stock' },
                  { id: 'percent', label: 'Δ %' },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMode(m.id)}
                  className={`px-3 py-1 rounded-full text-[11px] font-medium transition-all cursor-pointer ${
                    mode === m.id
                      ? 'bg-[#0a84ff] text-white shadow-[0_1px_8px_rgba(10,132,255,0.4)]'
                      : 'text-zinc-400 hover:text-zinc-100'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <label className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={onlyChanged}
                onChange={(e) => setOnlyChanged(e.target.checked)}
                className="accent-[#0a84ff]"
              />
              <span>Only Changed</span>
            </label>
          </div>

          {/* Loaded File Chips */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {slots.map((slot, idx) => {
              const isBase = idx === baseIdx;
              const diffB =
                !isBase && baseSlot ? countChangedBytes(slot.bytes, baseSlot.bytes) : 0;
              return (
                <div
                  key={slot.id}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] border ${
                    isBase
                      ? 'bg-[#0a84ff]/15 border-[#0a84ff]/40 text-white'
                      : 'bg-[#17181d] border-white/[0.08] text-zinc-300'
                  }`}
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: slot.color }}
                  />
                  <span className="max-w-[140px] truncate font-medium">{slot.name}</span>
                  {isBase ? (
                    <span className="text-[9.5px] font-semibold uppercase text-[#5ac8fa]">
                      Base
                    </span>
                  ) : (
                    <span className="font-mono text-[10px] text-amber-300">
                      {diffB > 0 ? `${diffB} B Δ` : '0 Δ'}
                    </span>
                  )}
                  {slot.removable && (
                    <button
                      type="button"
                      onClick={() =>
                        setExtraSlots((prev) => prev.filter((s) => s.id !== slot.id))
                      }
                      className="text-zinc-500 hover:text-rose-400 transition-colors cursor-pointer"
                      title={`Remove ${slot.name}`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {notice && (
          <div className="flex items-center justify-between text-[11px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/25 rounded-lg px-3 py-1.5">
            <span>{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="text-emerald-400 hover:text-white cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Main Content */}
      {slots.length < 2 ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-md w-full rounded-2xl bg-[#17181d] border border-white/[0.065] p-8 text-center space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-[#0a84ff]/15 border border-[#0a84ff]/30 flex items-center justify-center mx-auto">
              <Layers className="w-6 h-6 text-[#5ac8fa]" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Add 2+ BIN Files to Compare</h3>
              <p className="text-xs text-zinc-400 mt-1">
                Drop additional Stock, Stage 1, Stage 2, or snapshot .bin files anywhere here to inspect values and deltas across all versions side-by-side.
              </p>
            </div>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => binInputRef.current?.click()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-semibold cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Add .bin File</span>
              </button>
              <button
                type="button"
                onClick={handleAddSimulatedStage2}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-zinc-200 text-xs font-medium cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                <span>Generate Stage 2 Demo</span>
              </button>
            </div>
          </div>
        </div>
      ) : xdf ? (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Left: Map Picker */}
          <aside className="w-72 xl:w-80 shrink-0 border-r border-white/[0.065] bg-[#121317] flex flex-col min-h-0">
            <div className="p-3 border-b border-white/[0.065]">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter maps..."
                  className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-[#0c0d10] border border-white/[0.08] text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-[#0a84ff]"
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-[10.5px] text-zinc-500 font-mono">
                <span>{filteredItems.length} maps shown</span>
                <span>{xdf.items.length} total</span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {filteredItems.length === 0 ? (
                <div className="p-6 text-center text-xs text-zinc-500">
                  No maps match current filter.
                </div>
              ) : (
                filteredItems.map((item) => {
                  const isSel = selectedItem?.id === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelectedItemId(item.id)}
                      className={`w-full text-left rounded-xl p-2.5 border transition-all cursor-pointer ${
                        isSel
                          ? 'bg-[#0a84ff]/15 border-[#0a84ff]/45 text-white'
                          : 'bg-transparent border-transparent hover:bg-white/[0.04] text-zinc-300'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <Table2
                            className={`w-3.5 h-3.5 shrink-0 ${isSel ? 'text-[#5ac8fa]' : 'text-zinc-500'}`}
                          />
                          <span className="text-xs font-medium truncate">{item.title}</span>
                        </div>
                        <span className="font-mono text-[10px] text-zinc-500 shrink-0">
                          {item.data.rows}×{item.data.cols}
                        </span>
                      </div>

                      <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                        <span className="font-mono text-[10px] text-zinc-500 mr-1">
                          {formatHexAddr(item.data.address)}
                        </span>
                        {slots.map((slot, idx) => {
                          if (idx === baseIdx || !baseSlot) return null;
                          const changed = countChangedCells(item, slot.bytes, baseSlot.bytes);
                          if (changed === 0) return null;
                          return (
                            <span
                              key={slot.id}
                              className="px-1.5 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 font-mono text-[9.5px] text-amber-300 truncate max-w-[120px]"
                              title={`${slot.name}: ${changed} changed cells`}
                            >
                              {slot.name.replace(/\.bin$/i, '').slice(0, 10)}: {changed}
                            </span>
                          );
                        })}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          {/* Right: Multi-Column Detail Pane */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden p-5">
            {selectedItem && baseSlot ? (
              <div className="flex-1 min-h-0 flex flex-col rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                {/* Selected Map Header */}
                <div className="px-4 py-3 border-b border-white/[0.065] bg-[#14151a] flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2.5 flex-wrap min-w-0">
                    <h3 className="text-sm font-semibold text-white truncate">
                      {selectedItem.title}
                    </h3>
                    <span className="px-2 py-0.5 rounded-md bg-white/[0.06] font-mono text-[10.5px] text-zinc-300">
                      {formatHexAddr(selectedItem.data.address)}
                    </span>
                    <span className="px-2 py-0.5 rounded-md bg-white/[0.06] font-mono text-[10.5px] text-zinc-400">
                      {selectedItem.data.rows}×{selectedItem.data.cols}
                    </span>
                    {selectedItem.scaling.units && (
                      <span className="px-2 py-0.5 rounded-md bg-[#0a84ff]/15 text-[#5ac8fa] font-mono text-[10.5px]">
                        {selectedItem.scaling.units}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {onJumpToHex && (
                      <button
                        type="button"
                        onClick={() => onJumpToHex(selectedItem.data.address)}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-[11px] font-medium text-zinc-200 cursor-pointer"
                      >
                        <Binary className="w-3 h-3 text-zinc-400" />
                        <span>Hex</span>
                      </button>
                    )}
                    {onSelectMap && (
                      <button
                        type="button"
                        onClick={() => onSelectMap(selectedItem.id)}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#0a84ff]/15 hover:bg-[#0a84ff]/25 border border-[#0a84ff]/35 text-[11px] font-medium text-[#5ac8fa] cursor-pointer"
                      >
                        <span>Open in Editor</span>
                        <ArrowUpRight className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Comparison Body */}
                {selectedItem.itemKind.kind === 'table' ? (
                  tableRows.length === 0 ? (
                    <div className="flex-1 flex flex-col items-center justify-center p-10 text-center">
                      <CheckCircle2 className="w-8 h-8 text-emerald-400 mb-2" />
                      <p className="text-sm font-semibold text-zinc-200">
                        All {slots.length} files are identical for this map
                      </p>
                      <p className="text-xs text-zinc-500 mt-1">
                        Uncheck &ldquo;Only Changed&rdquo; to inspect all {selectedItem.data.rows * selectedItem.data.cols} cells.
                      </p>
                    </div>
                  ) : (
                    <div className="flex-1 overflow-auto">
                      <table className="w-full text-left border-collapse">
                        <thead className="sticky top-0 z-10 bg-[#14151a] border-b border-white/[0.065]">
                          <tr className="text-[10.5px] uppercase tracking-wider text-zinc-400">
                            <th className="py-2.5 px-3.5 font-semibold whitespace-nowrap">
                              Axis [Row / Col]
                            </th>
                            {slots.map((slot, idx) => (
                              <th
                                key={slot.id}
                                className="py-2.5 px-3.5 font-semibold text-right whitespace-nowrap"
                              >
                                <span className="inline-flex items-center gap-1.5">
                                  <span
                                    className="w-2 h-2 rounded-full"
                                    style={{ backgroundColor: slot.color }}
                                  />
                                  <span className={idx === baseIdx ? 'text-[#5ac8fa]' : 'text-zinc-200'}>
                                    {slot.name}
                                    {idx === baseIdx ? ' ★' : ''}
                                  </span>
                                </span>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.045] text-xs font-mono tabular-nums">
                          {tableRows.map((row) => (
                            <tr key={row.key} className="hover:bg-white/[0.03] transition-colors">
                              <td className="py-2 px-3.5 text-zinc-400 whitespace-nowrap">
                                {row.coordLabel}
                              </td>
                              {row.cells.map((c, idx) => (
                                <td
                                  key={c.slotId}
                                  className={`py-2 px-3.5 text-right whitespace-nowrap ${
                                    idx === baseIdx
                                      ? 'text-zinc-200 bg-white/[0.015]'
                                      : c.diff
                                        ? c.deltaSign > 0
                                          ? 'text-amber-300 font-semibold bg-amber-500/[0.06]'
                                          : c.deltaSign < 0
                                            ? 'text-sky-300 font-semibold bg-sky-500/[0.06]'
                                            : 'text-amber-300 font-semibold'
                                        : 'text-zinc-500'
                                  }`}
                                >
                                  {c.text}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                ) : (
                  <div className="p-5 space-y-2.5 overflow-y-auto">
                    {slots.map((slot, idx) => {
                      const eff = resolveCrossDefItem(selectedItem, idx, baseIdx, compareDef);
                      const cell = { r: 0, c: 0 };
                      const baseRaw = BinCodec.raw(selectedItem.data, cell, baseSlot.bytes);
                      const baseVal =
                        baseRaw !== null ? scalingValue(selectedItem.scaling, baseRaw) : null;
                      const raw = BinCodec.raw(eff.data, cell, slot.bytes);
                      const val = raw !== null ? scalingValue(eff.scaling, raw) : null;
                      const diff =
                        idx !== baseIdx &&
                        cellDiffers(selectedItem.data, cell, slot.bytes, baseSlot.bytes);
                      return (
                        <div
                          key={slot.id}
                          className={`rounded-xl p-3.5 border flex items-center justify-between gap-4 ${
                            idx === baseIdx
                              ? 'bg-[#0a84ff]/10 border-[#0a84ff]/35'
                              : diff
                                ? 'bg-amber-500/[0.07] border-amber-500/30'
                                : 'bg-[#0c0d10] border-white/[0.065]'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span
                              className="w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: slot.color }}
                            />
                            <span className="text-xs font-semibold text-white truncate">
                              {slot.name}
                            </span>
                            {idx === baseIdx && (
                              <span className="px-2 py-0.5 rounded-full bg-[#0a84ff]/20 text-[#5ac8fa] text-[10px] font-semibold">
                                Baseline
                              </span>
                            )}
                          </div>
                          <div className="flex items-baseline gap-1.5 font-mono tabular-nums">
                            <span
                              className={`text-base font-bold ${
                                diff ? 'text-amber-300' : 'text-zinc-100'
                              }`}
                            >
                              {formatCellValue(
                                raw,
                                val,
                                baseVal,
                                eff.data,
                                eff.scaling,
                                mode,
                                idx === baseIdx,
                                diff,
                              )}
                            </span>
                            {eff.scaling.units && mode !== 'percent' && (
                              <span className="text-xs text-zinc-500">{eff.scaling.units}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-xs text-zinc-500">
                Select a map on the left to compare values across all loaded BIN files.
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Standalone Raw Multi-Compare (No XDF) */
        <div className="flex-1 overflow-auto p-5">
          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden">
            <div className="px-4 py-3 border-b border-white/[0.065] flex items-center justify-between">
              <div>
                <h3 className="text-xs font-semibold text-white">
                  Raw Bin-vs-Bin Diff Clusters (No XDF Loaded)
                </h3>
                <p className="text-[11px] text-zinc-400">
                  {rawClusters.length} changed region{rawClusters.length === 1 ? '' : 's'} across{' '}
                  {slots.length} files
                </p>
              </div>
            </div>
            {rawClusters.length === 0 ? (
              <div className="p-10 text-center text-xs text-emerald-300">
                All {slots.length} binaries are byte-identical.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
                  <thead className="bg-[#14151a] border-b border-white/[0.065] text-[10.5px] uppercase tracking-wider text-zinc-400">
                    <tr>
                      <th className="py-2.5 px-3.5">Range</th>
                      <th className="py-2.5 px-3.5">Span</th>
                      {slots.map((s, idx) => (
                        <th key={s.id} className="py-2.5 px-3.5">
                          {s.name}
                          {idx === baseIdx ? ' ★' : ''}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.045]">
                    {rawClusters.slice(0, 200).map((cl) => {
                      const diffSlot =
                        slots.find(
                          (s, idx) =>
                            idx !== baseIdx &&
                            baseSlot &&
                            s.bytes[cl.start] !== baseSlot.bytes[cl.start],
                        ) ?? slots.find((_, idx) => idx !== baseIdx);
                      const handleClusterClick = () => {
                        if (onOpenPairInHex && baseSlot && diffSlot) {
                          onOpenPairInHex(
                            baseSlot.bytes,
                            diffSlot.bytes,
                            cl.start,
                            baseSlot.name,
                            diffSlot.name,
                          );
                        } else {
                          onJumpToHex?.(cl.start);
                        }
                      };
                      return (
                      <tr key={cl.start} className="hover:bg-white/[0.03]">
                        <td className="py-2 px-3.5 whitespace-nowrap">
                          {onOpenPairInHex || onJumpToHex ? (
                            <button
                              type="button"
                              onClick={handleClusterClick}
                              className="text-[#5ac8fa] hover:underline cursor-pointer"
                            >
                              {formatHexAddr(cl.start)}–{formatHexAddr(cl.end - 1)}
                            </button>
                          ) : (
                            <span className="text-zinc-200">
                              {formatHexAddr(cl.start)}–{formatHexAddr(cl.end - 1)}
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-3.5 text-zinc-400 whitespace-nowrap">
                          {cl.end - cl.start} B
                        </td>
                        {slots.map((s, idx) => {
                          const len = Math.min(10, cl.end - cl.start);
                          const hex = formatHexBytes(s.bytes, cl.start, len);
                          const baseHex = baseSlot
                            ? formatHexBytes(baseSlot.bytes, cl.start, len)
                            : hex;
                          const diff = idx !== baseIdx && hex !== baseHex;
                          return (
                            <td
                              key={s.id}
                              className={`py-2 px-3.5 whitespace-nowrap ${
                                diff ? 'text-amber-300 font-semibold' : 'text-zinc-400'
                              }`}
                            >
                              {hex}
                              {cl.end - cl.start > 10 ? ' …' : ''}
                            </td>
                          );
                        })}
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Drag & Drop Overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-30 bg-[#0c0d10]/85 backdrop-blur-sm flex flex-col items-center justify-center pointer-events-none border-2 border-dashed border-[#0a84ff] m-3 rounded-2xl">
          <Upload className="w-10 h-10 text-[#0a84ff] mb-2" />
          <p className="text-sm font-semibold text-white">Drop .bin files to add to Multi-Compare</p>
          <p className="text-xs text-zinc-400 mt-1">
            Supports raw .bin/.ori/.mod, Intel HEX, Motorola SREC, or a 2nd XDF/A2L definition
          </p>
        </div>
      )}
    </div>
  );
};
