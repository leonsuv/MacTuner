import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeftRight,
  Binary,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Download,
  ExternalLink,
  FileText,
  History,
  Info,
  Lock,
  RotateCcw,
  Scissors,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Stethoscope,
  Table2,
  Trash2,
  Undo2,
  Wrench,
} from 'lucide-react';
import {
  DiagnosticSeverity,
  Snapshot,
  XDFDefinition,
  countChangedBytes,
  countChangedCells,
  crc32,
  diffClusters,
  generateHtmlReport,
  identifyECU,
  runDiagnostics,
} from '@mactuner/core';

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

type FlashSubTab = 'preflight' | 'diagnostics' | 'snapshots' | 'history' | 'report';

export interface EditHistoryItem {
  label: string;
  bytes: number;
  timestamp?: number;
}

export interface EcuChecksumProfile {
  id: string;
  label: string;
  family: string;
  algorithm: string;
  arch: string;
  tprotNote: string;
}

const ECU_CHECKSUM_PROFILES: EcuChecksumProfile[] = [
  {
    id: 'bosch-me7',
    label: 'Bosch ME7.x',
    family: 'Engine ECU',
    algorithm: 'Page SUM16+INV & Multipoint',
    arch: 'Infineon C167',
    tprotNote: 'No TPROT',
  },
  {
    id: 'bosch-med17',
    label: 'Bosch MED17/EDC17',
    family: 'Engine ECU',
    algorithm: 'TriCore PFLASH CRC32 (0xFADECAFE)',
    arch: 'TriCore TC17xx',
    tprotNote: 'TPROT / RSA OTP sectors',
  },
  {
    id: 'bosch-mg1',
    label: 'Bosch MG1/MD1',
    family: 'Engine ECU',
    algorithm: 'AURIX CRC32 + RSA-2048 Block',
    arch: 'TriCore TC29x/TC39x',
    tprotNote: 'Strict HSM / RSA signature',
  },
  {
    id: 'simos-18',
    label: 'Simos 18/19',
    family: 'Engine ECU',
    algorithm: 'Continental TriCore CRC32 + ASW',
    arch: 'TriCore TC1791',
    tprotNote: 'TPROT / Boot signature',
  },
  {
    id: 'continental-sid',
    label: 'Continental SID208/305/310',
    family: 'Engine ECU',
    algorithm: 'SID Multi-Block CRC32',
    arch: 'TriCore TC1797',
    tprotNote: 'Protected Bootloader',
  },
  {
    id: 'bmw-ms4x',
    label: 'BMW MS4x',
    family: 'Engine ECU',
    algorithm: 'Siemens C167 CRC16 / SUM16',
    arch: 'Infineon C167',
    tprotNote: 'No TPROT',
  },
  {
    id: 'bmw-mevd17',
    label: 'BMW MEVD17.2',
    family: 'Engine ECU',
    algorithm: 'Bosch TriCore CRC32 + CVN',
    arch: 'TriCore TC1797',
    tprotNote: 'TPROT v8–v11',
  },
  {
    id: 'temic-dq250',
    label: 'Temic DQ250',
    family: 'DSG TCU',
    algorithm: 'MPC555 / TriCore Block SUM32',
    arch: 'PowerPC / TriCore',
    tprotNote: 'Calibratable flash',
  },
  {
    id: 'temic-dq381',
    label: 'Temic DQ381/DQ500',
    family: 'DSG TCU',
    algorithm: 'VL381/DQ381 CRC32 + Header',
    arch: 'TriCore TC1782/TC275',
    tprotNote: 'RSA boot protection',
  },
  {
    id: 'temic-dl501',
    label: 'Temic DL501',
    family: 'S-Tronic TCU',
    algorithm: 'DL501 Gen1/Gen2 CRC32',
    arch: 'TriCore TC1766',
    tprotNote: 'Protected boot area',
  },
  {
    id: 'crc32-footer',
    label: 'Generic CRC32',
    family: 'Universal',
    algorithm: 'IEEE-802.3 CRC32 GF(2)',
    arch: 'Any',
    tprotNote: 'Custom range / footer',
  },
];

type ManualPatchAlgo = 'crc32' | 'add32' | 'add16';

export interface FlashPreflightViewProps {
  bytes: Uint8Array;
  baselineBytes: Uint8Array | null;
  fileName?: string;
  compareName?: string;
  blocks: ChecksumBlock[];
  cvnHex?: string;
  tprotProtectedCount?: number;
  xdf?: XDFDefinition | null;
  onFixChecksums: () => void;
  onReplaceBytes?: (nextBytes: Uint8Array, label: string) => void;
  onJumpToHex?: (addr: number) => void;
  onSelectMap?: (id: number) => void;
  historyEntries?: EditHistoryItem[];
  onUndo?: () => void;
  selectedProfileId?: string;
  onSelectProfile?: (profileId: string) => void;
}

function formatHex(addr: number): string {
  return `0x${Math.max(0, addr).toString(16).toUpperCase().padStart(5, '0')}`;
}

function triggerDownload(
  data: Uint8Array | string,
  filename: string,
  mime = 'application/octet-stream',
) {
  const part: BlobPart = typeof data === 'string' ? data : data.slice().buffer;
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

function parseHexOrDec(input: string): number {
  const s = input.trim();
  if (!s) return NaN;
  return s.toLowerCase().startsWith('0x') ? parseInt(s.slice(2), 16) : parseInt(s, 16);
}

function computeManualChecksum(
  bytes: Uint8Array,
  algo: ManualPatchAlgo,
  start: number,
  end: number,
  littleEndian: boolean,
): { value: number; width: 2 | 4; hex: string } {
  const lo = Math.max(0, Math.min(bytes.length, start));
  const hi = Math.max(lo, Math.min(bytes.length, end));
  if (algo === 'crc32') {
    const val = crc32(bytes, lo, hi) >>> 0;
    return { value: val, width: 4, hex: val.toString(16).toUpperCase().padStart(8, '0') };
  }
  if (algo === 'add32') {
    let sum = 0;
    for (let i = lo; i + 3 < hi; i += 4) {
      const w = littleEndian
        ? (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0
        : ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
      sum = (sum + w) >>> 0;
    }
    return { value: sum, width: 4, hex: sum.toString(16).toUpperCase().padStart(8, '0') };
  }
  let sum16 = 0;
  for (let i = lo; i + 1 < hi; i += 2) {
    const w = littleEndian
      ? (bytes[i] | (bytes[i + 1] << 8)) & 0xffff
      : ((bytes[i] << 8) | bytes[i + 1]) & 0xffff;
    sum16 = (sum16 + w) & 0xffff;
  }
  return { value: sum16, width: 2, hex: sum16.toString(16).toUpperCase().padStart(4, '0') };
}

export const FlashPreflightView: React.FC<FlashPreflightViewProps> = ({
  bytes,
  baselineBytes,
  fileName = 'ecu_tuned.bin',
  compareName = 'Stock Baseline',
  blocks,
  cvnHex = 'A4F8C219',
  tprotProtectedCount = 1,
  xdf = null,
  onFixChecksums,
  onReplaceBytes,
  onJumpToHex,
  onSelectMap,
  historyEntries = [],
  onUndo,
  selectedProfileId,
  onSelectProfile,
}) => {
  const [subTab, setSubTab] = useState<FlashSubTab>('preflight');
  const [preset, setPreset] = useState<FlashToolPreset>('KESSv2 / KESS3');
  const [correctBeforeExport, setCorrectBeforeExport] = useState(true);
  const [attachChangeList, setAttachChangeList] = useState(true);
  const [sliceStartHex, setSliceStartHex] = useState('0x20000');
  const [sliceEndHex, setSliceEndHex] = useState(
    `0x${Math.min(bytes.length, 0x30000).toString(16).toUpperCase()}`,
  );
  const [utilityNotice, setUtilityNotice] = useState<string | null>(null);

  // ECU Checksum Profile Selector state (11 ECU/TCU families)
  const [localProfileId, setLocalProfileId] = useState<string>('bosch-med17');
  const activeProfileId = selectedProfileId ?? localProfileId;
  const activeProfile = useMemo(
    () => ECU_CHECKSUM_PROFILES.find((p) => p.id === activeProfileId) ?? ECU_CHECKSUM_PROFILES[0],
    [activeProfileId],
  );

  // Collapsible Manual Range Patcher state
  const [patcherOpen, setPatcherOpen] = useState<boolean>(false);
  const [patchAlgo, setPatchAlgo] = useState<ManualPatchAlgo>('crc32');
  const [patchStartHex, setPatchStartHex] = useState<string>('0x10000');
  const [patchEndHex, setPatchEndHex] = useState<string>(
    `0x${Math.min(bytes.length, 0x1fffc).toString(16).toUpperCase()}`,
  );
  const [patchStoreHex, setPatchStoreHex] = useState<string>(
    `0x${Math.min(Math.max(0, bytes.length - 4), 0x1fffc).toString(16).toUpperCase()}`,
  );
  const [patchLittleEndian, setPatchLittleEndian] = useState<boolean>(true);

  // Edit History filter
  const [historySearch, setHistorySearch] = useState<string>('');

  // Diagnostics filter
  const [diagFilter, setDiagFilter] = useState<'all' | DiagnosticSeverity>('all');

  // Snapshots state
  const [snapshots, setSnapshots] = useState<Snapshot[]>(() =>
    baselineBytes
      ? [
          {
            id: 'snap-stock-initial',
            name: 'Stock Baseline Reference',
            createdAt: Date.now(),
            changedBytes: 0,
            bytes: baselineBytes.slice(),
            note: 'Auto-captured baseline binary',
          },
        ]
      : [],
  );
  const [snapshotName, setSnapshotName] = useState('');
  const [snapshotNote, setSnapshotNote] = useState('');

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
    return countChangedBytes(bytes, baselineBytes);
  }, [bytes, baselineBytes]);

  const allValid = invalidFixableBlocks.length === 0 && blocks.length > 0;

  // Diagnostics
  const findings = useMemo(
    () => runDiagnostics(bytes, baselineBytes, xdf ?? null),
    [bytes, baselineBytes, xdf],
  );

  const diagCounts = useMemo(() => {
    let error = 0;
    let warning = 0;
    let info = 0;
    for (const f of findings) {
      if (f.severity === 'error') error++;
      else if (f.severity === 'warning') warning++;
      else info++;
    }
    return { error, warning, info };
  }, [findings]);

  const visibleFindings = useMemo(
    () => (diagFilter === 'all' ? findings : findings.filter((f) => f.severity === diagFilter)),
    [findings, diagFilter],
  );

  // Report summary
  const reportSummary = useMemo(() => {
    const ecu = identifyECU(bytes);
    const clusters = baselineBytes ? diffClusters(bytes, baselineBytes) : [];
    let modifiedMaps = 0;
    if (xdf && baselineBytes) {
      for (const item of xdf.items) {
        if (countChangedCells(item, bytes, baselineBytes) > 0) modifiedMaps++;
      }
    }
    return { ecu, clusterCount: clusters.length, modifiedMaps };
  }, [bytes, baselineBytes, xdf]);

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
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > bytes.length
    ) {
      setUtilityNotice('Invalid slice range. Check hex start/end offsets.');
      return;
    }
    const slice = bytes.slice(start, end);
    const outName = `${fileName.replace(/\.bin$/i, '')}_${formatHex(start)}_${formatHex(end)}.bin`;
    triggerDownload(slice, outName);
    setUtilityNotice(`Extracted ${slice.length.toLocaleString()} bytes to ${outName}.`);
  };

  const handleSaveSnapshot = () => {
    const name = snapshotName.trim() || `Snapshot ${snapshots.length + 1}`;
    const nextSnap: Snapshot = {
      id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      createdAt: Date.now(),
      changedBytes: modifiedBytes,
      bytes: bytes.slice(),
      note: snapshotNote.trim() || undefined,
    };
    setSnapshots((prev) => [nextSnap, ...prev]);
    setSnapshotName('');
    setSnapshotNote('');
  };

  const handleRestoreSnapshot = (snap: Snapshot) => {
    if (onReplaceBytes) {
      onReplaceBytes(snap.bytes.slice(), `Restored snapshot: ${snap.name}`);
      setUtilityNotice(`Restored "${snap.name}" into active BIN buffer.`);
    } else {
      triggerDownload(
        snap.bytes,
        `${snap.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.bin`,
      );
    }
  };

  const manualPatchPreview = useMemo(() => {
    const start = parseHexOrDec(patchStartHex);
    const end = parseHexOrDec(patchEndHex);
    const store = parseHexOrDec(patchStoreHex);
    const width: 2 | 4 = patchAlgo === 'add16' ? 2 : 4;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      !Number.isFinite(store) ||
      start < 0 ||
      end <= start ||
      end > bytes.length ||
      store < 0 ||
      store + width > bytes.length
    ) {
      return null;
    }
    const computed = computeManualChecksum(bytes, patchAlgo, start, end, patchLittleEndian);
    let stored = 0;
    if (width === 4) {
      stored = patchLittleEndian
        ? (bytes[store] |
            (bytes[store + 1] << 8) |
            (bytes[store + 2] << 16) |
            (bytes[store + 3] << 24)) >>>
          0
        : ((bytes[store] << 24) |
            (bytes[store + 1] << 16) |
            (bytes[store + 2] << 8) |
            bytes[store + 3]) >>>
          0;
    } else {
      stored = patchLittleEndian
        ? (bytes[store] | (bytes[store + 1] << 8)) & 0xffff
        : ((bytes[store] << 8) | bytes[store + 1]) & 0xffff;
    }
    const storedHex = stored.toString(16).toUpperCase().padStart(width * 2, '0');
    return {
      start,
      end,
      store,
      width,
      computedVal: computed.value,
      computedHex: computed.hex,
      storedHex,
      matches: computed.hex === storedHex,
    };
  }, [bytes, patchAlgo, patchStartHex, patchEndHex, patchStoreHex, patchLittleEndian]);

  const handleApplyManualPatch = () => {
    if (!manualPatchPreview) {
      setUtilityNotice('Invalid manual range or store address. Check hex bounds.');
      return;
    }
    const { store, width, computedVal, computedHex } = manualPatchPreview;
    const next = new Uint8Array(bytes);
    if (width === 4) {
      const u = computedVal >>> 0;
      if (patchLittleEndian) {
        next[store] = u & 0xff;
        next[store + 1] = (u >>> 8) & 0xff;
        next[store + 2] = (u >>> 16) & 0xff;
        next[store + 3] = (u >>> 24) & 0xff;
      } else {
        next[store] = (u >>> 24) & 0xff;
        next[store + 1] = (u >>> 16) & 0xff;
        next[store + 2] = (u >>> 8) & 0xff;
        next[store + 3] = u & 0xff;
      }
    } else {
      const u = computedVal & 0xffff;
      if (patchLittleEndian) {
        next[store] = u & 0xff;
        next[store + 1] = (u >>> 8) & 0xff;
      } else {
        next[store] = (u >>> 8) & 0xff;
        next[store + 1] = u & 0xff;
      }
    }
    const algoName =
      patchAlgo === 'crc32' ? 'CRC32 GF(2)' : patchAlgo === 'add32' ? 'ADD32' : 'ADD16';
    const label = `Manual ${algoName} Patch @ ${formatHex(store)} (0x${computedHex})`;
    if (onReplaceBytes) {
      onReplaceBytes(next, label);
      setUtilityNotice(`Patched ${formatHex(store)} with 0x${computedHex} (${algoName}).`);
    } else {
      const outName = `${fileName.replace(/\.bin$/i, '')}_patched.bin`;
      triggerDownload(next, outName);
      setUtilityNotice(`Downloaded ${outName} with ${algoName} 0x${computedHex} @ ${formatHex(store)}.`);
    }
  };

  const filteredHistory = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    const indexed = historyEntries.map((entry, idx) => ({ entry, stepNumber: idx + 1 }));
    indexed.reverse(); // newest first
    if (!q) return indexed;
    return indexed.filter((item) => item.entry.label.toLowerCase().includes(q));
  }, [historyEntries, historySearch]);

  const totalHistoryBytes = useMemo(
    () => historyEntries.reduce((acc, e) => acc + Math.max(0, e.bytes), 0),
    [historyEntries],
  );

  const handleExportHistoryCsv = () => {
    const header = 'Step,Label,PatchedBytes,Timestamp';
    const rows = historyEntries.map((e, i) => {
      const ts = e.timestamp ? new Date(e.timestamp).toISOString() : '';
      const escaped = `"${e.label.replace(/"/g, '""')}"`;
      return `${i + 1},${escaped},${e.bytes},${ts}`;
    });
    const outName = `${fileName.replace(/\.bin$/i, '')}_edit_history.csv`;
    triggerDownload([header, ...rows].join('\n'), outName, 'text/csv;charset=utf-8');
    setUtilityNotice(`Exported ${outName}.`);
  };

  const handleDownloadHtmlReport = () => {
    const html = generateHtmlReport(
      fileName,
      compareName,
      bytes,
      baselineBytes,
      xdf ?? null,
    );
    const outName = `${fileName.replace(/\.bin$/i, '')}_tune_report.html`;
    triggerDownload(html, outName, 'text/html;charset=utf-8');
    setUtilityNotice(`Downloaded ${outName}.`);
  };

  const handlePreviewHtmlReport = () => {
    const html = generateHtmlReport(
      fileName,
      compareName,
      bytes,
      baselineBytes,
      xdf ?? null,
    );
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    window.setTimeout(() => URL.revokeObjectURL(url), 15000);
  };

  return (
    <div className="h-full flex flex-col bg-[#0c0d10] text-zinc-100 overflow-hidden">
      {/* Sub-Tab Strip */}
      <div className="px-5 py-3 border-b border-white/[0.065] bg-[#121317] flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] border border-white/[0.065]">
          {(
            [
              {
                id: 'preflight',
                label: 'Preflight & Checksums',
                icon: <ShieldCheck className="w-3.5 h-3.5" />,
                badge: invalidFixableBlocks.length > 0 ? invalidFixableBlocks.length : null,
                badgeTone: 'rose',
              },
              {
                id: 'diagnostics',
                label: 'Diagnostics & Lint',
                icon: <Stethoscope className="w-3.5 h-3.5" />,
                badge: findings.length > 0 ? findings.length : null,
                badgeTone: diagCounts.error > 0 ? 'rose' : 'amber',
              },
              {
                id: 'snapshots',
                label: 'Snapshots',
                icon: <History className="w-3.5 h-3.5" />,
                badge: snapshots.length > 0 ? snapshots.length : null,
                badgeTone: 'zinc',
              },
              {
                id: 'history',
                label: 'Edit History',
                icon: <Clock className="w-3.5 h-3.5" />,
                badge: historyEntries.length > 0 ? historyEntries.length : null,
                badgeTone: 'zinc',
              },
              {
                id: 'report',
                label: 'Report Export',
                icon: <FileText className="w-3.5 h-3.5" />,
                badge: null,
                badgeTone: 'zinc',
              },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSubTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11.5px] font-medium transition-all cursor-pointer ${
                subTab === tab.id
                  ? 'bg-[#0a84ff] text-white shadow-[0_1px_10px_rgba(10,132,255,0.4)]'
                  : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
              {tab.badge !== null && (
                <span
                  className={`px-1.5 py-0.2 rounded-full font-mono text-[10px] ${
                    subTab === tab.id
                      ? 'bg-white/20 text-white'
                      : tab.badgeTone === 'rose'
                        ? 'bg-rose-500/20 text-rose-300'
                        : tab.badgeTone === 'amber'
                          ? 'bg-amber-500/20 text-amber-300'
                          : 'bg-white/[0.08] text-zinc-300'
                  }`}
                >
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="text-[11.5px] font-mono tabular-nums text-zinc-400">
          {fileName} · {(bytes.length / 1024).toFixed(0)} KB
        </div>
      </div>

      {/* TAB 1: PREFLIGHT & CHECKSUMS */}
      {subTab === 'preflight' && (
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Hero Status Banner */}
          {!allValid ? (
            <div className="rounded-xl bg-gradient-to-r from-rose-500/15 via-rose-500/[0.07] to-[#17181d] border border-rose-500/35 p-4 flex items-center justify-between gap-4 flex-wrap shadow-[0_8px_30px_rgba(244,63,94,0.1)]">
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-xl bg-rose-500/20 border border-rose-500/35 flex items-center justify-center shrink-0">
                  <ShieldAlert className="w-5 h-5 text-rose-400" />
                </div>
                <div>
                  <h2 className="text-sm font-bold tracking-[-0.01em] text-rose-200">
                    Blocker found — do not flash without fixing!
                  </h2>
                  <p className="text-xs text-rose-200/75 mt-0.5">
                    {invalidFixableBlocks.length} checksum block
                    {invalidFixableBlocks.length === 1 ? '' : 's'} out of sync after calibration edits.
                    Flashing an uncorrected binary can brick the ECU.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onFixChecksums}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-bold shadow-[0_4px_18px_rgba(10,132,255,0.4)] transition-all cursor-pointer"
              >
                <Wrench className="w-4 h-4" />
                <span>Fix Checksums ({invalidFixableBlocks.length})</span>
              </button>
            </div>
          ) : (
            <div className="rounded-xl bg-gradient-to-r from-emerald-500/15 via-emerald-500/[0.07] to-[#17181d] border border-emerald-500/35 p-4 flex items-center justify-between gap-4 flex-wrap shadow-[0_8px_30px_rgba(16,185,129,0.1)]">
              <div className="flex items-center gap-3.5">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/35 flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-5 h-5 text-emerald-400" />
                </div>
                <div>
                  <h2 className="text-sm font-bold tracking-[-0.01em] text-emerald-200">
                    Ready to Flash — All checksum blocks valid
                  </h2>
                  <p className="text-xs text-emerald-200/75 mt-0.5">
                    All {validBlocksCount} checksum blocks verified and aligned. Safe to export for{' '}
                    {preset}.
                  </p>
                </div>
              </div>
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/20 border border-emerald-500/35 text-emerald-300 text-xs font-semibold">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Preflight Passed
              </span>
            </div>
          )}

          {/* 4 KPI Tiles */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                CHECKSUM BLOCKS
              </div>
              <div className="mt-2 text-xl font-mono tabular-nums font-bold text-white">
                <span className={allValid ? 'text-emerald-400' : 'text-rose-400'}>
                  {validBlocksCount}
                </span>
                <span className="text-zinc-500"> / {blocks.length}</span>
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-500">
                {invalidFixableBlocks.length === 0
                  ? 'All regions verified'
                  : `${invalidFixableBlocks.length} fixable mismatch`}
              </div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                CVN / COMPTEST
              </div>
              <div className="mt-2 text-xl font-mono tabular-nums font-bold text-[#5ac8fa]">
                0x{cvnHex}
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-500">Calibration Verification No.</div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                TPROT / PROTECTED
              </div>
              <div className="mt-2 text-xl font-mono tabular-nums font-bold text-zinc-200 flex items-center gap-2">
                <Lock className="w-4 h-4 text-indigo-400" />
                <span>{tprotProtectedCount}</span>
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-500">Read-only RSA / OTP zones</div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                MODIFIED BYTES
              </div>
              <div className="mt-2 text-xl font-mono tabular-nums font-bold text-amber-400">
                {modifiedBytes.toLocaleString()} B
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-500">Delta vs stock baseline</div>
            </div>
          </div>

          {/* ECU Checksum Profile Selector Bar (All 11 ECU/TCU Families) */}
          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3.5 flex items-center justify-between gap-4 flex-wrap shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="w-8 h-8 rounded-lg bg-[#0a84ff]/15 border border-[#0a84ff]/30 flex items-center justify-center shrink-0">
                <Cpu className="w-4 h-4 text-[#5ac8fa]" />
              </div>
              <div>
                <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400">
                  ECU / TCU Checksum Profile
                </div>
                <div className="text-[11px] text-zinc-400 mt-0.5">
                  <span className="text-zinc-200 font-medium">{activeProfile.algorithm}</span>
                  <span className="mx-1.5 text-zinc-600">·</span>
                  <span>{activeProfile.arch}</span>
                  <span className="mx-1.5 text-zinc-600">·</span>
                  <span className="text-amber-300/90">{activeProfile.tprotNote}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-[11px] text-zinc-400" htmlFor="ecu-profile-select">
                Profile
              </label>
              <select
                id="ecu-profile-select"
                value={activeProfileId}
                onChange={(e) => {
                  setLocalProfileId(e.target.value);
                  onSelectProfile?.(e.target.value);
                }}
                className="px-3 py-1.5 rounded-lg bg-[#0c0d10] border border-white/[0.1] text-xs font-medium text-zinc-100 focus:outline-none focus:border-[#0a84ff] cursor-pointer"
              >
                {ECU_CHECKSUM_PROFILES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} ({p.family})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Main 2-Column Area */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Left: Checksum Blocks Table + Collapsible Manual Range Patcher */}
            <div className="lg:col-span-7 space-y-4">
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden flex flex-col shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="px-4 py-3 border-b border-white/[0.065] flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                  Checksum Blocks
                </h3>
                {invalidFixableBlocks.length > 0 && (
                  <button
                    type="button"
                    onClick={onFixChecksums}
                    className="text-xs font-semibold text-[#5ac8fa] hover:text-white transition-colors cursor-pointer"
                  >
                    Fix All ({invalidFixableBlocks.length})
                  </button>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/[0.065] bg-white/[0.02] text-[10.5px] uppercase tracking-wider text-zinc-500">
                      <th className="py-2.5 px-3.5 font-semibold">Block</th>
                      <th className="py-2.5 px-3.5 font-semibold">Algo</th>
                      <th className="py-2.5 px-3.5 font-semibold">Address Range</th>
                      <th className="py-2.5 px-3.5 font-semibold">Expected / Actual</th>
                      <th className="py-2.5 px-3.5 font-semibold text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.05] text-xs">
                    {blocks.map((blk) => (
                      <tr key={blk.id} className="hover:bg-white/[0.025] transition-colors">
                        <td className="py-2.5 px-3.5 font-medium text-zinc-100">{blk.name}</td>
                        <td className="py-2.5 px-3.5 font-mono text-[11px] text-zinc-400">
                          {blk.algorithm}
                        </td>
                        <td className="py-2.5 px-3.5 font-mono tabular-nums text-zinc-300">
                          {formatHex(blk.start)}–{formatHex(blk.end)}
                        </td>
                        <td className="py-2.5 px-3.5 font-mono tabular-nums text-[11px]">
                          <div className="text-emerald-400">Exp: {blk.expectedHex}</div>
                          <div className={blk.valid ? 'text-zinc-400' : 'text-rose-400'}>
                            Act: {blk.actualHex}
                          </div>
                        </td>
                        <td className="py-2.5 px-3.5 text-right">
                          {blk.protected ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 text-[11px] font-medium">
                              <Lock className="w-3 h-3" /> Protected
                            </span>
                          ) : blk.valid ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-[11px] font-semibold">
                              <CheckCircle2 className="w-3 h-3" /> OK
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[11px] font-semibold">
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

              {/* Collapsible Manual Range Patcher */}
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                <button
                  type="button"
                  onClick={() => setPatcherOpen((v) => !v)}
                  className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-white/[0.02] transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    {patcherOpen ? (
                      <ChevronDown className="w-4 h-4 text-zinc-400" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-zinc-400" />
                    )}
                    <Sliders className="w-3.5 h-3.5 text-[#5ac8fa]" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-200">
                      Manual Range Patcher
                    </span>
                    <span className="px-2 py-0.5 rounded-full bg-white/[0.05] font-mono text-[10px] text-zinc-400">
                      CRC32 GF(2) / ADD32 / ADD16
                    </span>
                  </div>
                  <span className="text-[11px] text-zinc-500">
                    {patcherOpen ? 'Hide' : 'Expand'}
                  </span>
                </button>

                {patcherOpen && (
                  <div className="px-4 pb-4 pt-2 border-t border-white/[0.065] space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <div>
                        <label className="block text-[10.5px] text-zinc-400 mb-1">Algorithm</label>
                        <select
                          value={patchAlgo}
                          onChange={(e) => setPatchAlgo(e.target.value as ManualPatchAlgo)}
                          className="w-full px-2.5 py-1.5 rounded-lg bg-[#0c0d10] border border-white/[0.08] text-xs font-mono text-zinc-100 focus:outline-none focus:border-[#0a84ff]"
                        >
                          <option value="crc32">CRC32 GF(2) (IEEE-802.3, 32-bit)</option>
                          <option value="add32">ADD32 (32-bit Word Sum)</option>
                          <option value="add16">ADD16 (16-bit Word Sum)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-[10.5px] text-zinc-400 mb-1">Byte Order</label>
                        <div className="grid grid-cols-2 gap-1.5">
                          <button
                            type="button"
                            onClick={() => setPatchLittleEndian(true)}
                            className={`py-1.5 rounded-lg text-[11px] font-medium border cursor-pointer ${
                              patchLittleEndian
                                ? 'bg-[#0a84ff]/20 border-[#0a84ff]/50 text-white'
                                : 'bg-[#0c0d10] border-white/[0.07] text-zinc-400'
                            }`}
                          >
                            Little-Endian
                          </button>
                          <button
                            type="button"
                            onClick={() => setPatchLittleEndian(false)}
                            className={`py-1.5 rounded-lg text-[11px] font-medium border cursor-pointer ${
                              !patchLittleEndian
                                ? 'bg-[#0a84ff]/20 border-[#0a84ff]/50 text-white'
                                : 'bg-[#0c0d10] border-white/[0.07] text-zinc-400'
                            }`}
                          >
                            Big-Endian
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="block text-[10.5px] text-zinc-400 mb-1">
                          Range Start (Hex)
                        </label>
                        <input
                          type="text"
                          value={patchStartHex}
                          onChange={(e) => setPatchStartHex(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-md bg-[#0c0d10] border border-white/[0.08] text-xs font-mono text-zinc-100 focus:outline-none focus:border-[#0a84ff]"
                          placeholder="0x10000"
                        />
                      </div>
                      <div>
                        <label className="block text-[10.5px] text-zinc-400 mb-1">
                          Range End (Hex)
                        </label>
                        <input
                          type="text"
                          value={patchEndHex}
                          onChange={(e) => setPatchEndHex(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-md bg-[#0c0d10] border border-white/[0.08] text-xs font-mono text-zinc-100 focus:outline-none focus:border-[#0a84ff]"
                          placeholder="0x1FFFC"
                        />
                      </div>
                      <div>
                        <label className="block text-[10.5px] text-zinc-400 mb-1">
                          Store Address (Hex)
                        </label>
                        <input
                          type="text"
                          value={patchStoreHex}
                          onChange={(e) => setPatchStoreHex(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-md bg-[#0c0d10] border border-white/[0.08] text-xs font-mono text-zinc-100 focus:outline-none focus:border-[#0a84ff]"
                          placeholder="0x1FFFC"
                        />
                      </div>
                    </div>

                    {manualPatchPreview ? (
                      <div className="rounded-lg bg-[#0c0d10] border border-white/[0.07] p-3 flex items-center justify-between gap-3 flex-wrap">
                        <div className="font-mono text-[11px] space-y-0.5">
                          <div>
                            <span className="text-zinc-500">Computed: </span>
                            <span className="text-emerald-400 font-semibold">
                              0x{manualPatchPreview.computedHex}
                            </span>
                          </div>
                          <div>
                            <span className="text-zinc-500">Stored @ {formatHex(manualPatchPreview.store)}: </span>
                            <span
                              className={
                                manualPatchPreview.matches ? 'text-zinc-300' : 'text-amber-300'
                              }
                            >
                              0x{manualPatchPreview.storedHex}
                            </span>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={handleApplyManualPatch}
                          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-semibold cursor-pointer"
                        >
                          <Wrench className="w-3.5 h-3.5" />
                          <span>Patch Store Address</span>
                        </button>
                      </div>
                    ) : (
                      <div className="text-[11px] text-rose-400 bg-rose-500/10 border border-rose-500/25 rounded-lg px-3 py-2">
                        Invalid hex range or store offset exceeds binary length (0x
                        {bytes.length.toString(16).toUpperCase()}).
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Right: Flash-Tool Export + BIN Utilities */}
            <div className="lg:col-span-5 space-y-4">
              {/* Flash-Tool Export Card */}
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 space-y-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                  Flash-Tool Export
                </h3>

                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1.5">
                    Target Flasher Preset
                  </label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(['KESSv2 / KESS3', 'Autotuner', 'Flex'] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setPreset(p)}
                        className={`py-1.5 px-2 rounded-lg text-[11px] font-medium border transition-all cursor-pointer ${
                          preset === p
                            ? 'bg-[#0a84ff]/20 border-[#0a84ff]/55 text-white'
                            : 'bg-[#0c0d10] border-white/[0.07] text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2 pt-1">
                  <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={correctBeforeExport}
                      onChange={(e) => setCorrectBeforeExport(e.target.checked)}
                      className="accent-[#0a84ff]"
                    />
                    <span>Correct Checksum Before Export</span>
                  </label>

                  <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={attachChangeList}
                      onChange={(e) => setAttachChangeList(e.target.checked)}
                      className="accent-[#0a84ff]"
                    />
                    <span>Attach Change List (.txt)</span>
                  </label>
                </div>

                <button
                  type="button"
                  onClick={handleExportBin}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-bold shadow-[0_4px_16px_rgba(10,132,255,0.35)] transition-all cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>Export &amp; Download .bin</span>
                </button>
              </div>

              {/* BIN Utilities Card */}
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 space-y-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                  BIN Utilities
                </h3>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => handleSwap(2)}
                    className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
                  >
                    <ArrowLeftRight className="w-3.5 h-3.5 text-[#0a84ff]" />
                    <span>16-Bit Swap</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSwap(4)}
                    className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
                  >
                    <ArrowLeftRight className="w-3.5 h-3.5 text-[#0a84ff]" />
                    <span>32-Bit Swap</span>
                  </button>
                </div>

                <div className="pt-2 border-t border-white/[0.065] space-y-2">
                  <div className="text-[11px] text-zinc-400">Extract Slice (Hex Range)</div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      value={sliceStartHex}
                      onChange={(e) => setSliceStartHex(e.target.value)}
                      className="px-2.5 py-1.5 rounded-md bg-[#0c0d10] border border-white/[0.08] text-xs font-mono tabular-nums text-zinc-100 focus:outline-none focus:border-[#0a84ff]"
                      placeholder="0x20000"
                    />
                    <input
                      type="text"
                      value={sliceEndHex}
                      onChange={(e) => setSliceEndHex(e.target.value)}
                      className="px-2.5 py-1.5 rounded-md bg-[#0c0d10] border border-white/[0.08] text-xs font-mono tabular-nums text-zinc-100 focus:outline-none focus:border-[#0a84ff]"
                      placeholder="0x30000"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleExtractSlice}
                    className="w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
                  >
                    <Scissors className="w-3.5 h-3.5 text-amber-400" />
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
      )}

      {/* TAB 2: DIAGNOSTICS & LINT */}
      {subTab === 'diagnostics' && (
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 flex items-center justify-between gap-4 flex-wrap shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div>
              <h2 className="text-sm font-semibold tracking-[-0.01em] text-white">
                Calibration Diagnostics &amp; Structural Lint
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Checks non-monotonic axes, &gt;3.5σ outlier spikes, clipped curves, dead 0xFF/0x00 maps, and forgotten twin maps.
              </p>
            </div>

            <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[#0c0d10] border border-white/[0.065]">
              {(
                [
                  { id: 'all', label: `All (${findings.length})` },
                  { id: 'error', label: `Errors (${diagCounts.error})` },
                  { id: 'warning', label: `Warnings (${diagCounts.warning})` },
                  { id: 'info', label: `Info (${diagCounts.info})` },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setDiagFilter(f.id)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                    diagFilter === f.id
                      ? 'bg-white/[0.1] text-white'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {!xdf ? (
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-12 text-center">
              <Stethoscope className="w-9 h-9 text-zinc-600 mx-auto mb-3" />
              <p className="text-sm font-semibold text-zinc-200">No XDF Definition Loaded</p>
              <p className="text-xs text-zinc-500 mt-1">
                Pass or load an XDF definition to lint calibration maps, axes, and twin structures.
              </p>
            </div>
          ) : visibleFindings.length === 0 ? (
            <div className="rounded-xl bg-[#17181d] border border-emerald-500/25 p-12 text-center">
              <CheckCircle2 className="w-9 h-9 text-emerald-400 mx-auto mb-3" />
              <p className="text-sm font-semibold text-emerald-200">
                {findings.length === 0
                  ? 'Clean Calibration — 0 Lint Findings'
                  : 'No findings match the selected severity filter'}
              </p>
              <p className="text-xs text-zinc-400 mt-1">
                Scanned {xdf.items.length} XDF items across {(bytes.length / 1024).toFixed(0)} KB flash.
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {visibleFindings.map((f) => (
                <div
                  key={f.id}
                  className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3.5 flex items-start justify-between gap-4 hover:border-white/[0.12] transition-colors"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div
                      className={`mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border ${
                        f.severity === 'error'
                          ? 'bg-rose-500/15 border-rose-500/35 text-rose-400'
                          : f.severity === 'warning'
                            ? 'bg-amber-500/15 border-amber-500/35 text-amber-400'
                            : 'bg-sky-500/15 border-sky-500/35 text-sky-400'
                      }`}
                    >
                      {f.severity === 'error' ? (
                        <AlertCircle className="w-4 h-4" />
                      ) : f.severity === 'warning' ? (
                        <AlertTriangle className="w-4 h-4" />
                      ) : (
                        <Info className="w-4 h-4" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${
                            f.severity === 'error'
                              ? 'bg-rose-500/15 text-rose-300'
                              : f.severity === 'warning'
                                ? 'bg-amber-500/15 text-amber-300'
                                : 'bg-sky-500/15 text-sky-300'
                          }`}
                        >
                          {f.category}
                        </span>
                        <span className="text-xs font-semibold text-zinc-100">{f.title}</span>
                      </div>
                      <p className="text-xs text-zinc-400 mt-1">{f.detail}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {f.itemId !== undefined && onSelectMap && (
                      <button
                        type="button"
                        onClick={() => onSelectMap(f.itemId!)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#0a84ff]/15 hover:bg-[#0a84ff]/25 text-[#5ac8fa] border border-[#0a84ff]/35 text-[11px] font-medium transition-colors cursor-pointer"
                      >
                        <Table2 className="w-3 h-3" />
                        <span>Open Map</span>
                      </button>
                    )}
                    {f.address !== undefined && onJumpToHex && (
                      <button
                        type="button"
                        onClick={() => onJumpToHex(f.address!)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200 border border-white/[0.08] text-[11px] font-medium transition-colors cursor-pointer"
                      >
                        <Binary className="w-3 h-3" />
                        <span>{formatHex(f.address)}</span>
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: SNAPSHOTS */}
      {subTab === 'snapshots' && (
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Save Snapshot Bar */}
          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 space-y-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div>
              <h2 className="text-sm font-semibold tracking-[-0.01em] text-white">
                Binary Checkpoints &amp; Snapshots
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Capture named in-memory checkpoints of the active BIN, compare byte deltas, and restore instantly.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5">
              <input
                type="text"
                value={snapshotName}
                onChange={(e) => setSnapshotName(e.target.value)}
                placeholder="Snapshot name (e.g. Stage 1 +2 deg timing)"
                className="md:col-span-5 px-3 py-2 rounded-lg bg-[#0c0d10] border border-white/[0.08] text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-[#0a84ff]"
              />
              <input
                type="text"
                value={snapshotNote}
                onChange={(e) => setSnapshotNote(e.target.value)}
                placeholder="Optional note..."
                className="md:col-span-4 px-3 py-2 rounded-lg bg-[#0c0d10] border border-white/[0.08] text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-[#0a84ff]"
              />
              <button
                type="button"
                onClick={handleSaveSnapshot}
                className="md:col-span-3 flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-semibold shadow-[0_2px_10px_rgba(10,132,255,0.3)] transition-colors cursor-pointer"
              >
                <Camera className="w-3.5 h-3.5" />
                <span>Save Snapshot</span>
              </button>
            </div>
          </div>

          {/* Saved Snapshots List */}
          {snapshots.length === 0 ? (
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-12 text-center">
              <History className="w-9 h-9 text-zinc-600 mx-auto mb-3" />
              <p className="text-sm font-semibold text-zinc-200">No snapshots saved yet</p>
              <p className="text-xs text-zinc-500 mt-1">
                Save a snapshot above before making aggressive fuel, boost, or ignition changes.
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {snapshots.map((snap) => {
                const diffVsCurrent =
                  snap.bytes.length === bytes.length ? countChangedBytes(bytes, snap.bytes) : -1;
                return (
                  <div
                    key={snap.id}
                    className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 flex items-center justify-between gap-4 flex-wrap hover:border-white/[0.12] transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <span className="text-xs font-semibold text-white">{snap.name}</span>
                        <span className="text-[11px] font-mono tabular-nums text-zinc-500">
                          {new Date(snap.createdAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </span>
                        {diffVsCurrent === 0 ? (
                          <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-[10.5px] font-medium text-emerald-300">
                            Matches Current BIN
                          </span>
                        ) : diffVsCurrent > 0 ? (
                          <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 font-mono tabular-nums text-[10.5px] text-amber-300">
                            Δ {diffVsCurrent.toLocaleString()} B vs current
                          </span>
                        ) : null}
                      </div>
                      <div className="text-[11px] text-zinc-400 mt-1 flex items-center gap-3">
                        <span className="font-mono tabular-nums">
                          {(snap.bytes.length / 1024).toFixed(0)} KB · {snap.changedBytes.toLocaleString()} B vs stock
                        </span>
                        {snap.note && <span className="text-zinc-500">· {snap.note}</span>}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleRestoreSnapshot(snap)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-[#0a84ff]/20 hover:text-[#5ac8fa] border border-white/[0.08] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Restore</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setSnapshots((prev) => prev.filter((s) => s.id !== snap.id))}
                        className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-rose-500/20 hover:text-rose-300 border border-white/[0.07] text-zinc-400 transition-colors cursor-pointer"
                        title="Delete Snapshot"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 4: EDIT HISTORY */}
      {subTab === 'history' && (
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Header & Actions */}
          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 flex items-center justify-between gap-4 flex-wrap shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div>
              <h2 className="text-sm font-semibold tracking-[-0.01em] text-white">
                Calibration Edit History &amp; Audit Timeline
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Every map tweak, recipe application, and checksum repair recorded in chronological order.
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder="Filter edits..."
                  className="pl-8 pr-3 py-1.5 rounded-lg bg-[#0c0d10] border border-white/[0.08] text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-[#0a84ff]"
                />
              </div>

              <button
                type="button"
                disabled={historyEntries.length === 0}
                onClick={handleExportHistoryCsv}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-35 border border-white/[0.08] text-xs font-medium text-zinc-200 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>CSV</span>
              </button>

              {onUndo && (
                <button
                  type="button"
                  disabled={historyEntries.length === 0}
                  onClick={onUndo}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] disabled:opacity-35 disabled:cursor-not-allowed text-white text-xs font-semibold shadow-[0_2px_10px_rgba(10,132,255,0.3)] cursor-pointer"
                >
                  <Undo2 className="w-3.5 h-3.5" />
                  <span>Undo Last Edit</span>
                </button>
              )}
            </div>
          </div>

          {/* 4 History KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                Logged Edits
              </div>
              <div className="mt-1.5 text-xl font-mono tabular-nums font-bold text-[#5ac8fa]">
                {historyEntries.length}
              </div>
            </div>
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                Cumulative Patched
              </div>
              <div className="mt-1.5 text-xl font-mono tabular-nums font-bold text-amber-400">
                {totalHistoryBytes.toLocaleString()} B
              </div>
            </div>
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                Net Delta vs Stock
              </div>
              <div className="mt-1.5 text-xl font-mono tabular-nums font-bold text-emerald-400">
                {modifiedBytes.toLocaleString()} B
              </div>
            </div>
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                Latest Action
              </div>
              <div className="mt-1.5 text-xs font-medium text-zinc-200 truncate">
                {historyEntries.length > 0
                  ? historyEntries[historyEntries.length - 1].label
                  : 'No edits yet'}
              </div>
            </div>
          </div>

          {/* Audit Timeline */}
          {filteredHistory.length === 0 ? (
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-12 text-center">
              <Clock className="w-9 h-9 text-zinc-600 mx-auto mb-3" />
              <p className="text-sm font-semibold text-zinc-200">
                {historyEntries.length === 0
                  ? 'No Calibration Edits Recorded Yet'
                  : 'No history entries match your filter'}
              </p>
              <p className="text-xs text-zinc-500 mt-1 max-w-md mx-auto">
                Edit cells in Map Editor, run a Tuning Recipe, or repair checksums to see the full undoable audit timeline here.
              </p>
            </div>
          ) : (
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 space-y-2.5">
              {filteredHistory.map(({ entry, stepNumber }, idx) => {
                const isLatest = stepNumber === historyEntries.length;
                return (
                  <div
                    key={`${stepNumber}-${entry.label}`}
                    className={`rounded-xl p-3.5 border flex items-center justify-between gap-4 transition-colors ${
                      isLatest
                        ? 'bg-[#0a84ff]/[0.08] border-[#0a84ff]/35'
                        : 'bg-[#0c0d10] border-white/[0.06]'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`w-7 h-7 rounded-full flex items-center justify-center font-mono text-[11px] font-bold shrink-0 ${
                          isLatest
                            ? 'bg-[#0a84ff] text-white'
                            : 'bg-white/[0.07] text-zinc-400'
                        }`}
                      >
                        #{stepNumber}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-semibold text-white truncate">
                            {entry.label}
                          </span>
                          {isLatest && (
                            <span className="px-1.5 py-0.5 rounded-full bg-[#0a84ff]/20 text-[#5ac8fa] text-[9.5px] font-semibold uppercase">
                              Latest
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] font-mono text-zinc-500 mt-0.5">
                          {entry.timestamp
                            ? new Date(entry.timestamp).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                              })
                            : `Session edit ${idx === 0 ? 'most recent' : ''}`}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2.5 shrink-0">
                      <span className="px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-500/30 font-mono tabular-nums text-[11px] font-semibold text-amber-300">
                        {entry.bytes.toLocaleString()} B
                      </span>
                      {isLatest && onUndo && (
                        <button
                          type="button"
                          onClick={onUndo}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-[11px] font-medium text-zinc-200 cursor-pointer"
                        >
                          <Undo2 className="w-3 h-3" />
                          <span>Undo</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 5: REPORT EXPORT */}
      {subTab === 'report' && (
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-5 flex items-center justify-between gap-4 flex-wrap shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex items-center gap-3.5">
              <div className="w-11 h-11 rounded-xl bg-[#0a84ff]/15 border border-[#0a84ff]/35 flex items-center justify-center shrink-0">
                <FileText className="w-5 h-5 text-[#5ac8fa]" />
              </div>
              <div>
                <h2 className="text-sm font-semibold tracking-[-0.01em] text-white">
                  Standalone HTML Calibration Tune Report
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Generates a self-contained dark-mode HTML dossier with ECU identity, modified scalars/flags, and interactive Tuned / Original / Delta heatmaps.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePreviewHtmlReport}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
              >
                <ExternalLink className="w-3.5 h-3.5 text-zinc-400" />
                <span>Preview in Tab</span>
              </button>
              <button
                type="button"
                onClick={handleDownloadHtmlReport}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-semibold shadow-[0_4px_16px_rgba(10,132,255,0.35)] transition-all cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>Download HTML Tune Report</span>
              </button>
            </div>
          </div>

          {/* Live Report Preview Summary */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                ECU Platform
              </div>
              <div className="mt-1.5 text-sm font-semibold text-white truncate">
                {reportSummary.ecu.ecuFamily}
              </div>
              <div className="mt-0.5 text-[11px] font-mono text-zinc-500 truncate">
                {reportSummary.ecu.architecture}
              </div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                Modified Maps
              </div>
              <div className="mt-1.5 text-xl font-mono tabular-nums font-bold text-[#5ac8fa]">
                {reportSummary.modifiedMaps}
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-500">
                {xdf ? `of ${xdf.items.length} XDF items` : 'No XDF loaded'}
              </div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                Binary Delta
              </div>
              <div className="mt-1.5 text-xl font-mono tabular-nums font-bold text-amber-400">
                {modifiedBytes.toLocaleString()} B
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-500">
                {reportSummary.clusterCount} diff cluster{reportSummary.clusterCount === 1 ? '' : 's'}
              </div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                Lint &amp; Checksums
              </div>
              <div className="mt-1.5 text-sm font-semibold text-zinc-100">
                {allValid ? (
                  <span className="text-emerald-400">Checksums Valid</span>
                ) : (
                  <span className="text-rose-400">{invalidFixableBlocks.length} Invalid Block(s)</span>
                )}
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-500">
                {findings.length} diagnostic finding{findings.length === 1 ? '' : 's'}
              </div>
            </div>
          </div>

          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 space-y-2 text-xs text-zinc-400">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
              Included in Export
            </div>
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-1.5 pt-1">
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>ECU identification header, SW/HW strings &amp; file metadata</span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>Modified constants &amp; bit-flags comparison table</span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>Interactive Tuned / Original / Delta thermal 2D map grids</span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>Zero external CDN dependencies — opens offline anywhere</span>
              </li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
};
