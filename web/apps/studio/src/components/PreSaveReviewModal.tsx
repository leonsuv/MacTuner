import React, { useEffect, useMemo } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Lock,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Table2,
  ToggleLeft,
  Wrench,
  X,
} from 'lucide-react';
import {
  BinCodec,
  cellDiffers,
  countChangedBytes,
  identifyECU,
  layoutByteRange,
  scalingDisplay,
  scalingValue,
  verifyChecksums,
  type XDFDefinition,
} from '@mactuner/core';
import { useI18n } from '../lib/i18n';

export interface PreSaveReviewModalProps {
  open: boolean;
  onClose: () => void;
  bin: Uint8Array;
  baselineBin?: Uint8Array | null;
  openedSnapshot?: Uint8Array | null;
  fileName?: string;
  xdf?: XDFDefinition | null;
  checksumBlocks?: Array<{
    id: string;
    name: string;
    valid: boolean;
    protected?: boolean;
  }>;
  invalidChecksumCount?: number;
  onFixChecksums?: () => void;
  onConfirmExport: () => void;
  onSaveInPlace?: () => void;
  onSelectMap?: (itemId: number) => void;
}

interface ModifiedMapEntry {
  id: number;
  title: string;
  category: string;
  kind: 'table' | 'constant' | 'flag';
  address: number;
  summary: string;
}

function formatHexAddr(addr: number): string {
  return `0x${Math.max(0, addr).toString(16).toUpperCase().padStart(5, '0')}`;
}

export const PreSaveReviewModal: React.FC<PreSaveReviewModalProps> = ({
  open,
  onClose,
  bin,
  baselineBin = null,
  openedSnapshot = null,
  fileName = 'ecu_tuned.bin',
  xdf = null,
  checksumBlocks,
  invalidChecksumCount,
  onFixChecksums,
  onConfirmExport,
  onSaveInPlace,
  onSelectMap,
}) => {
  const { t } = useI18n();
  const effectiveBaseline = openedSnapshot ?? baselineBin;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const ecu = useMemo(() => identifyECU(bin), [bin]);

  const modifiedByteCount = useMemo(() => {
    if (!effectiveBaseline) return 0;
    return countChangedBytes(bin, effectiveBaseline);
  }, [bin, effectiveBaseline]);

  const { modifiedItems, outsideByteCount } = useMemo(() => {
    if (!xdf || !effectiveBaseline) {
      return { modifiedItems: [] as ModifiedMapEntry[], outsideByteCount: modifiedByteCount };
    }
    const items: ModifiedMapEntry[] = [];
    const coveredRanges: Array<[number, number]> = [];

    for (const item of xdf.items) {
      const l = item.data;
      const range = layoutByteRange(l);
      coveredRanges.push(range);

      const cat =
        item.categories.length > 0 ? (xdf.categories[item.categories[0]] ?? '') : '';

      if (item.itemKind.kind === 'table') {
        const total = l.rows * l.cols;
        let changed = 0;
        let maxPct = 0;
        for (let r = 0; r < l.rows; r++) {
          for (let c = 0; c < l.cols; c++) {
            const cell = { r, c };
            if (!cellDiffers(l, cell, bin, effectiveBaseline)) continue;
            changed++;
            const curRaw = BinCodec.raw(l, cell, bin);
            const origRaw = BinCodec.raw(l, cell, effectiveBaseline);
            if (curRaw !== null && origRaw !== null) {
              const cur = scalingValue(item.scaling, curRaw);
              const orig = scalingValue(item.scaling, origRaw);
              if (Math.abs(orig) > 1e-9) {
                const pct = ((cur - orig) / Math.abs(orig)) * 100;
                if (Math.abs(pct) > Math.abs(maxPct)) maxPct = pct;
              }
            }
          }
        }
        if (changed > 0) {
          items.push({
            id: item.id,
            title: item.title,
            category: cat,
            kind: 'table',
            address: l.address,
            summary: `${changed} / ${total} cells · max ${maxPct >= 0 ? '+' : ''}${maxPct.toFixed(1)}%`,
          });
        }
      } else if (item.itemKind.kind === 'constant') {
        const cell = { r: 0, c: 0 };
        if (cellDiffers(l, cell, bin, effectiveBaseline)) {
          const origRaw = BinCodec.raw(l, cell, effectiveBaseline);
          const curRaw = BinCodec.raw(l, cell, bin);
          const origTxt = origRaw !== null ? scalingDisplay(item.scaling, origRaw, l) : '—';
          const curTxt = curRaw !== null ? scalingDisplay(item.scaling, curRaw, l) : '—';
          const unit = item.scaling.units ? ` ${item.scaling.units}` : '';
          items.push({
            id: item.id,
            title: item.title,
            category: cat,
            kind: 'constant',
            address: l.address,
            summary: `${origTxt} → ${curTxt}${unit}`,
          });
        }
      } else if (item.itemKind.kind === 'flag') {
        const cell = { r: 0, c: 0 };
        if (cellDiffers(l, cell, bin, effectiveBaseline)) {
          const origRaw = BinCodec.raw(l, cell, effectiveBaseline) ?? 0;
          const curRaw = BinCodec.raw(l, cell, bin) ?? 0;
          const mask = item.itemKind.mask || 1;
          const oBit = Boolean(origRaw & mask) !== item.itemKind.invert ? '1' : '0';
          const cBit = Boolean(curRaw & mask) !== item.itemKind.invert ? '1' : '0';
          items.push({
            id: item.id,
            title: item.title,
            category: cat,
            kind: 'flag',
            address: l.address,
            summary: `${oBit} → ${cBit}`,
          });
        }
      }
    }

    // Count changed bytes outside any XDF item byte range
    const len = Math.min(bin.length, effectiveBaseline.length);
    let outside = 0;
    for (let i = 0; i < len; i++) {
      if (bin[i] === effectiveBaseline[i]) continue;
      const inXdf = coveredRanges.some(([s, e]) => i >= s && i < e);
      if (!inXdf) outside++;
    }

    return { modifiedItems: items, outsideByteCount: outside };
  }, [xdf, bin, effectiveBaseline, modifiedByteCount]);

  const checksumSummary = useMemo(() => {
    if (invalidChecksumCount !== undefined) {
      return {
        invalidCount: invalidChecksumCount,
        totalBlocks: checksumBlocks?.length ?? Math.max(1, invalidChecksumCount),
        valid: invalidChecksumCount === 0,
      };
    }
    if (checksumBlocks) {
      const invalid = checksumBlocks.filter((b) => !b.valid && !b.protected).length;
      return {
        invalidCount: invalid,
        totalBlocks: checksumBlocks.length,
        valid: invalid === 0 && checksumBlocks.length > 0,
      };
    }
    const report = verifyChecksums(bin, baselineBin ?? undefined);
    return {
      invalidCount: report.invalidCount,
      totalBlocks: report.blocks.length,
      valid: report.invalidCount === 0 && report.blocks.length > 0,
    };
  }, [invalidChecksumCount, checksumBlocks, bin, baselineBin]);

  if (!open) return null;

  const hasInvalidCs = checksumSummary.invalidCount > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl bg-[#121317] border border-white/[0.08] shadow-[0_24px_80px_rgba(0,0,0,0.75)] overflow-hidden flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/[0.065] bg-[#17181d] flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${
                hasInvalidCs
                  ? 'bg-rose-500/15 border-rose-500/35 text-rose-400'
                  : 'bg-emerald-500/15 border-emerald-500/35 text-emerald-400'
              }`}
            >
              {hasInvalidCs ? (
                <ShieldAlert className="w-5 h-5" />
              ) : (
                <ShieldCheck className="w-5 h-5" />
              )}
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold tracking-[-0.01em] text-white">
                {t('Pre-Save Calibration Review')}
              </h2>
              <p className="text-[11px] font-mono text-zinc-400 truncate">
                {fileName} · {Math.round(bin.length / 1024)} KB · {ecu.ecuFamily}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {hasInvalidCs && onFixChecksums && (
              <button
                type="button"
                onClick={onFixChecksums}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-semibold shadow-[0_2px_10px_rgba(10,132,255,0.35)] transition-colors cursor-pointer"
              >
                <Wrench className="w-3.5 h-3.5" />
                <span>{t('Fix Checksums (%lld)', checksumSummary.invalidCount)}</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-400 hover:bg-white/[0.06] hover:text-white transition-colors cursor-pointer"
              title={t('Close')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* 4 KPI Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('Changed Maps')}
              </div>
              <div className="mt-1 text-lg font-mono tabular-nums font-bold text-[#5ac8fa]">
                {modifiedItems.length}
              </div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('Modified Bytes')}
              </div>
              <div className="mt-1 text-lg font-mono tabular-nums font-bold text-amber-400">
                {modifiedByteCount.toLocaleString()} B
              </div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('Checksums')}
              </div>
              <div
                className={`mt-1 text-sm font-mono font-bold ${
                  hasInvalidCs ? 'text-rose-400' : 'text-emerald-400'
                }`}
              >
                {hasInvalidCs
                  ? `${checksumSummary.invalidCount} ${t('Invalid')}`
                  : `${t('OK')} (${checksumSummary.totalBlocks})`}
              </div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('TPROT / RSA')}
              </div>
              <div className="mt-1 text-sm font-semibold flex items-center gap-1.5">
                {ecu.hasTPROT ? (
                  <span className="text-amber-300 inline-flex items-center gap-1">
                    <Lock className="w-3.5 h-3.5" /> {t('Active')}
                  </span>
                ) : (
                  <span className="text-emerald-400 inline-flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> {t('Clear')}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Invalid Checksum Warning Banner */}
          {hasInvalidCs && (
            <div className="rounded-xl bg-rose-500/10 border border-rose-500/30 p-3.5 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-start gap-2.5 min-w-0">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div className="text-xs text-rose-200/90 leading-relaxed">
                  <strong>{t('%lld checksum block(s) invalid.', checksumSummary.invalidCount)}</strong>{' '}
                  {t('Fix checksums before flashing, or ensure your flasher (KESS3 / Autotuner / Flex) recomputes checksums during write.')}
                </div>
              </div>
              {onFixChecksums && (
                <button
                  type="button"
                  onClick={onFixChecksums}
                  className="px-3 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-200 text-xs font-semibold shrink-0 cursor-pointer"
                >
                  {t('Fix Checksums')}
                </button>
              )}
            </div>
          )}

          {/* Changed Maps List */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                {t('Change Summary')}
              </h3>
              <span className="text-[11px] font-mono text-zinc-500">
                {modifiedItems.length} {t(modifiedItems.length === 1 ? 'map' : 'maps')}
                {outsideByteCount > 0 ? ` + ${outsideByteCount} ${t('B outside XDF')}` : ''}
              </span>
            </div>

            {modifiedItems.length === 0 && modifiedByteCount === 0 ? (
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-8 text-center">
                <CheckCircle2 className="w-7 h-7 text-emerald-400 mx-auto mb-2" />
                <p className="text-xs font-medium text-zinc-200">
                  {t('No byte differences vs baseline binary')}
                </p>
                <p className="text-[11px] text-zinc-500 mt-0.5">
                  {t('The exported .bin matches the comparison reference byte-for-byte.')}
                </p>
              </div>
            ) : (
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] divide-y divide-white/[0.05] overflow-hidden">
                {modifiedItems.map((entry) => (
                  <div
                    key={entry.id}
                    className="px-3.5 py-2.5 flex items-center justify-between gap-3 hover:bg-white/[0.025] transition-colors"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-6 h-6 rounded-md bg-[#0a84ff]/12 text-[#5ac8fa] flex items-center justify-center shrink-0">
                        {entry.kind === 'table' ? (
                          <Table2 className="w-3.5 h-3.5" />
                        ) : entry.kind === 'flag' ? (
                          <ToggleLeft className="w-3.5 h-3.5" />
                        ) : (
                          <SlidersHorizontal className="w-3.5 h-3.5" />
                        )}
                      </div>
                      <div className="min-w-0">
                        {onSelectMap ? (
                          <button
                            type="button"
                            onClick={() => {
                              onSelectMap(entry.id);
                              onClose();
                            }}
                            className="text-xs font-medium text-zinc-100 hover:text-[#5ac8fa] truncate block cursor-pointer"
                          >
                            {entry.title}
                          </button>
                        ) : (
                          <div className="text-xs font-medium text-zinc-100 truncate">
                            {entry.title}
                          </div>
                        )}
                        <div className="text-[10.5px] font-mono text-zinc-500 flex items-center gap-2">
                          <span>{formatHexAddr(entry.address)}</span>
                          {entry.category && <span>· {entry.category}</span>}
                        </div>
                      </div>
                    </div>

                    <span className="font-mono tabular-nums text-[11.5px] font-medium text-amber-300 shrink-0">
                      {entry.summary}
                    </span>
                  </div>
                ))}

                {outsideByteCount > 0 && (
                  <div className="px-3.5 py-2.5 flex items-center justify-between gap-3 bg-amber-500/[0.04]">
                    <div className="flex items-center gap-2.5">
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                      <div>
                        <div className="text-xs font-medium text-zinc-200">
                          {t('Changes Outside XDF Definition')}
                        </div>
                        <div className="text-[10.5px] text-zinc-500">
                          {t('Includes checksum footers, undetected maps, or raw hex edits')}
                        </div>
                      </div>
                    </div>
                    <span className="font-mono tabular-nums text-xs font-semibold text-amber-300">
                      {outsideByteCount.toLocaleString()} B
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-white/[0.065] bg-[#17181d] flex items-center justify-between gap-3 flex-wrap">
          <span className="text-[11px] text-zinc-500">
            {openedSnapshot
              ? t('Diffed against immutable opened baseline snapshot.')
              : t('Non-destructive export — original baseline remains untouched.')}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
            >
              {t('Cancel')}
            </button>
            {onSaveInPlace && (
              <button
                type="button"
                onClick={() => {
                  onSaveInPlace();
                  onClose();
                }}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] border border-white/[0.12] text-xs font-semibold text-white transition-all cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-[#5ac8fa]" />
                <span>{t('Save')}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onConfirmExport();
                onClose();
              }}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-white transition-all cursor-pointer ${
                hasInvalidCs
                  ? 'bg-amber-600 hover:bg-amber-500 shadow-[0_3px_14px_rgba(217,119,6,0.35)]'
                  : 'bg-[#0a84ff] hover:bg-[#1e8fff] shadow-[0_3px_14px_rgba(10,132,255,0.4)]'
              }`}
            >
              <Download className="w-3.5 h-3.5" />
              <span>{onSaveInPlace ? t('Save As…') : t('Confirm & Export .bin')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
