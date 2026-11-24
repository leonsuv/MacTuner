import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  Download,
  Lock,
  Scissors,
  ShieldAlert,
  ShieldCheck,
  Wrench,
} from 'lucide-react';

export interface ChecksumBlock {
  id: string;
  name: string;
  algorithm: string;
  start: number;
  end: number; // exclusive
  storeAddress: number;
  expectedHex: string;
  actualHex: string;
  valid: boolean;
  protected?: boolean;
}

export type FlashToolPreset = 'KESSv2 / KESS3' | 'Autotuner' | 'Flex';

export interface FlashPreflightViewProps {
  bytes: Uint8Array;
  baselineBytes: Uint8Array | null;
  fileName?: string;
  blocks: ChecksumBlock[];
  cvnHex?: string;
  tprotProtectedCount?: number;
  onFixChecksums: () => void;
  onReplaceBytes?: (nextBytes: Uint8Array, label: string) => void;
}

function formatHex(addr: number): string {
  return `0x${Math.max(0, addr).toString(16).toUpperCase().padStart(5, '0')}`;
}

function triggerDownload(
  data: Uint8Array | string,
  filename: string,
  mime = 'application/octet-stream',
) {
  const part: BlobPart =
    typeof data === 'string' ? data : data.slice().buffer;
  const blob = new Blob([part], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function swapBytes(src: Uint8Array, groupSize: 2 | 4): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += groupSize) {
    if (i + groupSize <= src.length) {
      for (let k = 0; k < groupSize; k++) {
        out[i + k] = src[i + (groupSize - 1 - k)];
      }
    } else {
      for (let k = i; k < src.length; k++) out[k] = src[k];
    }
  }
  return out;
}

export const FlashPreflightView: React.FC<FlashPreflightViewProps> = ({
  bytes,
  baselineBytes,
  fileName = 'ecu_tuned.bin',
  blocks,
  cvnHex = 'A4F8C219',
  tprotProtectedCount = 1,
  onFixChecksums,
  onReplaceBytes,
}) => {
  const [preset, setPreset] = useState<FlashToolPreset>('KESSv2 / KESS3');
  const [correctBeforeExport, setCorrectBeforeExport] = useState(true);
  const [attachChangeList, setAttachChangeList] = useState(true);
  const [sliceStartHex, setSliceStartHex] = useState('0x20000');
  const [sliceEndHex, setSliceEndHex] = useState(
    `0x${Math.min(bytes.length, 0x30000).toString(16).toUpperCase()}`,
  );
  const [utilityNotice, setUtilityNotice] = useState<string | null>(null);

  const invalidFixableBlocks = useMemo(
    () => blocks.filter((b) => !b.valid && !b.protected),
    [blocks],
  );
  const validBlocksCount = useMemo(
    () => blocks.filter((b) => b.valid).length,
    [blocks],
  );

  const modifiedBytes = useMemo(() => {
    if (!baselineBytes || baselineBytes.length !== bytes.length) return 0;
    let count = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== baselineBytes[i]) count++;
    }
    return count;
  }, [bytes, baselineBytes]);

  const allValid = invalidFixableBlocks.length === 0 && blocks.length > 0;

  const handleExportBin = () => {
    if (correctBeforeExport && invalidFixableBlocks.length > 0) {
      onFixChecksums();
    }
    const baseName = fileName.replace(/\.bin$/i, '');
    const presetSlug = preset.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const outBinName = `${baseName}_${presetSlug}.bin`;
    triggerDownload(bytes, outBinName, 'application/octet-stream');

    if (attachChangeList) {
      const lines = [
        `MacTuner Flash Preflight Change List`,
        `Export Preset: ${preset}`,
        `File: ${outBinName}`,
        `Size: ${bytes.length} bytes`,
        `Modified Bytes: ${modifiedBytes}`,
        `CVN: ${cvnHex}`,
        `Checksum Blocks: ${validBlocksCount}/${blocks.length} valid`,
        '',
        'Blocks:',
        ...blocks.map(
          (b) =>
            `  - ${b.name} (${b.algorithm}) ${formatHex(b.start)}-${formatHex(b.end)} | Stored: ${b.actualHex} | Expected: ${b.expectedHex} | ${b.valid ? 'OK' : 'FIXED'}`,
        ),
      ];
      triggerDownload(lines.join('\n'), `${baseName}_changes.txt`, 'text/plain;charset=utf-8');
    }
    setUtilityNotice(`Exported ${outBinName}${attachChangeList ? ' + change list (.txt)' : ''}.`);
  };

  const handleSwap = (size: 2 | 4) => {
    const swapped = swapBytes(bytes, size);
    if (onReplaceBytes) {
      onReplaceBytes(swapped, `${size * 8}-Bit Byte Swap`);
      setUtilityNotice(`Applied ${size * 8}-bit byte swap to active buffer.`);
    } else {
      const outName = fileName.replace(/\.bin$/i, '') + `_swap${size * 8}.bin`;
      triggerDownload(swapped, outName);
      setUtilityNotice(`Downloaded ${outName}.`);
    }
  };

  const handleExtractSlice = () => {
    const start = parseInt(sliceStartHex.trim(), 16);
    const end = parseInt(sliceEndHex.trim(), 16);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > bytes.length) {
      setUtilityNotice('Invalid slice range. Check hex start/end offsets.');
      return;
    }
    const slice = bytes.slice(start, end);
    const outName = `${fileName.replace(/\.bin$/i, '')}_${formatHex(start)}_${formatHex(end)}.bin`;
    triggerDownload(slice, outName);
    setUtilityNotice(`Extracted ${slice.length.toLocaleString()} bytes to ${outName}.`);
  };

  return (
    <div className="h-full overflow-y-auto bg-[#0d1016] text-slate-100 p-5 space-y-5">
      {/* Hero Status Banner */}
      {!allValid ? (
        <div className="rounded-xl bg-gradient-to-r from-red-500/18 via-red-500/10 to-[#141821] border border-red-500/40 p-4 flex items-center justify-between gap-4 flex-wrap shadow-[0_8px_30px_rgba(239,68,68,0.12)]">
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-red-500/20 border border-red-500/40 flex items-center justify-center shrink-0">
              <ShieldAlert className="w-5 h-5 text-red-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-red-200">
                Blocker found — do not flash without fixing!
              </h2>
              <p className="text-xs text-red-200/75 mt-0.5">
                {invalidFixableBlocks.length} checksum block
                {invalidFixableBlocks.length === 1 ? '' : 's'} out of sync after calibration edits.
                Flashing an uncorrected binary can brick the ECU.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onFixChecksums}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#2589ff] hover:bg-[#1d78e8] text-white text-xs font-bold shadow-[0_4px_18px_rgba(37,137,255,0.45)] transition-all cursor-pointer"
          >
            <Wrench className="w-4 h-4" />
            <span>Fix Checksums ({invalidFixableBlocks.length})</span>
          </button>
        </div>
      ) : (
        <div className="rounded-xl bg-gradient-to-r from-emerald-500/18 via-emerald-500/10 to-[#141821] border border-emerald-500/40 p-4 flex items-center justify-between gap-4 flex-wrap shadow-[0_8px_30px_rgba(16,185,129,0.12)]">
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-emerald-200">
                Ready to Flash — All checksum blocks valid
              </h2>
              <p className="text-xs text-emerald-200/75 mt-0.5">
                All {validBlocksCount} checksum blocks verified and aligned. Safe to export for{' '}
                {preset}.
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-semibold">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Preflight Passed
          </span>
        </div>
      )}

      {/* 4 KPI Tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl bg-[#141821] border border-white/10 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            CHECKSUM BLOCKS
          </div>
          <div className="mt-2 text-xl font-mono tabular-nums font-bold text-white">
            <span className={allValid ? 'text-emerald-400' : 'text-red-400'}>
              {validBlocksCount}
            </span>
            <span className="text-slate-500"> / {blocks.length}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            {invalidFixableBlocks.length === 0
              ? 'All regions verified'
              : `${invalidFixableBlocks.length} fixable mismatch`}
          </div>
        </div>

        <div className="rounded-xl bg-[#141821] border border-white/10 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            CVN / COMPTEST
          </div>
          <div className="mt-2 text-xl font-mono tabular-nums font-bold text-[#6ab0ff]">
            0x{cvnHex}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">Calibration Verification No.</div>
        </div>

        <div className="rounded-xl bg-[#141821] border border-white/10 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            TPROT / PROTECTED
          </div>
          <div className="mt-2 text-xl font-mono tabular-nums font-bold text-slate-200 flex items-center gap-2">
            <Lock className="w-4 h-4 text-indigo-400" />
            <span>{tprotProtectedCount}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">Read-only RSA / OTP zones</div>
        </div>

        <div className="rounded-xl bg-[#141821] border border-white/10 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            MODIFIED BYTES
          </div>
          <div className="mt-2 text-xl font-mono tabular-nums font-bold text-[#fbbf24]">
            {modifiedBytes.toLocaleString()} B
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">Delta vs stock baseline</div>
        </div>
      </div>

      {/* Main 2-Column Area */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left: Checksum Blocks Table */}
        <div className="lg:col-span-7 rounded-xl bg-[#141821] border border-white/10 overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Checksum Blocks
            </h3>
            {invalidFixableBlocks.length > 0 && (
              <button
                type="button"
                onClick={onFixChecksums}
                className="text-xs font-semibold text-[#6ab0ff] hover:text-white transition-colors"
              >
                Fix All ({invalidFixableBlocks.length})
              </button>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/10 bg-white/[0.02] text-[11px] uppercase tracking-wider text-slate-400">
                  <th className="py-2.5 px-3.5 font-semibold">Block</th>
                  <th className="py-2.5 px-3.5 font-semibold">Algo</th>
                  <th className="py-2.5 px-3.5 font-semibold">Address Range</th>
                  <th className="py-2.5 px-3.5 font-semibold">Expected / Actual</th>
                  <th className="py-2.5 px-3.5 font-semibold text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06] text-xs">
                {blocks.map((blk) => (
                  <tr key={blk.id} className="hover:bg-white/[0.03]">
                    <td className="py-2.5 px-3.5 font-medium text-slate-100">{blk.name}</td>
                    <td className="py-2.5 px-3.5 font-mono text-[11px] text-slate-400">
                      {blk.algorithm}
                    </td>
                    <td className="py-2.5 px-3.5 font-mono tabular-nums text-slate-300">
                      {formatHex(blk.start)}–{formatHex(blk.end)}
                    </td>
                    <td className="py-2.5 px-3.5 font-mono tabular-nums text-[11px]">
                      <div className="text-emerald-400">Exp: {blk.expectedHex}</div>
                      <div className={blk.valid ? 'text-slate-400' : 'text-red-400'}>
                        Act: {blk.actualHex}
                      </div>
                    </td>
                    <td className="py-2.5 px-3.5 text-right">
                      {blk.protected ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/35 text-[11px] font-medium">
                          <Lock className="w-3 h-3" /> Protected
                        </span>
                      ) : blk.valid ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/35 text-[11px] font-semibold">
                          <CheckCircle2 className="w-3 h-3" /> OK
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#f59e0b]/15 text-[#fbbf24] border border-[#f59e0b]/35 text-[11px] font-semibold">
                          <AlertTriangle className="w-3 h-3" /> Fixable
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right: Flash-Tool Export + BIN Utilities */}
        <div className="lg:col-span-5 space-y-4">
          {/* Flash-Tool Export Card */}
          <div className="rounded-xl bg-[#141821] border border-white/10 p-4 space-y-3.5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Flash-Tool Export
            </h3>

            <div>
              <label className="block text-[11px] text-slate-400 mb-1.5">Target Flasher Preset</label>
              <div className="grid grid-cols-3 gap-1.5">
                {(['KESSv2 / KESS3', 'Autotuner', 'Flex'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPreset(p)}
                    className={`py-1.5 px-2 rounded-lg text-[11px] font-medium border transition-all ${
                      preset === p
                        ? 'bg-[#2589ff]/20 border-[#2589ff]/60 text-white'
                        : 'bg-[#0d1016] border-white/10 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2 pt-1">
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={correctBeforeExport}
                  onChange={(e) => setCorrectBeforeExport(e.target.checked)}
                  className="accent-[#2589ff]"
                />
                <span>Correct Checksum Before Export</span>
              </label>

              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={attachChangeList}
                  onChange={(e) => setAttachChangeList(e.target.checked)}
                  className="accent-[#2589ff]"
                />
                <span>Attach Change List (.txt)</span>
              </label>
            </div>

            <button
              type="button"
              onClick={handleExportBin}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-[#2589ff] hover:bg-[#1d78e8] text-white text-xs font-bold shadow-[0_4px_16px_rgba(37,137,255,0.35)] transition-all cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>Export &amp; Download .bin</span>
            </button>
          </div>

          {/* BIN Utilities Card */}
          <div className="rounded-xl bg-[#141821] border border-white/10 p-4 space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              BIN Utilities
            </h3>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => handleSwap(2)}
                className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-xs font-medium text-slate-200 transition-colors"
              >
                <ArrowLeftRight className="w-3.5 h-3.5 text-[#2589ff]" />
                <span>16-Bit Swap</span>
              </button>
              <button
                type="button"
                onClick={() => handleSwap(4)}
                className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-xs font-medium text-slate-200 transition-colors"
              >
                <ArrowLeftRight className="w-3.5 h-3.5 text-[#2589ff]" />
                <span>32-Bit Swap</span>
              </button>
            </div>

            <div className="pt-2 border-t border-white/10 space-y-2">
              <div className="text-[11px] text-slate-400">Extract Slice (Hex Range)</div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  value={sliceStartHex}
                  onChange={(e) => setSliceStartHex(e.target.value)}
                  className="px-2.5 py-1.5 rounded-md bg-[#0d1016] border border-white/10 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-[#2589ff]"
                  placeholder="0x20000"
                />
                <input
                  type="text"
                  value={sliceEndHex}
                  onChange={(e) => setSliceEndHex(e.target.value)}
                  className="px-2.5 py-1.5 rounded-md bg-[#0d1016] border border-white/10 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-[#2589ff]"
                  placeholder="0x30000"
                />
              </div>
              <button
                type="button"
                onClick={handleExtractSlice}
                className="w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-xs font-medium text-slate-200 transition-colors"
              >
                <Scissors className="w-3.5 h-3.5 text-[#f59e0b]" />
                <span>Extract Slice</span>
              </button>
            </div>

            {utilityNotice && (
              <div className="text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 rounded-lg px-2.5 py-1.5">
                {utilityNotice}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
