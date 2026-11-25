import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeftRight,
  Binary,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileText,
  History,
  Info,
  Layers,
  Lock,
  Pencil,
  Printer,
  RotateCcw,
  Scissors,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Sparkles,
  Stethoscope,
  Table2,
  Trash2,
  Undo2,
  Upload,
  Wrench,
} from 'lucide-react';
import {
  BinCodec,
  DiagnosticFinding,
  DiagnosticSeverity,
  Snapshot,
  XDFDefinition,
  computeCVN,
  correctCvnInPlace,
  countChangedBytes,
  countChangedCells,
  crc32,
  detectChecksumPlugin,
  diffClusters,
  findSyncBlocks,
  fixChecksums,
  generateHtmlReport,
  identifyECU,
  layoutByteRange,
  parseBinaryFile,
  runDiagnostics,
  scalingRawFor,
  scalingValue,
  verifyChecksums,
} from '@mactuner/core';
import { useI18n } from '../lib/i18n';

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
  triageStatus?: 'fixable' | 'tprot' | 'unchecked';
}

export type FlashToolPreset =
  | 'KESSv2 / KESS3'
  | 'Autotuner'
  | 'Flex'
  | 'KTAG / Bench (2 MB padded)'
  | 'PCMFlash'
  | 'CMDFlash / WinOLS'
  | 'MPPS';

const ALL_FLASH_PRESETS: readonly FlashToolPreset[] = [
  'KESSv2 / KESS3',
  'Autotuner',
  'Flex',
  'KTAG / Bench (2 MB padded)',
  'PCMFlash',
  'CMDFlash / WinOLS',
  'MPPS',
] as const;

const FLASH_PRESET_SHORT_LABELS: Record<FlashToolPreset, string> = {
  'KESSv2 / KESS3': 'KESS',
  Autotuner: 'Autotuner',
  Flex: 'Flex',
  'KTAG / Bench (2 MB padded)': 'KTAG 2MB',
  PCMFlash: 'PCMFlash',
  'CMDFlash / WinOLS': 'CMDFlash',
  MPPS: 'MPPS',
};

type FlashSubTab = 'preflight' | 'diagnostics' | 'snapshots' | 'history' | 'report';

export interface EditHistoryItem {
  label: string;
  bytes: number;
  timestamp?: number;
  note?: string;
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
  snapshots?: Snapshot[];
  onSaveSnapshot?: (name: string, note?: string) => void;
  onRestoreSnapshot?: (snapshot: Snapshot) => void;
  onDeleteSnapshot?: (id: string) => void;
  onSetCompareFromSnapshot?: (snapshot: Snapshot) => void;
  onAddSnapshotToMultiCompare?: (snapshot: Snapshot) => void;
  onUpdateHistoryNote?: (index: number, note: string) => void;
  onAutoFixDiagnostic?: (finding: DiagnosticFinding) => void;
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
  snapshots: propSnapshots,
  onSaveSnapshot,
  onRestoreSnapshot,
  onDeleteSnapshot,
  onSetCompareFromSnapshot,
  onAddSnapshotToMultiCompare,
  onUpdateHistoryNote,
  onAutoFixDiagnostic,
}) => {
  const { t } = useI18n();
  const [subTab, setSubTab] = useState<FlashSubTab>('preflight');
  const [preset, setPreset] = useState<FlashToolPreset>('KESSv2 / KESS3');
  const [correctBeforeExport, setCorrectBeforeExport] = useState(true);
  const [attachChangeList, setAttachChangeList] = useState(true);
  const [sliceStartHex, setSliceStartHex] = useState('0x20000');
  const [sliceEndHex, setSliceEndHex] = useState(
    `0x${Math.min(bytes.length, 0x30000).toString(16).toUpperCase()}`,
  );
  const [utilityNotice, setUtilityNotice] = useState<string | null>(null);

  // Padding & Inject Segment states
  const [padTargetSize, setPadTargetSize] = useState<number>(2_097_152);
  const [padFillByte, setPadFillByte] = useState<0xff | 0x00>(0xff);
  const [injectOffsetHex, setInjectOffsetHex] = useState<string>('0x20000');
  const injectInputRef = useRef<HTMLInputElement | null>(null);

  // CVN Recovery state
  const baselineCvnHex = useMemo(
    () => (baselineBytes ? computeCVN(baselineBytes).cvnHex : cvnHex),
    [baselineBytes, cvnHex],
  );
  const [targetCvnInput, setTargetCvnInput] = useState<string>(baselineCvnHex);

  // ECU Checksum Profile Selector state (11 ECU/TCU families)
  const detectedProfileId = useMemo(() => {
    const id = detectChecksumPlugin(bytes).id;
    return id === 'simos18' ? 'simos-18' : id;
  }, [bytes]);
  const [localProfileId, setLocalProfileId] = useState<string>(detectedProfileId);
  const prevDetectedProfileRef = useRef<string>(detectedProfileId);
  useEffect(() => {
    if (prevDetectedProfileRef.current !== detectedProfileId) {
      prevDetectedProfileRef.current = detectedProfileId;
      setLocalProfileId(detectedProfileId);
    }
  }, [detectedProfileId]);
  const normalizedPropProfile =
    selectedProfileId && selectedProfileId !== 'auto'
      ? selectedProfileId === 'simos18'
        ? 'simos-18'
        : selectedProfileId
      : undefined;
  const activeProfileId =
    normalizedPropProfile && ECU_CHECKSUM_PROFILES.some((p) => p.id === normalizedPropProfile)
      ? normalizedPropProfile
      : localProfileId;
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

  // Edit History filter & inline notes
  const [historySearch, setHistorySearch] = useState<string>('');
  const [localHistoryNotes, setLocalHistoryNotes] = useState<Record<number, string>>({});
  const [editingNoteIdx, setEditingNoteIdx] = useState<number | null>(null);
  const [editingNoteDraft, setEditingNoteDraft] = useState<string>('');

  // Diagnostics filter
  const [diagFilter, setDiagFilter] = useState<'all' | DiagnosticSeverity>('all');

  // Report copy feedback
  const [copiedMd, setCopiedMd] = useState(false);

  // Snapshots state (controlled if propSnapshots passed, else local)
  const [localSnapshots, setLocalSnapshots] = useState<Snapshot[]>(() =>
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
  const snapshots = propSnapshots ?? localSnapshots;
  const [snapshotName, setSnapshotName] = useState('');
  const [snapshotNote, setSnapshotNote] = useState('');
  const [cmpSnapA, setCmpSnapA] = useState<string>('');
  const [cmpSnapB, setCmpSnapB] = useState<string>('');

  const triageReport = useMemo(
    () => verifyChecksums(bytes, baselineBytes ?? undefined, activeProfileId),
    [bytes, baselineBytes, activeProfileId],
  );

  const invalidFixableBlocks = useMemo(
    () => blocks.filter((b) => !b.valid && !b.protected),
    [blocks],
  );
  const validBlocksCount = useMemo(
    () => blocks.filter((b) => b.valid).length,
    [blocks],
  );

  // Forgotten Twins (via findSyncBlocks)
  const forgottenTwins = useMemo(() => {
    if (!xdf || !baselineBytes) return [];
    const groups = findSyncBlocks(baselineBytes, xdf, 0.92);
    const out: Array<{
      groupId: string;
      editedItem: NonNullable<XDFDefinition['items'][number]>;
      untouchedItem: NonNullable<XDFDefinition['items'][number]>;
      similarity: number;
    }> = [];
    const byId = new Map(xdf.items.map((it) => [it.id, it]));
    for (const g of groups) {
      const members = g.itemIds.map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => Boolean(x));
      const edited = members.filter((m) => countChangedCells(m, bytes, baselineBytes) > 0);
      const untouched = members.filter((m) => countChangedCells(m, bytes, baselineBytes) === 0);
      if (edited.length > 0 && untouched.length > 0) {
        for (const u of untouched) {
          out.push({
            groupId: `${g.id}-${u.id}`,
            editedItem: edited[0],
            untouchedItem: u,
            similarity: g.similarity,
          });
        }
      }
    }
    return out;
  }, [xdf, bytes, baselineBytes]);

  // Physics Invariants (Boost / Lambda / Timing / Torque cross-checks)
  const physicsInvariants = useMemo(() => {
    if (!xdf) return [];
    const checks: Array<{
      id: string;
      label: string;
      status: 'ok' | 'warn';
      detail: string;
      itemId: number;
    }> = [];

    for (const item of xdf.items) {
      const [lo, hi] = layoutByteRange(item.data);
      if (lo < 0 || hi > bytes.length) continue;
      const t = item.title.toLowerCase();
      let minV = Infinity;
      let maxV = -Infinity;
      for (let r = 0; r < item.data.rows; r++) {
        for (let c = 0; c < item.data.cols; c++) {
          const raw = BinCodec.raw(item.data, { r, c }, bytes);
          if (raw === null) continue;
          const v = scalingValue(item.scaling, raw);
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
      }
      if (!Number.isFinite(minV)) continue;

      if (/boost|ldrxn|ladedruck|charge pressure/.test(t)) {
        const isMbar = /mbar|hpa/i.test(item.scaling.units) || maxV > 500;
        const limit = isMbar ? 3400 : 2.4;
        checks.push({
          id: `phys-boost-${item.id}`,
          label: `Boost Envelope (${item.title})`,
          status: maxV > limit ? 'warn' : 'ok',
          detail:
            maxV > limit
              ? `Peak ${maxV.toFixed(1)} ${item.scaling.units} exceeds safe stock turbo threshold (${limit})`
              : `Peak ${maxV.toFixed(1)} ${item.scaling.units} within safe envelope`,
          itemId: item.id,
        });
      } else if (/lambda|lamfa/.test(t)) {
        const lean = minV > 0.9;
        checks.push({
          id: `phys-lambda-${item.id}`,
          label: `WOT Lambda Safety (${item.title})`,
          status: lean ? 'warn' : 'ok',
          detail: lean
            ? `Minimum target λ = ${minV.toFixed(3)} (> 0.90 — lean under WOT risk)`
            : `Target λ range [${minV.toFixed(3)} .. ${maxV.toFixed(3)}] safe`,
          itemId: item.id,
        });
      } else if (/ignition|kfzw|timing/.test(t)) {
        const high = maxV > 42;
        checks.push({
          id: `phys-ign-${item.id}`,
          label: `Ignition Advance (${item.title})`,
          status: high ? 'warn' : 'ok',
          detail: high
            ? `Max advance ${maxV.toFixed(1)}° exceeds 42°BTDC — verify knock margin`
            : `Advance range [${minV.toFixed(1)}° .. ${maxV.toFixed(1)}°] plausible`,
          itemId: item.id,
        });
      } else if (/torque|moment|drehmoment/.test(t)) {
        const high = maxV > 1200;
        checks.push({
          id: `phys-trq-${item.id}`,
          label: `Torque Ceiling (${item.title})`,
          status: high ? 'warn' : 'ok',
          detail: high
            ? `Peak ${maxV.toFixed(0)} ${item.scaling.units} unusually high — check scaling`
            : `Range [${minV.toFixed(0)} .. ${maxV.toFixed(0)} ${item.scaling.units}]`,
          itemId: item.id,
        });
      }
    }
    return checks.slice(0, 8);
  }, [xdf, bytes]);

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

  // FIX STALE-BYTES EXPORT BUG: compute fixed bytes synchronously before downloading!
  const handleExportBin = () => {
    let exportBytes: Uint8Array = new Uint8Array(bytes);
    let fixedNotice = '';

    if (correctBeforeExport && invalidFixableBlocks.length > 0) {
      const fixed = fixChecksums(exportBytes, activeProfileId);
      if (fixed.fixedCount > 0) {
        exportBytes = fixed.bytes;
        fixedNotice = ` (checksum-corrected: ${fixed.fixedCount} block${fixed.fixedCount === 1 ? '' : 's'})`;
        if (onReplaceBytes) {
          onReplaceBytes(fixed.bytes, `Pre-Export Checksum Fix (${fixed.fixedCount})`);
        } else {
          onFixChecksums();
        }
      } else {
        onFixChecksums();
      }
    }

    if (preset === 'KTAG / Bench (2 MB padded)' && exportBytes.length < 2_097_152) {
      const padded = new Uint8Array(2_097_152);
      padded.fill(0xff);
      padded.set(exportBytes, 0);
      exportBytes = padded;
    }

    const baseName = fileName.replace(/\.bin$/i, '');
    const presetSlug = preset.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const outBinName = `${baseName}_${presetSlug}.bin`;
    triggerDownload(exportBytes, outBinName, 'application/octet-stream');

    if (attachChangeList) {
      const lines = [
        `MacTuner Flash Preflight Change List`,
        `Export Preset: ${preset}`,
        `File: ${outBinName}`,
        `Size: ${exportBytes.length} bytes`,
        `Modified Bytes: ${modifiedBytes}`,
        `CVN: ${cvnHex}`,
        `Checksum Blocks: ${validBlocksCount}/${blocks.length} valid${fixedNotice}`,
        '',
        'Blocks:',
        ...blocks.map(
          (b) =>
            `  - ${b.name} (${b.algorithm}) ${formatHex(b.start)}-${formatHex(b.end)} | Stored: ${b.actualHex} | Expected: ${b.expectedHex} | ${b.valid ? 'OK' : 'FIXED'}`,
        ),
      ];
      triggerDownload(lines.join('\n'), `${baseName}_changes.txt`, 'text/plain;charset=utf-8');
    }
    setUtilityNotice(`Exported ${outBinName}${fixedNotice}${attachChangeList ? ' + change list (.txt)' : ''}.`);
  };

  const handleAutoDetectProfile = () => {
    const detected = detectChecksumPlugin(bytes);
    const mappedId = detected.id === 'simos18' ? 'simos-18' : detected.id;
    setLocalProfileId(mappedId);
    onSelectProfile?.(detected.id);
    setUtilityNotice(`Auto-detected ECU profile: ${detected.name}.`);
  };

  const handleFixCvnInPlace = () => {
    const res = correctCvnInPlace(bytes, targetCvnInput, activeProfileId);
    if (!res.ok) {
      setUtilityNotice(`CVN recovery failed for target 0x${targetCvnInput.replace(/^0x/i, '')}. Check 8-digit hex input.`);
      return;
    }
    if (onReplaceBytes) {
      onReplaceBytes(
        res.bytes,
        `CVN Recovery → 0x${res.achievedCvn} @ ${formatHex(res.patchedAddress)}`,
      );
      setUtilityNotice(`CVN restored to 0x${res.achievedCvn} (patched 4B @ ${formatHex(res.patchedAddress)}).`);
    } else {
      triggerDownload(res.bytes, `${fileName.replace(/\.bin$/i, '')}_cvn_${res.achievedCvn}.bin`);
      setUtilityNotice(`Downloaded CVN-matched binary (0x${res.achievedCvn}).`);
    }
  };

  const handleCopyToTwin = (
    editedItem: XDFDefinition['items'][number],
    untouchedItem: XDFDefinition['items'][number],
  ) => {
    const [srcLo, srcHi] = layoutByteRange(editedItem.data);
    const [dstLo, dstHi] = layoutByteRange(untouchedItem.data);
    const len = srcHi - srcLo;
    if (len <= 0 || srcHi > bytes.length || dstHi > bytes.length || dstHi - dstLo !== len) return;
    const next = new Uint8Array(bytes);
    next.set(bytes.slice(srcLo, srcHi), dstLo);
    if (onReplaceBytes) {
      onReplaceBytes(next, `Copy Twin: ${editedItem.title} → ${untouchedItem.title}`);
      setUtilityNotice(`Copied ${len} B from "${editedItem.title}" to twin "${untouchedItem.title}".`);
    }
  };

  const handlePadBinary = () => {
    if (padTargetSize <= bytes.length) {
      setUtilityNotice(`Binary is already ${(bytes.length / 1024).toFixed(0)} KB (≥ target ${(padTargetSize / 1024).toFixed(0)} KB).`);
      return;
    }
    const padded = new Uint8Array(padTargetSize);
    padded.fill(padFillByte);
    padded.set(bytes, 0);
    const label = `Pad BIN to ${(padTargetSize / 1024).toFixed(0)} KB (0x${padFillByte.toString(16).toUpperCase().padStart(2, '0')})`;
    if (onReplaceBytes) {
      onReplaceBytes(padded, label);
      setUtilityNotice(`Padded active BIN to ${(padTargetSize / 1024).toFixed(0)} KB with 0x${padFillByte.toString(16).toUpperCase().padStart(2, '0')}.`);
    } else {
      triggerDownload(padded, `${fileName.replace(/\.bin$/i, '')}_${Math.round(padTargetSize / 1024)}KB.bin`);
    }
  };

  const handleInjectSegment = async (file: File) => {
    const off = parseHexOrDec(injectOffsetHex);
    const raw = new Uint8Array(await file.arrayBuffer());
    const seg = parseBinaryFile(file.name, raw);
    if (!Number.isFinite(off) || off < 0 || off + seg.length > bytes.length) {
      setUtilityNotice(
        `Inject failed: ${file.name} (${seg.length} B) at ${injectOffsetHex} exceeds binary length (${formatHex(bytes.length)}).`,
      );
      return;
    }
    const next = new Uint8Array(bytes);
    next.set(seg, off);
    if (onReplaceBytes) {
      onReplaceBytes(next, `Inject ${file.name} (${seg.length} B) @ ${formatHex(off)}`);
      setUtilityNotice(`Injected ${seg.length.toLocaleString()} B from ${file.name} at ${formatHex(off)}.`);
    } else {
      triggerDownload(next, `${fileName.replace(/\.bin$/i, '')}_injected.bin`);
    }
  };

  const handleAutoFixFinding = (f: DiagnosticFinding) => {
    const item = xdf && f.itemId !== undefined ? xdf.items.find((it) => it.id === f.itemId) : undefined;

    if (item && onReplaceBytes && f.category === 'Forgotten Twin' && f.address !== undefined) {
      const [srcLo, srcHi] = layoutByteRange(item.data);
      const len = srcHi - srcLo;
      if (len > 0 && f.address + len <= bytes.length) {
        const next = new Uint8Array(bytes);
        next.set(bytes.slice(srcLo, srcHi), f.address);
        onReplaceBytes(next, `Auto-Fix Forgotten Twin @ ${formatHex(f.address)}`);
        setUtilityNotice(`Synced forgotten twin at ${formatHex(f.address)}.`);
        return;
      }
    }

    if (item && onReplaceBytes && f.category === 'Outlier Spike' && item.itemKind.kind === 'table') {
      const l = item.data;
      const next = new Uint8Array(bytes);
      let fixed = 0;
      for (let r = 1; r < l.rows - 1; r++) {
        for (let c = 1; c < l.cols - 1; c++) {
          const curRaw = BinCodec.raw(l, { r, c }, bytes);
          if (curRaw === null) continue;
          const cur = scalingValue(item.scaling, curRaw);
          const nVals = [
            BinCodec.raw(l, { r: r - 1, c }, bytes),
            BinCodec.raw(l, { r: r + 1, c }, bytes),
            BinCodec.raw(l, { r, c: c - 1 }, bytes),
            BinCodec.raw(l, { r, c: c + 1 }, bytes),
          ]
            .filter((v): v is number => v !== null)
            .map((v) => scalingValue(item.scaling, v));
          if (nVals.length < 4) continue;
          const avg = nVals.reduce((a, b) => a + b, 0) / nVals.length;
          const sd = Math.sqrt(nVals.reduce((a, b) => a + (b - avg) ** 2, 0) / nVals.length);
          if (Math.abs(cur - avg) > Math.max(sd * 3.5, Math.abs(avg) * 0.25)) {
            const newRaw = scalingRawFor(item.scaling, avg, l);
            if (newRaw !== null) {
              const enc = BinCodec.encode(l, newRaw);
              const off =
                l.address +
                (l.columnMajor ? c * l.rows + r : r * l.cols + c) * Math.max(1, Math.floor(l.bits / 8));
              if (off >= 0 && off + enc.length <= next.length) {
                next.set(enc, off);
                fixed++;
              }
            }
          }
        }
      }
      if (fixed > 0) {
        onReplaceBytes(next, `Auto-Fix ${fixed} Outlier Spike(s) in ${item.title}`);
        setUtilityNotice(`Smoothed ${fixed} outlier spike cell(s) in ${item.title}.`);
        return;
      }
    }

    if (onAutoFixDiagnostic) {
      onAutoFixDiagnostic(f);
    }
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

  const handleSaveSnapshot = (overrideName?: string, overrideNote?: string) => {
    const name = (overrideName ?? snapshotName).trim() || `Snapshot ${snapshots.length + 1}`;
    const note = (overrideNote ?? snapshotNote).trim() || undefined;
    if (onSaveSnapshot) {
      onSaveSnapshot(name, note);
    } else {
      const nextSnap: Snapshot = {
        id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        createdAt: Date.now(),
        changedBytes: modifiedBytes,
        bytes: bytes.slice(),
        note,
      };
      setLocalSnapshots((prev) => [nextSnap, ...prev]);
    }
    if (!overrideName) {
      setSnapshotName('');
      setSnapshotNote('');
    }
  };

  const handleRestoreSnapshot = (snap: Snapshot) => {
    if (onRestoreSnapshot) {
      onRestoreSnapshot(snap);
      setUtilityNotice(`Restored "${snap.name}" into active BIN buffer.`);
    } else if (onReplaceBytes) {
      onReplaceBytes(snap.bytes.slice(), `Restored snapshot: ${snap.name}`);
      setUtilityNotice(`Restored "${snap.name}" into active BIN buffer.`);
    } else {
      triggerDownload(
        snap.bytes,
        `${snap.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.bin`,
      );
    }
  };

  const handleDeleteSnapshot = (id: string) => {
    if (onDeleteSnapshot) onDeleteSnapshot(id);
    else setLocalSnapshots((prev) => prev.filter((s) => s.id !== id));
  };

  const snapshotComparison = useMemo(() => {
    if (!cmpSnapA || !cmpSnapB || cmpSnapA === cmpSnapB) return null;
    const a = snapshots.find((s) => s.id === cmpSnapA);
    const b = snapshots.find((s) => s.id === cmpSnapB);
    if (!a || !b) return null;
    const diffB = countChangedBytes(a.bytes, b.bytes);
    const clusters = diffClusters(a.bytes, b.bytes, 16);
    return { a, b, diffB, clusterCount: clusters.length };
  }, [cmpSnapA, cmpSnapB, snapshots]);

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

  const handlePrintPdfReport = () => {
    const html = generateHtmlReport(fileName, compareName, bytes, baselineBytes, xdf ?? null);
    const win = window.open('', '_blank');
    if (win) {
      win.document.write(html);
      win.document.close();
      win.focus();
      window.setTimeout(() => win.print(), 250);
    }
  };

  const handleDownloadTxtChangelog = () => {
    const lines = [
      `MacTuner Calibration Changelog`,
      `File: ${fileName} (${Math.round(bytes.length / 1024)} KB) vs ${compareName}`,
      `ECU: ${reportSummary.ecu.ecuFamily} (${reportSummary.ecu.architecture})`,
      `Modified Maps: ${reportSummary.modifiedMaps} | Modified Bytes: ${modifiedBytes} B | Clusters: ${reportSummary.clusterCount}`,
      `Checksums: ${allValid ? `OK (${validBlocksCount}/${blocks.length})` : `${invalidFixableBlocks.length} invalid`}`,
      '',
      ...(xdf && baselineBytes
        ? xdf.items
            .filter((it) => countChangedCells(it, bytes, baselineBytes) > 0)
            .map(
              (it) =>
                `  - ${it.title} [${formatHex(it.data.address)}]: ${countChangedCells(it, bytes, baselineBytes)}/${it.data.rows * it.data.cols} cells changed`,
            )
        : []),
    ];
    triggerDownload(
      lines.join('\n'),
      `${fileName.replace(/\.bin$/i, '')}_changelog.txt`,
      'text/plain;charset=utf-8',
    );
    setUtilityNotice('Downloaded TXT changelog.');
  };

  const handleCopyMarkdownReport = () => {
    const rows =
      xdf && baselineBytes
        ? xdf.items
            .filter((it) => countChangedCells(it, bytes, baselineBytes) > 0)
            .map(
              (it) =>
                `| ${it.title} | \`${formatHex(it.data.address)}\` | ${countChangedCells(it, bytes, baselineBytes)}/${it.data.rows * it.data.cols} |`,
            )
        : [];
    const md = [
      `# MacTuner Tune Report — \`${fileName}\``,
      `- **ECU:** ${reportSummary.ecu.ecuFamily} (${reportSummary.ecu.architecture})`,
      `- **Modified:** ${reportSummary.modifiedMaps} maps · ${modifiedBytes.toLocaleString()} B · ${reportSummary.clusterCount} clusters`,
      `- **Checksums:** ${allValid ? 'Valid' : `${invalidFixableBlocks.length} invalid`}`,
      '',
      '| Map | Address | Changed Cells |',
      '| --- | --- | --- |',
      ...rows,
    ].join('\n');
    void navigator.clipboard?.writeText(md);
    setCopiedMd(true);
    window.setTimeout(() => setCopiedMd(false), 1800);
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
                label: t('Preflight & Checksums'),
                icon: <ShieldCheck className="w-3.5 h-3.5" />,
                badge: invalidFixableBlocks.length > 0 ? invalidFixableBlocks.length : null,
                badgeTone: 'rose',
              },
              {
                id: 'diagnostics',
                label: t('Diagnostics & Lint'),
                icon: <Stethoscope className="w-3.5 h-3.5" />,
                badge: findings.length > 0 ? findings.length : null,
                badgeTone: diagCounts.error > 0 ? 'rose' : 'amber',
              },
              {
                id: 'snapshots',
                label: t('Snapshots'),
                icon: <History className="w-3.5 h-3.5" />,
                badge: snapshots.length > 0 ? snapshots.length : null,
                badgeTone: 'zinc',
              },
              {
                id: 'history',
                label: t('Edit History'),
                icon: <Clock className="w-3.5 h-3.5" />,
                badge: historyEntries.length > 0 ? historyEntries.length : null,
                badgeTone: 'zinc',
              },
              {
                id: 'report',
                label: t('Report Export'),
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
                    {t('Blocker found — do not flash without fixing!')}
                  </h2>
                  <p className="text-xs text-rose-200/75 mt-0.5">
                    {t('%lld checksum block(s) out of sync after calibration edits. Flashing an uncorrected binary can brick the ECU.', invalidFixableBlocks.length)}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onFixChecksums}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-bold shadow-[0_4px_18px_rgba(10,132,255,0.4)] transition-all cursor-pointer"
              >
                <Wrench className="w-4 h-4" />
                <span>{t('Fix Checksums (%lld)', invalidFixableBlocks.length)}</span>
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
                    {t('Ready to Flash — All checksum blocks valid')}
                  </h2>
                  <p className="text-xs text-emerald-200/75 mt-0.5">
                    {t('All %lld checksum blocks valid.', validBlocksCount)} {t('Safe to export for %@.', preset)}
                  </p>
                </div>
              </div>
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/20 border border-emerald-500/35 text-emerald-300 text-xs font-semibold">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {t('Preflight Passed')}
              </span>
            </div>
          )}

          {/* 4 KPI Tiles */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('Checksum Blocks')}
              </div>
              <div className="mt-2 text-xl font-mono tabular-nums font-bold text-white">
                <span className={allValid ? 'text-emerald-400' : 'text-rose-400'}>
                  {validBlocksCount}
                </span>
                <span className="text-zinc-500"> / {blocks.length}</span>
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-500">
                {invalidFixableBlocks.length === 0
                  ? t('All regions verified')
                  : `${invalidFixableBlocks.length} ${t('fixable mismatch')}`}
              </div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('CVN / COMPTEST')}
              </div>
              <div className="mt-2 text-xl font-mono tabular-nums font-bold text-[#5ac8fa]">
                0x{cvnHex}
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  type="text"
                  value={targetCvnInput}
                  onChange={(e) => setTargetCvnInput(e.target.value)}
                  placeholder={t('Target CVN')}
                  className="min-w-0 flex-1 w-20 px-1.5 py-0.5 rounded bg-[#0c0d10] border border-white/[0.08] font-mono text-[10.5px] text-zinc-200 focus:outline-none focus:border-[#0a84ff]"
                />
                <button
                  type="button"
                  onClick={handleFixCvnInPlace}
                  className="px-2 py-0.5 rounded bg-[#0a84ff]/20 hover:bg-[#0a84ff]/35 border border-[#0a84ff]/40 text-[10px] font-semibold text-[#5ac8fa] whitespace-nowrap shrink-0 cursor-pointer"
                  title={t('In-place GF(2) CVN recovery')}
                >
                  {t('Fix CVN In-Place')}
                </button>
              </div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('TPROT / 3-Way Triage')}
              </div>
              <div className="mt-2 text-xl font-mono tabular-nums font-bold text-zinc-200 flex items-center gap-2">
                <Lock className="w-4 h-4 text-indigo-400" />
                <span>{tprotProtectedCount}</span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 flex-wrap text-[10px] font-mono">
                <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">
                  {invalidFixableBlocks.length} {t('Fixable')}
                </span>
                <span className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">
                  {tprotProtectedCount} TPROT
                </span>
                <span className="px-1.5 py-0.5 rounded bg-zinc-500/15 text-zinc-400">
                  {triageReport.uncheckedBytes}B {t('Unchecked')}
                </span>
              </div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('Modified Bytes')}
              </div>
              <div className="mt-2 text-xl font-mono tabular-nums font-bold text-amber-400">
                {modifiedBytes.toLocaleString()} B
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-500">{t('Delta vs stock baseline')}</div>
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
                  {t('ECU / TCU Checksum Profile')}
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

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleAutoDetectProfile}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#0a84ff]/15 hover:bg-[#0a84ff]/25 border border-[#0a84ff]/35 text-[11px] font-semibold text-[#5ac8fa] cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>{t('Auto-Detect')}</span>
              </button>
              <label className="text-[11px] text-zinc-400" htmlFor="ecu-profile-select">
                {t('Profile')}
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
                  {t('Checksum Blocks')}
                </h3>
                {invalidFixableBlocks.length > 0 && (
                  <button
                    type="button"
                    onClick={onFixChecksums}
                    className="text-xs font-semibold text-[#5ac8fa] hover:text-white transition-colors cursor-pointer"
                  >
                    {t('Fix All')} ({invalidFixableBlocks.length})
                  </button>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/[0.065] bg-white/[0.02] text-[10.5px] uppercase tracking-wider text-zinc-500">
                      <th className="py-2.5 px-3.5 font-semibold">{t('Block')}</th>
                      <th className="py-2.5 px-3.5 font-semibold">{t('Algo')}</th>
                      <th className="py-2.5 px-3.5 font-semibold whitespace-nowrap">{t('Address Range')}</th>
                      <th className="py-2.5 px-3.5 font-semibold whitespace-nowrap">{t('Expected / Actual')}</th>
                      <th className="py-2.5 px-3.5 font-semibold text-right whitespace-nowrap">{t('Status')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.05] text-xs">
                    {blocks.map((blk) => (
                      <tr key={blk.id} className="hover:bg-white/[0.025] transition-colors">
                        <td className="py-2.5 px-3.5 font-medium text-zinc-100">{blk.name}</td>
                        <td className="py-2.5 px-3.5 font-mono text-[11px] text-zinc-400">
                          {blk.algorithm}
                        </td>
                        <td className="py-2.5 px-3.5 font-mono tabular-nums text-zinc-300 whitespace-nowrap">
                          {formatHex(blk.start)}–{formatHex(blk.end)}
                        </td>
                        <td className="py-2.5 px-3.5 font-mono tabular-nums text-[11px] whitespace-nowrap">
                          <div className="text-emerald-400 whitespace-nowrap">Exp: {blk.expectedHex}</div>
                          <div className={`whitespace-nowrap ${blk.valid ? 'text-zinc-400' : 'text-rose-400'}`}>
                            Act: {blk.actualHex}
                          </div>
                        </td>
                        <td className="py-2.5 px-3.5 text-right">
                          {blk.protected || blk.triageStatus === 'tprot' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 text-[11px] font-medium">
                              <Lock className="w-3 h-3" /> {t('TPROT-Protected')}
                            </span>
                          ) : blk.triageStatus === 'unchecked' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-zinc-500/15 text-zinc-300 border border-zinc-500/30 text-[11px] font-medium">
                              {t('Unchecked')}
                            </span>
                          ) : blk.valid ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-[11px] font-semibold">
                              <CheckCircle2 className="w-3 h-3" /> {t('OK')}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[11px] font-semibold">
                              <AlertTriangle className="w-3 h-3" /> {t('Fixable')}
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
                      {t('Manual Range Patcher')}
                    </span>
                    <span className="px-2 py-0.5 rounded-full bg-white/[0.05] font-mono text-[10px] text-zinc-400">
                      CRC32 GF(2) / ADD32 / ADD16
                    </span>
                  </div>
                  <span className="text-[11px] text-zinc-500">
                    {patcherOpen ? t('Hide') : t('Expand')}
                  </span>
                </button>

                {patcherOpen && (
                  <div className="px-4 pb-4 pt-2 border-t border-white/[0.065] space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <div>
                        <label className="block text-[10.5px] text-zinc-400 mb-1">{t('Algorithm')}</label>
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
                        <label className="block text-[10.5px] text-zinc-400 mb-1">{t('Byte Order')}</label>
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
                            {t('Little-Endian')}
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
                            {t('Big-Endian')}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="block text-[10.5px] text-zinc-400 mb-1">
                          {t('Range Start (Hex)')}
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
                          {t('Range End (Hex)')}
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
                          {t('Store Address (Hex)')}
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
                            <span className="text-zinc-500">{t('Computed:')} </span>
                            <span className="text-emerald-400 font-semibold">
                              0x{manualPatchPreview.computedHex}
                            </span>
                          </div>
                          <div>
                            <span className="text-zinc-500">{t('Stored')} @ {formatHex(manualPatchPreview.store)}: </span>
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
                          <span>{t('Patch Store Address')}</span>
                        </button>
                      </div>
                    ) : (
                      <div className="text-[11px] text-rose-400 bg-rose-500/10 border border-rose-500/25 rounded-lg px-3 py-2">
                        {t('Invalid hex range or store offset exceeds binary length (0x%@).', bytes.length.toString(16).toUpperCase())}
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
                  {t('Flash-Tool Export')}
                </h3>

                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1.5">
                    {t('Flash Tool Preset')}
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {ALL_FLASH_PRESETS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setPreset(p)}
                        className={`py-1.5 px-2.5 rounded-lg text-[10.5px] font-medium border transition-all cursor-pointer whitespace-nowrap ${
                          preset === p
                            ? 'bg-[#0a84ff]/20 border-[#0a84ff]/55 text-white'
                            : 'bg-[#0c0d10] border-white/[0.07] text-zinc-400 hover:text-zinc-200'
                        }`}
                        title={p}
                      >
                        {FLASH_PRESET_SHORT_LABELS[p]}
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
                    <span>{t('Correct Checksum Before Export')}</span>
                  </label>

                  <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={attachChangeList}
                      onChange={(e) => setAttachChangeList(e.target.checked)}
                      className="accent-[#0a84ff]"
                    />
                    <span>{t('Attach Change List (.txt)')}</span>
                  </label>
                </div>

                <button
                  type="button"
                  onClick={handleExportBin}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-bold shadow-[0_4px_16px_rgba(10,132,255,0.35)] transition-all cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>{t('Export & Download .bin')}</span>
                </button>
              </div>

              {/* BIN Utilities Card */}
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 space-y-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                  {t('BIN Utilities')}
                </h3>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => handleSwap(2)}
                    className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
                  >
                    <ArrowLeftRight className="w-3.5 h-3.5 text-[#0a84ff]" />
                    <span>{t('16-Bit Swap')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSwap(4)}
                    className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
                  >
                    <ArrowLeftRight className="w-3.5 h-3.5 text-[#0a84ff]" />
                    <span>{t('32-Bit Swap')}</span>
                  </button>
                </div>

                <div className="pt-2 border-t border-white/[0.065] space-y-2">
                  <div className="text-[11px] text-zinc-400">{t('Extract Slice (Hex Range)')}</div>
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
                    <span>{t('Extract Slice')}</span>
                  </button>
                </div>

                {/* Padding Utility */}
                <div className="pt-2 border-t border-white/[0.065] space-y-2">
                  <div className="text-[11px] text-zinc-400">{t('Pad Binary to Target Size')}</div>
                  <div className="grid grid-cols-3 gap-2">
                    <select
                      value={padTargetSize}
                      onChange={(e) => setPadTargetSize(Number(e.target.value))}
                      className="col-span-2 px-2 py-1.5 rounded-md bg-[#0c0d10] border border-white/[0.08] text-xs font-mono text-zinc-100"
                    >
                      <option value={524_288}>512 KB</option>
                      <option value={1_048_576}>1 MB</option>
                      <option value={2_097_152}>2 MB</option>
                      <option value={4_194_304}>4 MB</option>
                    </select>
                    <select
                      value={padFillByte}
                      onChange={(e) => setPadFillByte(Number(e.target.value) as 0xff | 0x00)}
                      className="px-2 py-1.5 rounded-md bg-[#0c0d10] border border-white/[0.08] text-xs font-mono text-zinc-100"
                    >
                      <option value={0xff}>0xFF</option>
                      <option value={0x00}>0x00</option>
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={handlePadBinary}
                    className="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 cursor-pointer"
                  >
                    <Layers className="w-3.5 h-3.5 text-indigo-400" />
                    <span>{t('Pad Binary')}</span>
                  </button>
                </div>

                {/* Inject Segment at 0x... */}
                <div className="pt-2 border-t border-white/[0.065] space-y-2">
                  <input
                    ref={injectInputRef}
                    type="file"
                    accept=".bin,.ori,.mod"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleInjectSegment(f);
                      e.target.value = '';
                    }}
                  />
                  <div className="text-[11px] text-zinc-400">{t('Inject Segment at Offset')}</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={injectOffsetHex}
                      onChange={(e) => setInjectOffsetHex(e.target.value)}
                      className="w-28 px-2.5 py-1.5 rounded-md bg-[#0c0d10] border border-white/[0.08] text-xs font-mono text-zinc-100"
                      placeholder="0x20000"
                    />
                    <button
                      type="button"
                      onClick={() => injectInputRef.current?.click()}
                      className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 cursor-pointer"
                    >
                      <Upload className="w-3.5 h-3.5 text-[#5ac8fa]" />
                      <span>{t('Inject .bin at')} {injectOffsetHex}</span>
                    </button>
                  </div>
                </div>

                {utilityNotice && (
                  <div className="text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 rounded-lg px-2.5 py-1.5">
                    {utilityNotice}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Forgotten Twins & Physics Invariants Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Forgotten Twins Card */}
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="px-4 py-3 border-b border-white/[0.065] flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                  {t('Forgotten Twins')} ({t('Sync Blocks')})
                </h3>
                <span className="text-[11px] font-mono text-amber-300">
                  {forgottenTwins.length} {t('found')}
                </span>
              </div>
              {forgottenTwins.length === 0 ? (
                <div className="p-5 text-xs text-zinc-500 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>{t('All parallel / twin calibration maps are in sync.')}</span>
                </div>
              ) : (
                <div className="divide-y divide-white/[0.05]">
                  {forgottenTwins.map((tw) => (
                    <div
                      key={tw.groupId}
                      className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-zinc-100 truncate">
                          {tw.editedItem.title} → <span className="text-amber-300">{tw.untouchedItem.title}</span>
                        </div>
                        <div className="text-[10.5px] font-mono text-zinc-500">
                          {Math.round(tw.similarity * 100)}% {t('twin · untouched')} @ {formatHex(tw.untouchedItem.data.address)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleCopyToTwin(tw.editedItem, tw.untouchedItem)}
                        className="px-2.5 py-1 rounded-md bg-[#0a84ff]/15 hover:bg-[#0a84ff]/30 border border-[#0a84ff]/35 text-[#5ac8fa] text-[11px] font-semibold shrink-0 cursor-pointer"
                      >
                        {t('Copy to Twin')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Physics Invariants Card */}
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="px-4 py-3 border-b border-white/[0.065] flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                  {t('Physics Invariants')}
                </h3>
                <span className="text-[11px] font-mono text-zinc-400">
                  {physicsInvariants.length} {t('checks')}
                </span>
              </div>
              {physicsInvariants.length === 0 ? (
                <div className="p-5 text-xs text-zinc-500">
                  {t('Load an XDF with boost, lambda, timing, or torque maps to verify physical safety envelopes.')}
                </div>
              ) : (
                <div className="divide-y divide-white/[0.05]">
                  {physicsInvariants.map((chk) => (
                    <div
                      key={chk.id}
                      className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="flex items-start gap-2 min-w-0">
                        {chk.status === 'ok' ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
                        ) : (
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="font-medium text-zinc-100 truncate">{chk.label}</div>
                          <div className="text-[10.5px] text-zinc-400 truncate">{chk.detail}</div>
                        </div>
                      </div>
                      {onSelectMap && (
                        <button
                          type="button"
                          onClick={() => onSelectMap(chk.itemId)}
                          className="px-2 py-1 rounded-md bg-white/[0.05] hover:bg-[#0a84ff]/20 text-zinc-200 hover:text-[#5ac8fa] border border-white/[0.08] text-[11px] shrink-0 cursor-pointer"
                        >
                          {t('Open Map')}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
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
                {t('Calibration Diagnostics & Structural Lint')}
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                {t('Checks non-monotonic axes, >3.5σ outlier spikes, clipped curves, dead 0xFF/0x00 maps, and forgotten twin maps.')}
              </p>
            </div>

            <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[#0c0d10] border border-white/[0.065]">
              {(
                [
                  { id: 'all', label: `${t('All')} (${findings.length})` },
                  { id: 'error', label: `${t('Errors')} (${diagCounts.error})` },
                  { id: 'warning', label: `${t('Warnings')} (${diagCounts.warning})` },
                  { id: 'info', label: `${t('Info')} (${diagCounts.info})` },
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
              <p className="text-sm font-semibold text-zinc-200">{t('No XDF Definition Loaded')}</p>
              <p className="text-xs text-zinc-500 mt-1">
                {t('Pass or load an XDF definition to lint calibration maps, axes, and twin structures.')}
              </p>
            </div>
          ) : visibleFindings.length === 0 ? (
            <div className="rounded-xl bg-[#17181d] border border-emerald-500/25 p-12 text-center">
              <CheckCircle2 className="w-9 h-9 text-emerald-400 mx-auto mb-3" />
              <p className="text-sm font-semibold text-emerald-200">
                {findings.length === 0
                  ? t('Clean Calibration — 0 Lint Findings')
                  : t('No findings match the selected severity filter')}
              </p>
              <p className="text-xs text-zinc-400 mt-1">
                {t('Scanned %lld XDF items across %@ KB flash.', xdf.items.length, (bytes.length / 1024).toFixed(0))}
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

                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                    {(f.category === 'Forgotten Twin' ||
                      f.category === 'Outlier Spike' ||
                      onAutoFixDiagnostic) && (
                      <button
                        type="button"
                        onClick={() => handleAutoFixFinding(f)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/35 text-[11px] font-semibold transition-colors cursor-pointer"
                      >
                        <Wrench className="w-3 h-3" />
                        <span>{t('Auto-Fix')}</span>
                      </button>
                    )}
                    {f.itemId !== undefined && onSelectMap && (
                      <button
                        type="button"
                        onClick={() => onSelectMap(f.itemId!)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#0a84ff]/15 hover:bg-[#0a84ff]/25 text-[#5ac8fa] border border-[#0a84ff]/35 text-[11px] font-medium transition-colors cursor-pointer"
                      >
                        <Table2 className="w-3 h-3" />
                        <span>{t('Open Map')}</span>
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
          {/* Save Snapshot Bar + Quick Snapshot */}
          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 space-y-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h2 className="text-sm font-semibold tracking-[-0.01em] text-white">
                  {t('Binary Checkpoints & Snapshots')}
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  {t('Capture named in-memory checkpoints of the active BIN, compare any two snapshots, and restore instantly.')}
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  handleSaveSnapshot(
                    `Quick ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
                    'Quick checkpoint',
                  )
                }
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/35 text-emerald-300 text-xs font-semibold cursor-pointer"
              >
                <Camera className="w-3.5 h-3.5" />
                <span>{t('Quick Snapshot')}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5">
              <input
                type="text"
                value={snapshotName}
                onChange={(e) => setSnapshotName(e.target.value)}
                placeholder={t('Snapshot name (e.g. Stage 1 +2 deg timing)')}
                className="md:col-span-5 px-3 py-2 rounded-lg bg-[#0c0d10] border border-white/[0.08] text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-[#0a84ff]"
              />
              <input
                type="text"
                value={snapshotNote}
                onChange={(e) => setSnapshotNote(e.target.value)}
                placeholder={t('Optional note...')}
                className="md:col-span-4 px-3 py-2 rounded-lg bg-[#0c0d10] border border-white/[0.08] text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-[#0a84ff]"
              />
              <button
                type="button"
                onClick={() => handleSaveSnapshot()}
                className="md:col-span-3 flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-semibold shadow-[0_2px_10px_rgba(10,132,255,0.3)] transition-colors cursor-pointer"
              >
                <Camera className="w-3.5 h-3.5" />
                <span>{t('Save Snapshot')}</span>
              </button>
            </div>
          </div>

          {/* 4 Snapshot KPI Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('Total Snapshots')}
              </div>
              <div className="mt-1 text-xl font-mono tabular-nums font-bold text-[#5ac8fa]">
                {snapshots.length}
              </div>
            </div>
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('Latest Checkpoint')}
              </div>
              <div className="mt-1 text-xs font-semibold text-white truncate">
                {snapshots[0]?.name ?? t('None')}
              </div>
            </div>
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('Current Delta vs Stock')}
              </div>
              <div className="mt-1 text-xl font-mono tabular-nums font-bold text-amber-400">
                {modifiedBytes.toLocaleString()} B
              </div>
            </div>
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('Active Buffer')}
              </div>
              <div className="mt-1 text-xl font-mono tabular-nums font-bold text-zinc-200">
                {(bytes.length / 1024).toFixed(0)} KB
              </div>
            </div>
          </div>

          {/* Compare Two Snapshots Bar */}
          {snapshots.length >= 2 && (
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3.5 flex items-center justify-between gap-3 flex-wrap text-xs">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                  {t('Compare Two Snapshots:')}
                </span>
                <select
                  value={cmpSnapA}
                  onChange={(e) => setCmpSnapA(e.target.value)}
                  className="px-2.5 py-1 rounded-lg bg-[#0c0d10] border border-white/[0.08] text-xs text-zinc-100"
                >
                  <option value="">{t('Select Snapshot A…')}</option>
                  {snapshots.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <span className="text-zinc-500">vs</span>
                <select
                  value={cmpSnapB}
                  onChange={(e) => setCmpSnapB(e.target.value)}
                  className="px-2.5 py-1 rounded-lg bg-[#0c0d10] border border-white/[0.08] text-xs text-zinc-100"
                >
                  <option value="">{t('Select Snapshot B…')}</option>
                  {snapshots.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              {snapshotComparison && (
                <div className="font-mono text-[11px] px-3 py-1 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300">
                  Δ {snapshotComparison.diffB.toLocaleString()} B · {snapshotComparison.clusterCount}{' '}
                  {t(snapshotComparison.clusterCount === 1 ? 'cluster' : 'clusters')}
                </div>
              )}
            </div>
          )}

          {/* Saved Snapshots List */}
          {snapshots.length === 0 ? (
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-12 text-center">
              <History className="w-9 h-9 text-zinc-600 mx-auto mb-3" />
              <p className="text-sm font-semibold text-zinc-200">{t('No Snapshots Yet')}</p>
              <p className="text-xs text-zinc-500 mt-1">
                {t('Save a snapshot above before making aggressive fuel, boost, or ignition changes.')}
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
                            {t('Matches Current BIN')}
                          </span>
                        ) : diffVsCurrent > 0 ? (
                          <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 font-mono tabular-nums text-[10.5px] text-amber-300">
                            Δ {diffVsCurrent.toLocaleString()} B {t('vs current')}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-[11px] text-zinc-400 mt-1 flex items-center gap-3">
                        <span className="font-mono tabular-nums">
                          {(snap.bytes.length / 1024).toFixed(0)} KB · {snap.changedBytes.toLocaleString()} B {t('vs stock')}
                        </span>
                        {snap.note && <span className="text-zinc-500">· {snap.note}</span>}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                      {onSetCompareFromSnapshot && (
                        <button
                          type="button"
                          onClick={() => onSetCompareFromSnapshot(snap)}
                          className="px-2.5 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-[11px] font-medium text-zinc-200 cursor-pointer"
                        >
                          {t('Set Compare')}
                        </button>
                      )}
                      {onAddSnapshotToMultiCompare && (
                        <button
                          type="button"
                          onClick={() => onAddSnapshotToMultiCompare(snap)}
                          className="px-2.5 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-[11px] font-medium text-zinc-200 cursor-pointer"
                        >
                          {t('Add to Multi-File Comparison')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          triggerDownload(
                            snap.bytes,
                            `${snap.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.bin`,
                          )
                        }
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-[11px] font-medium text-zinc-200 cursor-pointer"
                      >
                        <Download className="w-3 h-3" />
                        <span>{t('Export .bin')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRestoreSnapshot(snap)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#0a84ff]/15 hover:bg-[#0a84ff]/25 border border-[#0a84ff]/35 text-[11px] font-semibold text-[#5ac8fa] cursor-pointer"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span>{t('Restore')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteSnapshot(snap.id)}
                        className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-rose-500/20 hover:text-rose-300 border border-white/[0.07] text-zinc-400 transition-colors cursor-pointer"
                        title={t('Delete')}
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
                {t('Calibration Edit History & Audit Timeline')}
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                {t('Every map tweak, recipe application, and checksum repair recorded in chronological order.')}
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder={t('Filter edits...')}
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
                  <span>{t('Undo Last Edit')}</span>
                </button>
              )}
            </div>
          </div>

          {/* 4 History KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('Logged Edits')}
              </div>
              <div className="mt-1.5 text-xl font-mono tabular-nums font-bold text-[#5ac8fa]">
                {historyEntries.length}
              </div>
            </div>
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('Cumulative Patched')}
              </div>
              <div className="mt-1.5 text-xl font-mono tabular-nums font-bold text-amber-400">
                {totalHistoryBytes.toLocaleString()} B
              </div>
            </div>
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('Net Delta vs Stock')}
              </div>
              <div className="mt-1.5 text-xl font-mono tabular-nums font-bold text-emerald-400">
                {modifiedBytes.toLocaleString()} B
              </div>
            </div>
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('Latest Action')}
              </div>
              <div className="mt-1.5 text-xs font-medium text-zinc-200 truncate">
                {historyEntries.length > 0
                  ? historyEntries[historyEntries.length - 1].label
                  : t('No edits yet')}
              </div>
            </div>
          </div>

          {/* Audit Timeline */}
          {filteredHistory.length === 0 ? (
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-12 text-center">
              <Clock className="w-9 h-9 text-zinc-600 mx-auto mb-3" />
              <p className="text-sm font-semibold text-zinc-200">
                {historyEntries.length === 0
                  ? t('No Calibration Edits Recorded Yet')
                  : t('No history entries match your filter')}
              </p>
              <p className="text-xs text-zinc-500 mt-1 max-w-md mx-auto">
                {t('Edit cells in Map Editor, run a Tuning Recipe, or repair checksums to see the full undoable audit timeline here.')}
              </p>
            </div>
          ) : (
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 space-y-2.5">
              {filteredHistory.map(({ entry, stepNumber }, idx) => {
                const origIdx = stepNumber - 1;
                const isLatest = stepNumber === historyEntries.length;
                const matchedItem = xdf?.items.find((it) =>
                  entry.label.toLowerCase().includes(it.title.toLowerCase()),
                );
                const noteText = localHistoryNotes[origIdx] ?? entry.note ?? '';
                const isEditingNote = editingNoteIdx === origIdx;
                return (
                  <div
                    key={`${stepNumber}-${entry.label}`}
                    className={`rounded-xl p-3.5 border flex items-center justify-between gap-4 transition-colors ${
                      isLatest
                        ? 'bg-[#0a84ff]/[0.08] border-[#0a84ff]/35'
                        : 'bg-[#0c0d10] border-white/[0.06]'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div
                        className={`w-7 h-7 rounded-full flex items-center justify-center font-mono text-[11px] font-bold shrink-0 ${
                          isLatest
                            ? 'bg-[#0a84ff] text-white'
                            : 'bg-white/[0.07] text-zinc-400'
                        }`}
                      >
                        #{stepNumber}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          {matchedItem && onSelectMap ? (
                            <button
                              type="button"
                              onClick={() => onSelectMap(matchedItem.id)}
                              className="text-xs font-semibold text-[#5ac8fa] hover:underline truncate cursor-pointer"
                            >
                              {entry.label}
                            </button>
                          ) : (
                            <span className="text-xs font-semibold text-white truncate">
                              {entry.label}
                            </span>
                          )}
                          {isLatest && (
                            <span className="px-1.5 py-0.5 rounded-full bg-[#0a84ff]/20 text-[#5ac8fa] text-[9.5px] font-semibold uppercase">
                              Latest
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] font-mono text-zinc-500 mt-0.5 flex items-center gap-2 flex-wrap">
                          <span>
                            {entry.timestamp
                              ? new Date(entry.timestamp).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                  second: '2-digit',
                                })
                              : `Session edit ${idx === 0 ? 'most recent' : ''}`}
                          </span>
                          {!isEditingNote && noteText && (
                            <span className="text-zinc-300 font-sans">· {noteText}</span>
                          )}
                        </div>
                        {isEditingNote && (
                          <div className="mt-1.5 flex items-center gap-1.5">
                            <input
                              type="text"
                              value={editingNoteDraft}
                              onChange={(e) => setEditingNoteDraft(e.target.value)}
                              placeholder={t('Add audit note…')}
                              className="flex-1 max-w-xs px-2 py-1 rounded bg-[#17181d] border border-[#0a84ff]/50 text-xs text-zinc-100 focus:outline-none"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  setLocalHistoryNotes((prev) => ({
                                    ...prev,
                                    [origIdx]: editingNoteDraft.trim(),
                                  }));
                                  onUpdateHistoryNote?.(origIdx, editingNoteDraft.trim());
                                  setEditingNoteIdx(null);
                                } else if (e.key === 'Escape') {
                                  setEditingNoteIdx(null);
                                }
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                setLocalHistoryNotes((prev) => ({
                                  ...prev,
                                  [origIdx]: editingNoteDraft.trim(),
                                }));
                                onUpdateHistoryNote?.(origIdx, editingNoteDraft.trim());
                                setEditingNoteIdx(null);
                              }}
                              className="px-2 py-1 rounded bg-[#0a84ff] text-white text-[11px] font-semibold cursor-pointer"
                            >
                              {t('Save')}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingNoteIdx(origIdx);
                          setEditingNoteDraft(noteText);
                        }}
                        className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.1] border border-white/[0.08] text-zinc-400 hover:text-zinc-100 cursor-pointer"
                        title={t('Edit Note')}
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
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
                          <span>{t('Undo')}</span>
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
                  {t('Standalone HTML Calibration Tune Report')}
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  {t('Generates a self-contained dark-mode HTML dossier with ECU identity, modified scalars/flags, and interactive Tuned / Original / Delta heatmaps.')}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleDownloadTxtChangelog}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
              >
                <FileText className="w-3.5 h-3.5 text-zinc-400" />
                <span>{t('TXT Changelog')}</span>
              </button>
              <button
                type="button"
                onClick={handleCopyMarkdownReport}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
              >
                {copiedMd ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-400" />}
                <span>{copiedMd ? t('Copied Markdown') : t('Copy Markdown')}</span>
              </button>
              <button
                type="button"
                onClick={handlePrintPdfReport}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
              >
                <Printer className="w-3.5 h-3.5 text-zinc-400" />
                <span>{t('Print / PDF')}</span>
              </button>
              <button
                type="button"
                onClick={handlePreviewHtmlReport}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
              >
                <ExternalLink className="w-3.5 h-3.5 text-zinc-400" />
                <span>{t('Preview')}</span>
              </button>
              <button
                type="button"
                onClick={handleDownloadHtmlReport}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-semibold shadow-[0_4px_16px_rgba(10,132,255,0.35)] transition-all cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>{t('HTML Report')}</span>
              </button>
            </div>
          </div>

          {/* Live Report Preview Summary */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('ECU Platform')}
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
                {t('Modified Maps')}
              </div>
              <div className="mt-1.5 text-xl font-mono tabular-nums font-bold text-[#5ac8fa]">
                {reportSummary.modifiedMaps}
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-500">
                {xdf ? t('of %lld XDF items', xdf.items.length) : t('No XDF loaded')}
              </div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('Binary Delta')}
              </div>
              <div className="mt-1.5 text-xl font-mono tabular-nums font-bold text-amber-400">
                {modifiedBytes.toLocaleString()} B
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-500">
                {reportSummary.clusterCount} {t(reportSummary.clusterCount === 1 ? 'diff cluster' : 'diff clusters')}
              </div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                {t('Lint & Checksums')}
              </div>
              <div className="mt-1.5 text-sm font-semibold text-zinc-100">
                {allValid ? (
                  <span className="text-emerald-400">{t('Checksums Valid')}</span>
                ) : (
                  <span className="text-rose-400">{invalidFixableBlocks.length} {t('Invalid Block(s)')}</span>
                )}
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-500">
                {findings.length} {t(findings.length === 1 ? 'diagnostic finding' : 'diagnostic findings')}
              </div>
            </div>
          </div>

          <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-4 space-y-2 text-xs text-zinc-400">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
              {t('Included in Export')}
            </div>
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-1.5 pt-1">
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>{t('ECU identification header, SW/HW strings & file metadata')}</span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>{t('Modified constants & bit-flags comparison table')}</span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>{t('Interactive Tuned / Original / Delta thermal 2D map grids')}</span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>{t('Zero external CDN dependencies — opens offline anywhere')}</span>
              </li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
};
