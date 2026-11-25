import React, { useMemo, useState } from 'react';
import {
  Activity,
  ArrowRightLeft,
  Binary,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  Download,
  FileDiff,
  FileText,
  Layers,
  Lock,
  Printer,
  Radar,
  ShieldAlert,
  ShieldCheck,
  Star,
  Table2,
  AlertTriangle,
} from 'lucide-react';
import {
  BinCodec,
  DiffCluster,
  XDFDefinition,
  XDFItem,
  cellDiffers,
  countChangedBytes,
  diffClusters,
  generateHtmlReport,
  identifyECU,
  layoutByteRange,
  scalingDisplay,
  scalingValue,
  verifyChecksums,
} from '@mactuner/core';

export interface OverviewViewProps {
  bytes: Uint8Array;
  baselineBytes?: Uint8Array | null;
  fileName?: string;
  compareName?: string;
  xdf?: XDFDefinition | null;
  checksumBlocks?: Array<{
    id: string;
    name: string;
    valid: boolean;
    protected?: boolean;
  }>;
  invalidChecksumCount?: number;
  favorites?: number[];
  outsideClusters?: DiffCluster[];
  onSelectMap?: (itemId: number) => void;
  onJumpToHex?: (address: number) => void;
  onSwitchSection?: (section: string, workbenchMode?: 'hex' | 'map') => void;
}

interface ModifiedMapRow {
  item: XDFItem;
  category: string;
  changedCells: number;
  totalCells: number;
  summary: string;
}

interface OffsetPill {
  label: string;
  value: string;
  offset: number;
}

function formatHex(addr: number): string {
  return `0x${Math.max(0, addr).toString(16).toUpperCase().padStart(5, '0')}`;
}

function findAsciiOffset(bin: Uint8Array, needle: string): number {
  if (!needle || needle === '—' || needle.length < 3 || bin.length < needle.length) return -1;
  const codes = Array.from(needle, (ch) => ch.charCodeAt(0));
  const limit = bin.length - codes.length;
  for (let i = 0; i <= limit; i++) {
    if (bin[i] === codes[0]) {
      let ok = true;
      for (let j = 1; j < codes.length; j++) {
        if (bin[i + j] !== codes[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
  }
  return -1;
}

function extractEpkInfo(bin: Uint8Array): { epk: string; offset: number } | null {
  const n = bin.length;
  let i = 0;
  while (i < n) {
    if (bin[i] >= 0x20 && bin[i] <= 0x7e) {
      const start = i;
      while (i < n && bin[i] >= 0x20 && bin[i] <= 0x7e && i - start < 96) i++;
      if (i - start >= 8) {
        let s = '';
        for (let k = start; k < i; k++) s += String.fromCharCode(bin[k]);
        if (/\d{2}\/\d{2}\/\d{2}/.test(s) || /EPK|MED17|EDC17|MG1|SIMOS/i.test(s)) {
          if (s.includes('/') || /EPK/i.test(s)) {
            return { epk: s.trim().slice(0, 40), offset: start };
          }
        }
      }
    } else {
      i++;
    }
  }
  return null;
}

function inferManufacturer(ecuFamily: string): string {
  const up = ecuFamily.toUpperCase();
  if (up.includes('BOSCH') || up.includes('MED') || up.includes('EDC') || up.includes('ME7') || up.includes('MG1') || up.includes('MD1')) {
    return 'Bosch';
  }
  if (up.includes('CONTINENTAL') || up.includes('SIMOS') || up.includes('SID') || up.includes('PCR')) {
    return 'Continental / Siemens';
  }
  if (up.includes('SIEMENS') || up.includes('MS4') || up.includes('MSD') || up.includes('MSV') || up.includes('MSS')) {
    return 'Siemens VDO';
  }
  if (up.includes('TEMIC') || up.includes('DQ') || up.includes('DL501')) return 'Temic / Continental';
  if (up.includes('MARELLI')) return 'Magneti Marelli';
  if (up.includes('DENSO')) return 'Denso';
  if (up.includes('DELPHI')) return 'Delphi';
  return 'OEM ECU';
}

function triggerDownload(data: string, filename: string, mime: string) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export const OverviewView: React.FC<OverviewViewProps> = ({
  bytes,
  baselineBytes = null,
  fileName = 'ecu_active.bin',
  compareName = 'Stock Baseline',
  xdf = null,
  checksumBlocks,
  invalidChecksumCount,
  favorites = [],
  outsideClusters: propOutsideClusters,
  onSelectMap,
  onJumpToHex,
  onSwitchSection,
}) => {
  const [copiedMd, setCopiedMd] = useState(false);

  const ecu = useMemo(() => identifyECU(bytes), [bytes]);
  const manufacturer = useMemo(() => inferManufacturer(ecu.ecuFamily), [ecu.ecuFamily]);
  const epkInfo = useMemo(() => extractEpkInfo(bytes), [bytes]);

  const offsetPills = useMemo<OffsetPill[]>(() => {
    const pills: OffsetPill[] = [];
    const swOff = findAsciiOffset(bytes, ecu.softwareNumber);
    if (swOff >= 0) pills.push({ label: 'SW', value: ecu.softwareNumber, offset: swOff });
    const hwOff = findAsciiOffset(bytes, ecu.hardwareNumber);
    if (hwOff >= 0) pills.push({ label: 'HW', value: ecu.hardwareNumber, offset: hwOff });
    if (ecu.oemPartNumber) {
      const oemOff = findAsciiOffset(bytes, ecu.oemPartNumber);
      if (oemOff >= 0) pills.push({ label: 'OEM', value: ecu.oemPartNumber, offset: oemOff });
    }
    if (epkInfo) {
      pills.push({ label: 'EPK', value: epkInfo.epk, offset: epkInfo.offset });
    }
    return pills;
  }, [bytes, ecu, epkInfo]);

  const modifiedByteCount = useMemo(
    () => (baselineBytes ? countChangedBytes(bytes, baselineBytes) : 0),
    [bytes, baselineBytes],
  );

  const modifiedMaps = useMemo<ModifiedMapRow[]>(() => {
    if (!xdf || !baselineBytes) return [];
    const rows: ModifiedMapRow[] = [];
    for (const item of xdf.items) {
      const l = item.data;
      const cat = item.categories.length > 0 ? (xdf.categories[item.categories[0]] ?? '') : '';
      if (item.itemKind.kind === 'table') {
        const total = l.rows * l.cols;
        let changed = 0;
        let maxPct = 0;
        for (let r = 0; r < l.rows; r++) {
          for (let c = 0; c < l.cols; c++) {
            const cell = { r, c };
            if (!cellDiffers(l, cell, bytes, baselineBytes)) continue;
            changed++;
            const curRaw = BinCodec.raw(l, cell, bytes);
            const origRaw = BinCodec.raw(l, cell, baselineBytes);
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
          rows.push({
            item,
            category: cat,
            changedCells: changed,
            totalCells: total,
            summary: `${changed}/${total} cells · max ${maxPct >= 0 ? '+' : ''}${maxPct.toFixed(1)}%`,
          });
        }
      } else if (item.itemKind.kind === 'constant') {
        const cell = { r: 0, c: 0 };
        if (cellDiffers(l, cell, bytes, baselineBytes)) {
          const origRaw = BinCodec.raw(l, cell, baselineBytes);
          const curRaw = BinCodec.raw(l, cell, bytes);
          const origTxt = origRaw !== null ? scalingDisplay(item.scaling, origRaw, l) : '—';
          const curTxt = curRaw !== null ? scalingDisplay(item.scaling, curRaw, l) : '—';
          const unit = item.scaling.units ? ` ${item.scaling.units}` : '';
          rows.push({
            item,
            category: cat,
            changedCells: 1,
            totalCells: 1,
            summary: `${origTxt} → ${curTxt}${unit}`,
          });
        }
      } else if (item.itemKind.kind === 'flag') {
        const cell = { r: 0, c: 0 };
        if (cellDiffers(l, cell, bytes, baselineBytes)) {
          const origRaw = BinCodec.raw(l, cell, baselineBytes) ?? 0;
          const curRaw = BinCodec.raw(l, cell, bytes) ?? 0;
          const mask = item.itemKind.mask || 1;
          const oBit = Boolean(origRaw & mask) !== item.itemKind.invert ? 'ON' : 'OFF';
          const cBit = Boolean(curRaw & mask) !== item.itemKind.invert ? 'ON' : 'OFF';
          rows.push({
            item,
            category: cat,
            changedCells: 1,
            totalCells: 1,
            summary: `${oBit} → ${cBit}`,
          });
        }
      }
    }
    return rows;
  }, [xdf, bytes, baselineBytes]);

  const outsideClusters = useMemo<DiffCluster[]>(() => {
    if (propOutsideClusters) return propOutsideClusters;
    if (!baselineBytes) return [];
    const all = diffClusters(bytes, baselineBytes, 16);
    if (!xdf || xdf.items.length === 0) return all;
    const ranges = xdf.items.map((it) => layoutByteRange(it.data));
    return all.filter((cl) => !ranges.some(([s, e]) => cl.start < e && cl.end > s));
  }, [propOutsideClusters, bytes, baselineBytes, xdf]);

  const favoriteItems = useMemo<XDFItem[]>(() => {
    if (!xdf || favorites.length === 0) return [];
    const set = new Set(favorites);
    return xdf.items.filter((it) => set.has(it.id));
  }, [xdf, favorites]);

  const csStatus = useMemo(() => {
    if (invalidChecksumCount !== undefined) {
      return {
        invalid: invalidChecksumCount,
        total: checksumBlocks?.length ?? Math.max(1, invalidChecksumCount),
      };
    }
    if (checksumBlocks) {
      const inv = checksumBlocks.filter((b) => !b.valid && !b.protected).length;
      return { invalid: inv, total: checksumBlocks.length };
    }
    const rep = verifyChecksums(bytes, baselineBytes ?? undefined);
    return { invalid: rep.invalidCount, total: rep.blocks.length };
  }, [invalidChecksumCount, checksumBlocks, bytes, baselineBytes]);

  const buildTxtChangelog = () => {
    const lines = [
      `MacTuner Calibration Changelog`,
      `==============================`,
      `File: ${fileName} (${Math.round(bytes.length / 1024)} KB)`,
      `Baseline: ${compareName}`,
      `ECU: ${ecu.ecuFamily} (${ecu.architecture}) | HW: ${ecu.hardwareNumber} | SW: ${ecu.softwareNumber}`,
      `Modified Maps: ${modifiedMaps.length} | Modified Bytes: ${modifiedByteCount} B`,
      `Checksums: ${csStatus.invalid === 0 ? `OK (${csStatus.total} blocks)` : `${csStatus.invalid} invalid`}`,
      '',
      'Modified Parameters:',
      ...modifiedMaps.map(
        (m) => `  - ${m.item.title} [${formatHex(m.item.data.address)}] (${m.category || 'General'}): ${m.summary}`,
      ),
    ];
    if (outsideClusters.length > 0) {
      lines.push('', `Outside-XDF Diff Clusters (${outsideClusters.length}):`);
      for (const cl of outsideClusters.slice(0, 40)) {
        lines.push(`  - ${formatHex(cl.start)}–${formatHex(cl.end - 1)} (${cl.changedBytes} B)`);
      }
    }
    return lines.join('\n');
  };

  const buildMarkdownReport = () => {
    const lines = [
      `# MacTuner Calibration Report — \`${fileName}\``,
      '',
      `- **ECU:** ${ecu.ecuFamily} (${ecu.architecture})`,
      `- **HW / SW:** \`${ecu.hardwareNumber}\` / \`${ecu.softwareNumber}\``,
      `- **Size:** ${Math.round(bytes.length / 1024)} KB · **Modified:** ${modifiedMaps.length} maps (${modifiedByteCount.toLocaleString()} B)`,
      `- **Checksums:** ${csStatus.invalid === 0 ? `Valid (${csStatus.total} blocks)` : `${csStatus.invalid} invalid block(s)`}`,
      '',
      '| Map | Address | Category | Delta |',
      '| --- | --- | --- | --- |',
      ...modifiedMaps.map(
        (m) => `| ${m.item.title} | \`${formatHex(m.item.data.address)}\` | ${m.category || '—'} | ${m.summary} |`,
      ),
    ];
    return lines.join('\n');
  };

  const handleDownloadTxt = () => {
    const base = fileName.replace(/\.bin$/i, '');
    triggerDownload(buildTxtChangelog(), `${base}_changelog.txt`, 'text/plain;charset=utf-8');
  };

  const handleDownloadHtml = () => {
    const base = fileName.replace(/\.bin$/i, '');
    const html = generateHtmlReport(fileName, compareName, bytes, baselineBytes, xdf);
    triggerDownload(html, `${base}_report.html`, 'text/html;charset=utf-8');
  };

  const handlePrintPdf = () => {
    const html = generateHtmlReport(fileName, compareName, bytes, baselineBytes, xdf);
    const win = window.open('', '_blank');
    if (win) {
      win.document.write(html);
      win.document.close();
      win.focus();
      window.setTimeout(() => win.print(), 250);
    }
  };

  const handleCopyMarkdown = () => {
    const md = buildMarkdownReport();
    void navigator.clipboard?.writeText(md);
    setCopiedMd(true);
    window.setTimeout(() => setCopiedMd(false), 1800);
  };

  const workbenchCards = [
    {
      id: 'hex',
      title: 'Hex-Diff Workbench',
      desc: 'Byte-exact hex editor, diff clusters, markers & structure inspector',
      icon: <Binary className="w-4 h-4 text-[#5ac8fa]" />,
      accent: 'from-[#0a84ff]/15 to-transparent border-[#0a84ff]/25',
      action: () => onSwitchSection?.('workspace', 'hex'),
    },
    {
      id: 'map',
      title: '2D / 3D Map Editor',
      desc: 'Heatmap table, 3D WebGL surface, axis editor & interpolation tools',
      icon: <Table2 className="w-4 h-4 text-emerald-400" />,
      accent: 'from-emerald-500/15 to-transparent border-emerald-500/25',
      action: () => onSwitchSection?.('workspace', 'map'),
    },
    {
      id: 'discovery',
      title: 'Discovery, DTC & Porting',
      desc: 'Map finder, live DTC-Off switch patcher, cross-version & batch porting',
      icon: <Radar className="w-4 h-4 text-amber-400" />,
      accent: 'from-amber-500/15 to-transparent border-amber-500/25',
      action: () => onSwitchSection?.('discovery'),
    },
    {
      id: 'compare',
      title: 'Multi-File Compare',
      desc: 'Side-by-side Stock, Stage 1, Stage 2 & snapshot delta inspection',
      icon: <FileDiff className="w-4 h-4 text-purple-400" />,
      accent: 'from-purple-500/15 to-transparent border-purple-500/25',
      action: () => onSwitchSection?.('compare'),
    },
    {
      id: 'datalog',
      title: 'Datalog, Dyno & Auto-Tune',
      desc: 'CSV/ADX telemetry, virtual dyno, anomaly alerts & live OBD-II stream',
      icon: <Activity className="w-4 h-4 text-rose-400" />,
      accent: 'from-rose-500/15 to-transparent border-rose-500/25',
      action: () => onSwitchSection?.('datalog'),
    },
    {
      id: 'flash',
      title: 'Flash Preflight & Checksums',
      desc: '11 ECU/TCU checksums, CVN recovery, diagnostics, snapshots & export',
      icon: <ShieldCheck className="w-4 h-4 text-sky-400" />,
      accent: 'from-sky-500/15 to-transparent border-sky-500/25',
      action: () => onSwitchSection?.('flash'),
    },
  ];

  return (
    <div className="h-full overflow-y-auto bg-[#0c0d10] text-zinc-100 p-5 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold tracking-[-0.015em] text-white">
            Calibration Overview
          </h1>
          <p className="text-xs font-mono text-zinc-400 mt-0.5">
            {fileName}
            {baselineBytes ? ` vs ${compareName}` : ''}
            {xdf ? ` · ${xdf.title}` : ' · No XDF loaded'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleDownloadTxt}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 cursor-pointer"
          >
            <FileText className="w-3.5 h-3.5 text-zinc-400" />
            <span>TXT Changelog</span>
          </button>
          <button
            type="button"
            onClick={handleDownloadHtml}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5 text-[#5ac8fa]" />
            <span>HTML Report</span>
          </button>
          <button
            type="button"
            onClick={handlePrintPdf}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5 text-zinc-400" />
            <span>Print / PDF</span>
          </button>
          <button
            type="button"
            onClick={handleCopyMarkdown}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-semibold shadow-[0_2px_10px_rgba(10,132,255,0.3)] cursor-pointer"
          >
            {copiedMd ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedMd ? 'Copied Markdown' : 'Copy Markdown'}</span>
          </button>
        </div>
      </div>

      {/* Top KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
            <span>XDF Maps</span>
            <Layers className="w-3.5 h-3.5 text-[#5ac8fa]" />
          </div>
          <div className="mt-2 text-2xl font-mono tabular-nums font-bold text-white">
            {xdf?.items.length ?? 0}
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-500 truncate">
            {xdf ? xdf.title : 'Load XDF / A2L / KP'}
          </div>
        </div>

        <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
            <span>BIN Size</span>
            <Binary className="w-3.5 h-3.5 text-indigo-400" />
          </div>
          <div className="mt-2 text-2xl font-mono tabular-nums font-bold text-white">
            {bytes.length >= 1048576
              ? `${(bytes.length / 1048576).toFixed(2)} MB`
              : `${Math.round(bytes.length / 1024)} KB`}
          </div>
          <div className="mt-0.5 text-[11px] font-mono tabular-nums text-zinc-500">
            {bytes.length.toLocaleString()} bytes
          </div>
        </div>

        <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
            <span>Changed Maps</span>
            <ArrowRightLeft className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div className="mt-2 text-2xl font-mono tabular-nums font-bold text-amber-400">
            {modifiedMaps.length}
          </div>
          <div className="mt-0.5 text-[11px] font-mono tabular-nums text-zinc-500">
            {modifiedByteCount.toLocaleString()} B delta vs baseline
          </div>
        </div>

        <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
            <span>Checksum Status</span>
            {csStatus.invalid === 0 ? (
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
            )}
          </div>
          <div
            className={`mt-2 text-2xl font-mono tabular-nums font-bold ${
              csStatus.invalid === 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {csStatus.invalid === 0 ? 'Valid' : `${csStatus.invalid} Invalid`}
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-500">
            {csStatus.total} block{csStatus.total === 1 ? '' : 's'} verified
          </div>
        </div>
      </div>

      {/* ECU Identity Card */}
      <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 space-y-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#0a84ff]/15 border border-[#0a84ff]/30 flex items-center justify-center">
              <Cpu className="w-4 h-4 text-[#5ac8fa]" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-sm font-semibold text-white">ECU Identity &amp; Signatures</h2>
                <span className="px-2 py-0.5 rounded-full bg-white/[0.06] text-[10.5px] font-mono text-zinc-300">
                  {ecu.architecture} · {ecu.endianness}
                </span>
              </div>
              <p className="text-[11px] text-zinc-400">
                Automatic binary signature extraction — click any hex offset pill to inspect in Hex-Diff
              </p>
            </div>
          </div>

          {ecu.hasTPROT ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-500/35 text-amber-300 text-xs font-semibold">
              <Lock className="w-3.5 h-3.5" />
              TPROT / RSA Active
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-semibold">
              <CheckCircle2 className="w-3.5 h-3.5" />
              No TPROT Detected
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
          {[
            { label: 'Manufacturer', value: manufacturer },
            { label: 'ECU Family', value: ecu.ecuFamily },
            { label: 'Hardware (HW)', value: ecu.hardwareNumber },
            { label: 'Software (SW)', value: ecu.softwareNumber },
            { label: 'EPK / OEM Part', value: epkInfo?.epk ?? ecu.oemPartNumber ?? '—' },
          ].map((field) => (
            <div
              key={field.label}
              className="rounded-lg bg-[#0c0d10] border border-white/[0.06] px-3 py-2"
            >
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">{field.label}</div>
              <div
                className="text-xs font-mono font-semibold text-zinc-100 mt-0.5 truncate"
                title={field.value}
              >
                {field.value}
              </div>
            </div>
          ))}
        </div>

        {offsetPills.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <span className="text-[10.5px] uppercase tracking-wider text-zinc-500">
              Signature Offsets:
            </span>
            {offsetPills.map((p) => (
              <button
                key={`${p.label}-${p.offset}`}
                type="button"
                onClick={() => onJumpToHex?.(p.offset)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#0a84ff]/12 hover:bg-[#0a84ff]/25 border border-[#0a84ff]/30 text-[11px] font-mono text-[#5ac8fa] transition-colors cursor-pointer"
                title={`Jump to ${p.label} (${p.value}) at ${formatHex(p.offset)}`}
              >
                <span className="text-zinc-400">{p.label}</span>
                <span>{formatHex(p.offset)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 6 Quick Workbench Cards */}
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-2.5">
          Quick Workbenches
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {workbenchCards.map((card) => (
            <button
              key={card.id}
              type="button"
              onClick={card.action}
              className={`text-left rounded-xl bg-gradient-to-br ${card.accent} bg-[#17181d] border p-4 hover:brightness-110 transition-all cursor-pointer group`}
            >
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-[#0c0d10]/80 border border-white/[0.08] flex items-center justify-center shrink-0">
                  {card.icon}
                </div>
                <div className="text-xs font-semibold text-white group-hover:text-[#5ac8fa] transition-colors">
                  {card.title}
                </div>
              </div>
              <p className="text-[11px] text-zinc-400 mt-2 leading-relaxed">{card.desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Bottom Grid: Modified Maps Table (Left) + Favorites & Outside-XDF Changes (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Modified Maps Table */}
        <div className="lg:col-span-8 rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] flex flex-col">
          <div className="px-4 py-3 border-b border-white/[0.065] flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Table2 className="w-4 h-4 text-[#5ac8fa]" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-200">
                Modified Calibration Maps ({modifiedMaps.length})
              </h3>
            </div>
            <span className="text-[11px] font-mono text-zinc-500">
              {modifiedByteCount.toLocaleString()} B total delta
            </span>
          </div>

          {modifiedMaps.length === 0 ? (
            <div className="p-10 text-center text-xs text-zinc-500">
              {baselineBytes
                ? 'No modified XDF maps detected compared to baseline binary.'
                : 'Load a comparison/stock baseline binary to track modified maps.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-white/[0.065] bg-white/[0.02] text-[10.5px] uppercase tracking-wider text-zinc-500">
                    <th className="py-2.5 px-4 font-semibold">Map</th>
                    <th className="py-2.5 px-4 font-semibold">Address</th>
                    <th className="py-2.5 px-4 font-semibold">Delta Summary</th>
                    <th className="py-2.5 px-4 font-semibold text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05]">
                  {modifiedMaps.map((row) => (
                    <tr key={row.item.id} className="hover:bg-white/[0.025] transition-colors">
                      <td className="py-2.5 px-4">
                        <div className="font-medium text-zinc-100">{row.item.title}</div>
                        {row.category && (
                          <div className="text-[10.5px] text-zinc-500">{row.category}</div>
                        )}
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-zinc-400">
                        {formatHex(row.item.data.address)}
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-amber-300">
                        {row.summary}
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => onSelectMap?.(row.item.id)}
                          className="px-2.5 py-1 rounded-md bg-[#0a84ff]/15 hover:bg-[#0a84ff]/30 text-[#5ac8fa] border border-[#0a84ff]/35 text-[11px] font-medium cursor-pointer"
                        >
                          Open Map
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right Column: Favorites & Outside-XDF Changes */}
        <div className="lg:col-span-4 space-y-4">
          {/* Favorites */}
          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="px-4 py-3 border-b border-white/[0.065] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Star className="w-3.5 h-3.5 text-amber-400" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-200">
                  Favorites ({favoriteItems.length})
                </h3>
              </div>
            </div>
            {favoriteItems.length === 0 ? (
              <div className="p-5 text-center text-[11.5px] text-zinc-500">
                Star frequently edited maps in the sidebar to pin them here.
              </div>
            ) : (
              <div className="divide-y divide-white/[0.05]">
                {favoriteItems.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => onSelectMap?.(it.id)}
                    className="w-full px-4 py-2.5 text-left hover:bg-white/[0.03] flex items-center justify-between gap-2 cursor-pointer"
                  >
                    <span className="text-xs font-medium text-zinc-200 truncate">{it.title}</span>
                    <span className="font-mono text-[10.5px] text-zinc-500 shrink-0">
                      {formatHex(it.data.address)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Outside-XDF Changes */}
          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="px-4 py-3 border-b border-white/[0.065] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-200">
                  Outside-XDF Changes ({outsideClusters.length})
                </h3>
              </div>
            </div>
            {outsideClusters.length === 0 ? (
              <div className="p-5 text-center text-[11.5px] text-zinc-500">
                All modified bytes fall cleanly inside defined XDF map ranges.
              </div>
            ) : (
              <div className="divide-y divide-white/[0.05] max-h-64 overflow-y-auto">
                {outsideClusters.slice(0, 30).map((cl) => (
                  <button
                    key={cl.start}
                    type="button"
                    onClick={() => onJumpToHex?.(cl.start)}
                    className="w-full px-4 py-2.5 text-left hover:bg-white/[0.03] flex items-center justify-between gap-2 cursor-pointer"
                  >
                    <span className="font-mono text-xs text-[#5ac8fa]">
                      {formatHex(cl.start)}–{formatHex(cl.end - 1)}
                    </span>
                    <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 font-mono text-[10.5px]">
                      {cl.changedBytes} B
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
