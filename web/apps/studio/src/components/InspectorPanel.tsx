import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Binary,
  BookOpen,
  Calculator,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Cpu,
  Flame,
  Gauge,
  HardDrive,
  Languages,
  Link2,
  Lock,
  Pin,
  Scale,
  Search,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  StickyNote,
  Unlock,
  Wrench,
} from 'lucide-react';
import {
  Axis,
  BinCodec,
  DiagnosticFinding,
  Patch,
  XDFDefinition,
  XDFItem,
  XRefMatch,
  countChangedBytes,
  countChangedCells,
  elementBytes,
  findCodeXRefs,
  findSyncBlocks,
  fixChecksums,
  identifyECU,
  layoutByteRange,
  layoutCount,
  layoutRawRange,
  layoutTypeDescription,
  maxCellDelta,
  runDiagnostics,
  scalingDisplay,
  scalingFormat,
  scalingRawStep,
  scalingValue,
  verifyChecksums,
} from '@mactuner/core';

export type UnitSystem = 'metric' | 'imperial';
export type TranslationMode = 'original' | 'en' | 'de';
type InspectorTab = 'notes' | 'preflight' | 'physics' | 'properties';

export interface OpenBinSummary {
  id: string;
  name: string;
  size?: number;
  modified?: boolean;
}

export interface ChecksumSummaryInfo {
  validCount: number;
  invalidCount: number;
  pluginName?: string;
  canFix?: boolean;
}

export interface InspectorPanelProps {
  item: XDFItem | null;
  bin: Uint8Array;
  compareBin?: Uint8Array | null;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  isLocked?: boolean;
  onToggleLock?: () => void;
  unitSystem?: UnitSystem;
  onUnitSystemChange?: (system: UnitSystem) => void;
  translationMode?: TranslationMode;
  onTranslationModeChange?: (mode: TranslationMode) => void;
  onJumpToHex?: (address: number) => void;
  onOpenXdfEditor?: () => void;
  /** Optional XDF definition for Sync-Blocks, Forgotten Twins, and Definition Lint */
  xdf?: XDFDefinition | null;
  onSelectMap?: (itemId: number) => void;
  onApplyPatches?: (patches: Patch[], label: string) => void;
  /** Split-pin controls */
  isPinned?: boolean;
  onTogglePin?: () => void;
  /** Preflight / Diagnostics / Checksums */
  diagnostics?: DiagnosticFinding[];
  onAutoFixDiagnostic?: (finding: DiagnosticFinding) => void;
  onFixChecksums?: () => void;
  checksumSummary?: ChecksumSummaryInfo;
  /** Open BINs quick-switcher */
  openBins?: OpenBinSummary[];
  activeBinId?: string;
  onSelectOpenBin?: (id: string) => void;
}

const NOTES_STORAGE_KEY = 'mactuner.mapNotes.v1';
const UNIT_STORAGE_KEY = 'mactuner.unitSystem.v1';
const TRANS_STORAGE_KEY = 'mactuner.translationMode.v1';

interface AcronymEntry {
  code: string;
  en: string;
  de: string;
  vendor: string;
}

const ECU_ACRONYMS: AcronymEntry[] = [
  { code: 'LDRXN', en: 'Max Specified Load / Boost Limit', de: 'Max. Soll-Füllung / Ladedruckbegrenzung', vendor: 'Bosch ME/MED' },
  { code: 'LDRXNZK', en: 'Max Specified Load Under Knock', de: 'Max. Soll-Füllung bei Klopfen', vendor: 'Bosch ME/MED' },
  { code: 'KFZWOP', en: 'Optimal Ignition Timing Map', de: 'Kennfeld optimaler Zündwinkel', vendor: 'Bosch ME/MED' },
  { code: 'KFZW', en: 'Base Ignition Timing Map', de: 'Kennfeld Zündwinkel', vendor: 'Bosch ME/MED' },
  { code: 'KFPED', en: 'Driver Pedal Torque Request Map', de: 'Kennfeld Fahrerwunsch-Drehmoment', vendor: 'Bosch ME/MED' },
  { code: 'LAMFA', en: 'Driver Requested Lambda (WOT Fuel)', de: 'Fahrerwunsch-Lambda (Volllast)', vendor: 'Bosch ME/MED' },
  { code: 'KFMIRL', en: 'Target Cylinder Filling from Torque', de: 'Soll-Füllung aus Wunschmoment', vendor: 'Bosch ME/MED' },
  { code: 'KFMIOP', en: 'Optimal Engine Torque Map', de: 'Kennfeld optimales Motormoment', vendor: 'Bosch ME/MED' },
  { code: 'KFLBTS', en: 'Component Protection Lambda (EGT)', de: 'Bauteileschutz-Lambda (Abgastemp.)', vendor: 'Bosch ME/MED' },
  { code: 'KFLDHBN', en: 'Max Pressure Ratio Boost Limit', de: 'Max. Druckverhältnis Ladedruck', vendor: 'Bosch ME/MED' },
  { code: 'KFLDIMX', en: 'Wastegate PID Integral Limit', de: 'LDR I-Regler Begrenzung', vendor: 'Bosch ME/MED' },
  { code: 'KFLDRL', en: 'Boost Solenoid Duty Linearization', de: 'Linearisierung Ladedruck-Tastverhältnis', vendor: 'Bosch ME/MED' },
  { code: 'KFDLULS', en: 'Overboost Fault Detection Limit', de: 'Überdruck-Diagnoseschwelle', vendor: 'Bosch ME/MED' },
  { code: 'KFLF', en: 'Part-Load Lambda Factor Map', de: 'Teillast-Lambdafaktor', vendor: 'Bosch ME/MED' },
  { code: 'NMAX', en: 'Engine Rev Limiter (RPM)', de: 'Drehzahlbegrenzer (U/min)', vendor: 'Bosch / Siemens' },
  { code: 'VMAX', en: 'Vehicle Speed Limiter', de: 'Geschwindigkeitsbegrenzer', vendor: 'Bosch / Siemens' },
  { code: 'KRKTE', en: 'Injector Flow Conversion Constant', de: 'Einspritzventil-Konstante', vendor: 'Bosch ME/MED' },
  { code: 'TVUB', en: 'Injector Dead Time vs Battery Voltage', de: 'Einspritz-Totzeit über Spannung', vendor: 'Bosch ME/MED' },
  { code: 'TLAFA', en: 'Delay Time for Driver Lambda', de: 'Verzögerungszeit Fahrerwunsch-Lambda', vendor: 'Bosch ME/MED' },
  { code: 'KFTARX', en: 'IAT Charge-Air Load Correction', de: 'Ansauglufttemp.-Füllungskorrektur', vendor: 'Bosch ME/MED' },
  { code: 'CDKAT', en: 'Catalyst Efficiency Diagnosis Switch', de: 'Codewort Kat-Diagnose', vendor: 'Bosch ME/MED' },
  { code: 'ESKONF', en: 'Output Stage Configuration Mask', de: 'Endstufenkonfiguration', vendor: 'Bosch ME/MED' },
  { code: 'KFMIZUFIL', en: 'Permissible Torque Monitoring Map', de: 'Zulässiges Moment (Überwachung)', vendor: 'Bosch MED17' },
  { code: 'IP_TI', en: 'Injection Time Base Map', de: 'Kennfeld Einspritzzeit', vendor: 'Siemens / Simos' },
  { code: 'IP_IGA', en: 'Ignition Angle Base Map', de: 'Kennfeld Zündwinkel', vendor: 'Siemens / Simos' },
  { code: 'IP_PUT', en: 'Target Boost Pressure Map', de: 'Kennfeld Soll-Ladedruck', vendor: 'Siemens / Simos' },
];

const DE_TO_EN: [string, string][] = [
  ['Zündwinkel', 'Ignition Timing'],
  ['Zündung', 'Ignition'],
  ['Ladedruck', 'Boost Pressure'],
  ['Drehmoment', 'Torque'],
  ['Einspritzmenge', 'Injection Quantity'],
  ['Einspritzzeit', 'Injection Time'],
  ['Einspritzung', 'Injection'],
  ['Drehzahlbegrenzer', 'Rev Limiter'],
  ['Drehzahl', 'Engine Speed (RPM)'],
  ['Geschwindigkeitsbegrenzer', 'Speed Limiter'],
  ['Geschwindigkeit', 'Vehicle Speed'],
  ['Begrenzer', 'Limiter'],
  ['Begrenzung', 'Limit'],
  ['Kennfeld', 'Map'],
  ['Kennlinie', 'Curve'],
  ['Kraftstoff', 'Fuel'],
  ['Drosselklappe', 'Throttle'],
  ['Abgastemperatur', 'Exhaust Gas Temp (EGT)'],
  ['Kühlmitteltemperatur', 'Coolant Temp'],
  ['Ansauglufttemperatur', 'Intake Air Temp (IAT)'],
  ['Luftmasse', 'Air Mass (MAF)'],
  ['Füllung', 'Cylinder Filling / Load'],
  ['Volllast', 'Full Load (WOT)'],
  ['Teillast', 'Part Load'],
  ['Leerlauf', 'Idle'],
  ['Klopfen', 'Knock'],
  ['Sollwert', 'Target'],
  ['Korrektur', 'Correction'],
  ['Schutz', 'Protection'],
];

const EN_TO_DE: [string, string][] = [
  ['Ignition Timing', 'Zündwinkel'],
  ['Ignition Advance', 'Zündwinkel'],
  ['Boost Pressure', 'Ladedruck'],
  ['Target Boost', 'Soll-Ladedruck'],
  ['Torque', 'Drehmoment'],
  ['Injection Quantity', 'Einspritzmenge'],
  ['Rev Limiter', 'Drehzahlbegrenzer'],
  ['Speed Limiter', 'Geschwindigkeitsbegrenzer'],
  ['Limiter', 'Begrenzer'],
  ['Fuel', 'Kraftstoff'],
  ['Throttle', 'Drosselklappe'],
  ['Coolant Temp', 'Kühlmitteltemperatur'],
  ['Intake Air Temp', 'Ansauglufttemperatur'],
  ['Exhaust Gas Temp', 'Abgastemperatur'],
  ['Full Load', 'Volllast'],
  ['Part Load', 'Teillast'],
  ['Idle', 'Leerlauf'],
  ['Correction', 'Korrektur'],
  ['Protection', 'Schutz'],
  ['Target', 'Sollwert'],
  ['Map', 'Kennfeld'],
  ['Curve', 'Kennlinie'],
];

export function detectMapAcronyms(text: string): AcronymEntry[] {
  if (!text) return [];
  const upper = text.toUpperCase();
  const hits: AcronymEntry[] = [];
  for (const entry of ECU_ACRONYMS) {
    const re = new RegExp(`(^|[^A-Z0-9_])${entry.code}([^A-Z0-9_]|$)`);
    if (re.test(upper)) {
      hits.push(entry);
    }
  }
  return hits;
}

export function translateMapText(text: string, mode: TranslationMode): string {
  if (!text || mode === 'original') return text;
  let out = text;

  for (const entry of ECU_ACRONYMS) {
    const re = new RegExp(`\\b${entry.code}\\b`, 'gi');
    if (re.test(out)) {
      const replacement = mode === 'en' ? `${entry.en} (${entry.code})` : `${entry.de} (${entry.code})`;
      if (out.trim().toUpperCase() === entry.code) {
        return replacement;
      }
    }
  }

  const dict = mode === 'en' ? DE_TO_EN : EN_TO_DE;
  for (const [src, dst] of dict) {
    const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'gi');
    out = out.replace(re, dst);
  }
  return out;
}

export function convertUnitValue(
  value: number,
  xdfUnit: string,
  system: UnitSystem,
): { value: number; unit: string; converted: boolean } {
  const rawUnit = xdfUnit.trim();
  const u = rawUnit.toLowerCase();
  if (!u) return { value, unit: rawUnit, converted: false };

  if (system === 'imperial') {
    if (u === '°c' || u === 'c' || u === 'degc' || u === 'celsius') {
      return { value: (value * 9) / 5 + 32, unit: '°F', converted: true };
    }
    if (u === 'mbar' || u === 'hpa') {
      return { value: value * 0.0145037738, unit: 'psi', converted: true };
    }
    if (u === 'bar') {
      return { value: value * 14.5037738, unit: 'psi', converted: true };
    }
    if (u === 'kpa') {
      return { value: value * 0.145037738, unit: 'psi', converted: true };
    }
    if (u === 'nm' || u === 'n·m' || u === 'n-m') {
      return { value: value * 0.737562149, unit: 'lb-ft', converted: true };
    }
    if (u === 'km/h' || u === 'kph' || u === 'kmh') {
      return { value: value * 0.621371192, unit: 'mph', converted: true };
    }
    if (u === 'λ' || u === 'lambda') {
      return { value: value * 14.7, unit: 'AFR', converted: true };
    }
    return { value, unit: rawUnit, converted: false };
  }

  // metric
  if (u === '°f' || u === 'f' || u === 'degf' || u === 'fahrenheit') {
    return { value: ((value - 32) * 5) / 9, unit: '°C', converted: true };
  }
  if (u === 'psi') {
    return { value: value / 14.5037738, unit: 'bar', converted: true };
  }
  if (u === 'lb-ft' || u === 'ft-lb' || u === 'ft-lbs' || u === 'lbft') {
    return { value: value / 0.737562149, unit: 'Nm', converted: true };
  }
  if (u === 'mph') {
    return { value: value / 0.621371192, unit: 'km/h', converted: true };
  }
  if (u === 'afr') {
    return { value: value / 14.7, unit: 'λ', converted: true };
  }
  return { value, unit: rawUnit, converted: false };
}

function loadNotesMap(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(NOTES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveNotesMap(map: Record<string, string>) {
  try {
    window.localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore storage quota errors
  }
}

function noteKeyForItem(item: XDFItem): string {
  const normTitle = item.title.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${item.id}::${normTitle}`;
}

function hexAddr(n: number): string {
  return `0x${Math.max(0, n).toString(16).toUpperCase().padStart(5, '0')}`;
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
  item,
  bin,
  compareBin = null,
  collapsed: controlledCollapsed,
  onToggleCollapse,
  isLocked: controlledLocked,
  onToggleLock,
  unitSystem: controlledUnitSystem,
  onUnitSystemChange,
  translationMode: controlledTranslationMode,
  onTranslationModeChange,
  onJumpToHex,
  onOpenXdfEditor,
  xdf = null,
  onSelectMap,
  onApplyPatches,
  isPinned = false,
  onTogglePin,
  diagnostics: controlledDiagnostics,
  onAutoFixDiagnostic,
  onFixChecksums,
  checksumSummary: controlledChecksumSummary,
  openBins,
  activeBinId,
  onSelectOpenBin,
}) => {
  const [activeTab, setActiveTab] = useState<InspectorTab>('notes');
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const [internalLockedIds, setInternalLockedIds] = useState<Set<number>>(() => new Set());

  const [internalUnitSystem, setInternalUnitSystem] = useState<UnitSystem>(() => {
    try {
      const saved = window.localStorage.getItem(UNIT_STORAGE_KEY);
      return saved === 'imperial' ? 'imperial' : 'metric';
    } catch {
      return 'metric';
    }
  });

  const [internalTransMode, setInternalTransMode] = useState<TranslationMode>(() => {
    try {
      const saved = window.localStorage.getItem(TRANS_STORAGE_KEY);
      return saved === 'en' || saved === 'de' ? saved : 'en';
    } catch {
      return 'en';
    }
  });

  const [notesStore, setNotesStore] = useState<Record<string, string>>(() => loadNotesMap());
  const [acronymLookup, setAcronymLookup] = useState<string>('');

  // Code XREFs state
  const [xrefResults, setXrefResults] = useState<XRefMatch[] | null>(null);
  const [xrefTargetAddr, setXrefTargetAddr] = useState<number | null>(null);

  // Physics calculator state
  const [fuelMode, setFuelMode] = useState<'diesel' | 'gasoline'>('diesel');
  const [dieselAirMg, setDieselAirMg] = useState<number>(1150);
  const [dieselIqMg, setDieselIqMg] = useState<number>(68);
  const [dieselRpm, setDieselRpm] = useState<number>(4000);
  const [gasBoostBar, setGasBoostBar] = useState<number>(2.4);
  const [gasDispL, setGasDispL] = useState<number>(2.0);
  const [gasRpm, setGasRpm] = useState<number>(5800);

  // Reset XREFs when item changes
  useEffect(() => {
    setXrefResults(null);
    setXrefTargetAddr(null);
  }, [item?.id]);

  const isCollapsed = controlledCollapsed ?? internalCollapsed;
  const toggleCollapse = () => {
    if (onToggleCollapse) onToggleCollapse();
    else setInternalCollapsed((v) => !v);
  };

  const isLocked =
    controlledLocked !== undefined
      ? controlledLocked
      : item
        ? internalLockedIds.has(item.id)
        : false;

  const handleToggleLock = () => {
    if (onToggleLock) {
      onToggleLock();
    } else if (item) {
      setInternalLockedIds((prev) => {
        const next = new Set(prev);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
    }
  };

  const unitSystem = controlledUnitSystem ?? internalUnitSystem;
  const setUnitSystem = (next: UnitSystem) => {
    if (onUnitSystemChange) onUnitSystemChange(next);
    else {
      setInternalUnitSystem(next);
      try {
        window.localStorage.setItem(UNIT_STORAGE_KEY, next);
      } catch {
        // ignore
      }
    }
  };

  const translationMode = controlledTranslationMode ?? internalTransMode;
  const setTranslationMode = (next: TranslationMode) => {
    if (onTranslationModeChange) onTranslationModeChange(next);
    else {
      setInternalTransMode(next);
      try {
        window.localStorage.setItem(TRANS_STORAGE_KEY, next);
      } catch {
        // ignore
      }
    }
  };

  // Cmd+L / Ctrl+L shortcut for Map Lock when uncontrolled
  useEffect(() => {
    if (!item || onToggleLock) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        setInternalLockedIds((prev) => {
          const next = new Set(prev);
          if (next.has(item.id)) next.delete(item.id);
          else next.add(item.id);
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [item, onToggleLock]);

  const activeNote = useMemo(() => {
    if (!item) return '';
    return notesStore[noteKeyForItem(item)] ?? '';
  }, [item, notesStore]);

  const updateActiveNote = (val: string) => {
    if (!item) return;
    const key = noteKeyForItem(item);
    setNotesStore((prev) => {
      const next = { ...prev };
      if (val.trim().length === 0) delete next[key];
      else next[key] = val;
      saveNotesMap(next);
      return next;
    });
  };

  // ECU Identity (for Props tab)
  const ecuIdentity = useMemo(() => identifyECU(bin), [bin]);

  // Sync Blocks (for Map tab Sync-Block pill & Preflight Forgotten Twins)
  const syncBlocks = useMemo(() => {
    if (!xdf || bin.length === 0) return [];
    return findSyncBlocks(compareBin ?? bin, xdf, 0.92);
  }, [xdf, bin, compareBin]);

  const itemById = useMemo(() => {
    const m = new Map<number, XDFItem>();
    if (xdf) {
      for (const it of xdf.items) m.set(it.id, it);
    }
    return m;
  }, [xdf]);

  const activeSyncGroup = useMemo(() => {
    if (!item) return null;
    return syncBlocks.find((g) => g.itemIds.includes(item.id)) ?? null;
  }, [syncBlocks, item]);

  // Forgotten Twins: twin groups where at least one map is modified vs compareBin and another is untouched
  const forgottenTwins = useMemo(() => {
    if (!compareBin || !xdf || syncBlocks.length === 0) return [];
    const out: Array<{ source: XDFItem; target: XDFItem; similarity: number }> = [];
    for (const grp of syncBlocks) {
      const members = grp.itemIds
        .map((id) => itemById.get(id))
        .filter((it): it is XDFItem => Boolean(it));
      const modified = members.filter((m) => countChangedCells(m, bin, compareBin) > 0);
      const untouched = members.filter((m) => countChangedCells(m, bin, compareBin) === 0);
      if (modified.length > 0 && untouched.length > 0) {
        const src = modified[0];
        for (const tgt of untouched) {
          out.push({ source: src, target: tgt, similarity: grp.similarity });
        }
      }
    }
    return out;
  }, [syncBlocks, itemById, bin, compareBin, xdf]);

  // Preflight checksum summary (use prop or compute fallback when on Preflight tab)
  const effectiveChecksumSummary = useMemo((): ChecksumSummaryInfo | null => {
    if (controlledChecksumSummary) return controlledChecksumSummary;
    if (activeTab !== 'preflight' || bin.length === 0) return null;
    const report = verifyChecksums(bin, compareBin);
    return {
      validCount: report.validCount,
      invalidCount: report.invalidCount,
      pluginName: report.pluginName,
      canFix: report.canFix,
    };
  }, [controlledChecksumSummary, activeTab, bin, compareBin]);

  // Preflight diagnostics (use prop or compute fallback when on Preflight tab)
  const effectiveDiagnostics = useMemo((): DiagnosticFinding[] => {
    if (controlledDiagnostics) return controlledDiagnostics;
    if (activeTab !== 'preflight' || !xdf || bin.length === 0) return [];
    return runDiagnostics(bin, compareBin, xdf);
  }, [controlledDiagnostics, activeTab, bin, compareBin, xdf]);

  const handleCopyToTwin = (source: XDFItem, target: XDFItem) => {
    if (!onApplyPatches) return;
    const [sStart, sEnd] = layoutByteRange(source.data);
    const [tStart, tEnd] = layoutByteRange(target.data);
    const len = Math.min(sEnd - sStart, tEnd - tStart);
    if (len <= 0 || sStart < 0 || sStart + len > bin.length || tStart < 0 || tStart + len > bin.length) {
      return;
    }
    const oldBytes = bin.slice(tStart, tStart + len);
    const nextBytes = bin.slice(sStart, sStart + len);
    onApplyPatches([{ offset: tStart, old: oldBytes, next: nextBytes }], `Copy ${source.title} → ${target.title}`);
  };

  const handleFixChecksumsClick = () => {
    if (onFixChecksums) {
      onFixChecksums();
      return;
    }
    if (onApplyPatches && bin.length > 0) {
      const res = fixChecksums(bin);
      if (res.patches.length > 0) {
        onApplyPatches(res.patches, `Fix ${res.fixedCount} checksum block(s)`);
      }
    }
  };

  const handleScanCodeXRefs = () => {
    if (!item || bin.length === 0) return;
    const found = findCodeXRefs(bin, item.data.address, 25);
    setXrefResults(found);
    setXrefTargetAddr(item.data.address);
  };

  // Detected acronyms + translated title/description
  const detectedAcronyms = useMemo(() => {
    if (!item) return [];
    return detectMapAcronyms(`${item.title} ${item.description}`);
  }, [item]);

  const searchAcronyms = useMemo(() => {
    const q = acronymLookup.trim().toLowerCase();
    if (!q) return [];
    return ECU_ACRONYMS.filter(
      (a) =>
        a.code.toLowerCase().includes(q) ||
        a.en.toLowerCase().includes(q) ||
        a.de.toLowerCase().includes(q),
    ).slice(0, 6);
  }, [acronymLookup]);

  // Compute current map stats & diff summary for Properties + Unit conversion preview
  const mapMetrics = useMemo(() => {
    if (!item || bin.length === 0) return null;
    const [start, end] = layoutByteRange(item.data);
    const totalCells = layoutCount(item.data);
    const elemSize = elementBytes(item.data);
    const [rawMin, rawMax] = layoutRawRange(item.data);

    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let validCount = 0;
    for (let r = 0; r < item.data.rows; r++) {
      for (let c = 0; c < item.data.cols; c++) {
        const raw = BinCodec.raw(item.data, { r, c }, bin);
        if (raw !== null) {
          const v = scalingValue(item.scaling, raw);
          if (Number.isFinite(v)) {
            if (v < min) min = v;
            if (v > max) max = v;
            sum += v;
            validCount++;
          }
        }
      }
    }

    const changedCells = compareBin ? countChangedCells(item, bin, compareBin) : 0;
    const changedBytes = compareBin ? countChangedBytes(bin, compareBin, start, end) : 0;
    const maxRawDelta = compareBin ? maxCellDelta(item, bin, compareBin) : 0;

    const describeAxis = (axis: Axis) => {
      const labels = BinCodec.axisLabels(axis, axis.count, bin);
      const first = labels[0] ?? '—';
      const last = labels[labels.length - 1] ?? '—';
      if (axis.source.kind === 'data') {
        const [as, ae] = layoutByteRange(axis.source.layout);
        return {
          source: `${hexAddr(as)} – ${hexAddr(Math.max(as, ae - 1))}`,
          encoding: layoutTypeDescription(axis.source.layout),
          range: `${first} … ${last}${axis.scaling.units ? ` ${axis.scaling.units}` : ''}`,
          equation: axis.scaling.equation,
        };
      }
      return {
        source: axis.source.kind === 'labels' ? 'Static Labels' : 'Implicit Index',
        encoding: `${axis.count} breakpoints`,
        range: `${first} … ${last}`,
        equation: axis.scaling.equation,
      };
    };

    return {
      start,
      end,
      byteLen: Math.max(0, end - start),
      totalCells,
      elemSize,
      rawMin,
      rawMax,
      min: Number.isFinite(min) ? min : null,
      max: Number.isFinite(max) ? max : null,
      avg: validCount > 0 ? sum / validCount : null,
      changedCells,
      changedBytes,
      maxRawDelta,
      xAxisInfo: item.itemKind.kind === 'table' ? describeAxis(item.itemKind.x) : null,
      yAxisInfo: item.itemKind.kind === 'table' ? describeAxis(item.itemKind.y) : null,
    };
  }, [item, bin, compareBin]);

  // Diesel & Gasoline physics outputs
  const dieselCalc = useMemo(() => {
    const afr = dieselAirMg / Math.max(1, dieselIqMg);
    const lambda = afr / 14.5;
    const smokeStatus: 'clean' | 'borderline' | 'smoke' =
      lambda >= 1.15 ? 'clean' : lambda >= 1.05 ? 'borderline' : 'smoke';
    const estNm = dieselIqMg * 5.6;
    const estPs = (estNm * dieselRpm) / 7023.5;
    const estHp = estPs * 0.98632;
    const estLbFt = estNm * 0.737562;
    return { afr, lambda, smokeStatus, estNm, estLbFt, estPs, estHp };
  }, [dieselAirMg, dieselIqMg, dieselRpm]);

  const gasCalc = useMemo(() => {
    const gaugeBar = Math.max(0, gasBoostBar - 1.0);
    const gaugePsi = gaugeBar * 14.5037738;
    const absPsi = gasBoostBar * 14.5037738;
    const estLoadPct = gasBoostBar * 92.0;
    const estNm = gasDispL * 102.0 * gasBoostBar;
    const estLbFt = estNm * 0.737562;
    const estPs = (estNm * gasRpm) / 7023.5;
    const estHp = estPs * 0.98632;
    const targetLambda = gaugeBar > 1.2 ? 0.78 : gaugeBar > 0.6 ? 0.82 : 0.88;
    const targetAfr = targetLambda * 14.7;
    return {
      gaugeBar,
      gaugePsi,
      absPsi,
      estLoadPct,
      estNm,
      estLbFt,
      estPs,
      estHp,
      targetLambda,
      targetAfr,
    };
  }, [gasBoostBar, gasDispL, gasRpm]);

  const preflightBadgeCount =
    (controlledChecksumSummary?.invalidCount ?? 0) +
    forgottenTwins.length +
    (controlledDiagnostics?.filter((d) => d.severity !== 'info').length ?? 0);

  // Collapsed vertical rail
  if (isCollapsed) {
    return (
      <aside className="w-9 shrink-0 h-full bg-[#121317] border-l border-white/[0.065] flex flex-col items-center py-2 gap-1.5 select-none">
        <button
          type="button"
          onClick={toggleCollapse}
          className="p-1.5 rounded-md text-zinc-400 hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
          title="Expand Inspector"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <div className="w-4 h-px bg-white/[0.065] my-0.5" />
        {(
          [
            ['notes', StickyNote, 'Map & Notes'],
            ['preflight', ShieldCheck, 'Preflight & Lint'],
            ['physics', Calculator, 'Physics Calculator'],
            ['properties', Cpu, 'ECU & Properties'],
          ] as const
        ).map(([tabKey, Icon, tip]) => (
          <button
            key={tabKey}
            type="button"
            onClick={() => {
              setActiveTab(tabKey);
              toggleCollapse();
            }}
            className={`relative p-1.5 rounded-md transition-colors cursor-pointer ${
              activeTab === tabKey
                ? 'bg-[#0a84ff]/20 text-[#0a84ff]'
                : 'text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200'
            }`}
            title={tip}
          >
            <Icon className="w-3.5 h-3.5" />
            {tabKey === 'preflight' && preflightBadgeCount > 0 && (
              <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-amber-400" />
            )}
          </button>
        ))}
      </aside>
    );
  }

  return (
    <aside className="w-72 shrink-0 h-full bg-[#121317] border-l border-white/[0.065] flex flex-col text-zinc-100 overflow-hidden">
      {/* Top Tab Strip + Collapse */}
      <div className="shrink-0 flex items-center gap-1 px-2 py-2 border-b border-white/[0.065] bg-[#15161b]">
        <div className="flex-1 grid grid-cols-4 gap-0.5 rounded-lg bg-white/[0.045] p-0.5">
          {(
            [
              ['notes', 'Map', StickyNote],
              ['preflight', 'Check', ShieldCheck],
              ['physics', 'Calc', Calculator],
              ['properties', 'ECU', Cpu],
            ] as const
          ).map(([key, label, Icon]) => {
            const active = activeTab === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setActiveTab(key)}
                className={`relative inline-flex items-center justify-center gap-1 py-1 px-1 rounded-md text-[10px] font-medium transition-all cursor-pointer ${
                  active
                    ? 'bg-[#0a84ff] text-white shadow-[0_1px_6px_rgba(10,132,255,0.35)]'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Icon className="w-3 h-3 shrink-0" />
                <span className="truncate">{label}</span>
                {key === 'preflight' && preflightBadgeCount > 0 && !active && (
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                )}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={toggleCollapse}
          className="p-1 rounded-md text-zinc-500 hover:bg-white/[0.07] hover:text-zinc-200 transition-colors cursor-pointer shrink-0"
          title="Collapse Inspector"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Scrollable Inspector Body */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {/* TAB 1: MAP & NOTES */}
        {activeTab === 'notes' && (
          <>
            {/* Map Lock, Pin & Quick Actions */}
            <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                  Protection &amp; Workspace
                </span>
                <kbd className="text-[10px] font-mono text-zinc-500">⌘L</kbd>
              </div>

              <button
                type="button"
                disabled={!item}
                onClick={handleToggleLock}
                className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-xs font-medium border transition-colors ${
                  !item
                    ? 'bg-white/[0.02] border-white/[0.05] text-zinc-600 cursor-not-allowed'
                    : isLocked
                      ? 'bg-amber-500/15 border-amber-500/35 text-amber-300 hover:bg-amber-500/20 cursor-pointer'
                      : 'bg-white/[0.04] border-white/[0.065] text-zinc-200 hover:bg-white/[0.08] cursor-pointer'
                }`}
              >
                <span className="inline-flex items-center gap-2">
                  {isLocked ? (
                    <Lock className="w-3.5 h-3.5 text-amber-400" />
                  ) : (
                    <Unlock className="w-3.5 h-3.5 text-zinc-400" />
                  )}
                  {isLocked ? 'Map Locked (Read-Only)' : 'Map Unlocked'}
                </span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                    isLocked ? 'bg-amber-500/20 text-amber-200' : 'bg-white/[0.06] text-zinc-400'
                  }`}
                >
                  {isLocked ? 'ON' : 'OFF'}
                </span>
              </button>

              {/* Pin for Split Button */}
              {onTogglePin && (
                <button
                  type="button"
                  disabled={!item}
                  onClick={onTogglePin}
                  className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    !item
                      ? 'bg-white/[0.02] border-white/[0.05] text-zinc-600 cursor-not-allowed'
                      : isPinned
                        ? 'bg-[#0a84ff]/15 border-[#0a84ff]/35 text-sky-300 hover:bg-[#0a84ff]/25 cursor-pointer'
                        : 'bg-white/[0.04] border-white/[0.065] text-zinc-300 hover:bg-white/[0.08] cursor-pointer'
                  }`}
                >
                  <span className="inline-flex items-center gap-2">
                    <Pin className="w-3.5 h-3.5" />
                    {isPinned ? 'Pinned for Split' : 'Pin for Split'}
                  </span>
                  <span className="text-[10px] font-mono opacity-75">
                    {isPinned ? 'PINNED' : 'OFF'}
                  </span>
                </button>
              )}

              {/* Sync-Block Twin Pill */}
              {activeSyncGroup && (
                <div className="rounded-lg bg-sky-500/10 border border-sky-500/25 p-2 space-y-1.5">
                  <div className="flex items-center justify-between text-[10.5px]">
                    <span className="inline-flex items-center gap-1.5 font-semibold text-sky-300">
                      <Link2 className="w-3 h-3" />
                      Sync-Block ({activeSyncGroup.itemIds.length} twins)
                    </span>
                    <span className="font-mono text-[10px] text-sky-200/80">
                      {Math.round(activeSyncGroup.similarity * 100)}%
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {activeSyncGroup.itemIds
                      .filter((id) => id !== item?.id)
                      .slice(0, 4)
                      .map((id) => {
                        const twin = itemById.get(id);
                        if (!twin) return null;
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => onSelectMap?.(id)}
                            className="px-1.5 py-0.5 rounded bg-white/[0.07] hover:bg-white/[0.14] text-[10px] text-zinc-200 truncate max-w-full cursor-pointer"
                            title={`Jump to twin ${twin.title}`}
                          >
                            {twin.title}
                          </button>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Metric <-> Imperial Unit Toggle */}
              <div className="space-y-1.5 pt-1 border-t border-white/[0.06]">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400">
                    <Scale className="w-3 h-3 text-zinc-500" />
                    Unit System
                  </span>
                  <div className="inline-flex rounded-md bg-white/[0.05] p-0.5">
                    {(
                      [
                        ['metric', 'Metric'],
                        ['imperial', 'Imperial'],
                      ] as const
                    ).map(([sys, lbl]) => (
                      <button
                        key={sys}
                        type="button"
                        onClick={() => setUnitSystem(sys)}
                        className={`px-2 py-0.5 rounded text-[10.5px] font-medium transition-colors cursor-pointer ${
                          unitSystem === sys
                            ? 'bg-[#0a84ff] text-white'
                            : 'text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="text-[10px] font-mono text-zinc-500">
                  {unitSystem === 'metric'
                    ? 'mbar / bar · °C · Nm · km/h · λ'
                    : 'psi · °F · lb-ft · mph · AFR'}
                </div>

                {/* Live converted map range preview */}
                {item && mapMetrics && mapMetrics.min !== null && mapMetrics.max !== null && item.scaling.units && (
                  (() => {
                    const loC = convertUnitValue(mapMetrics.min, item.scaling.units, unitSystem);
                    const hiC = convertUnitValue(mapMetrics.max, item.scaling.units, unitSystem);
                    if (!loC.converted) return null;
                    return (
                      <div className="rounded-lg bg-[#101115] border border-white/[0.06] px-2.5 py-1.5 flex items-center justify-between text-[10.5px] font-mono tabular-nums">
                        <span className="text-zinc-500">Converted</span>
                        <span className="text-sky-300 font-semibold">
                          {loC.value.toFixed(1)} – {hiC.value.toFixed(1)} {loC.unit}
                        </span>
                      </div>
                    );
                  })()
                )}
              </div>
            </section>

            {/* Code XREFs Disassembly Lookup */}
            <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                  <Search className="w-3 h-3 text-[#0a84ff]" />
                  Code XREFs
                </span>
                {xrefTargetAddr !== null && (
                  <span className="text-[10px] font-mono text-zinc-500">
                    {xrefResults?.length ?? 0} hits
                  </span>
                )}
              </div>

              <button
                type="button"
                disabled={!item || bin.length === 0}
                onClick={handleScanCodeXRefs}
                className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-40 disabled:cursor-not-allowed text-zinc-200 transition-colors cursor-pointer"
              >
                <Search className="w-3.5 h-3.5 text-[#0a84ff]" />
                Find Code XREFs
              </button>

              {xrefResults !== null && (
                xrefResults.length === 0 ? (
                  <div className="text-[11px] text-zinc-500 text-center py-1">
                    No code or pointer references found for {hexAddr(xrefTargetAddr ?? 0)}.
                  </div>
                ) : (
                  <div className="space-y-1.5 max-h-44 overflow-y-auto pr-0.5">
                    {xrefResults.map((x) => (
                      <button
                        key={`${x.codeAddress}-${x.arch}`}
                        type="button"
                        onClick={() => onJumpToHex?.(x.codeAddress)}
                        className="w-full text-left rounded-lg bg-[#101115] hover:bg-white/[0.07] border border-white/[0.06] px-2 py-1.5 space-y-0.5 transition-colors cursor-pointer"
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[10.5px] font-mono font-semibold text-sky-300">
                            {hexAddr(x.codeAddress)}
                          </span>
                          <span className="px-1.5 py-0.5 rounded bg-white/[0.06] text-[9px] font-mono uppercase text-zinc-400">
                            {x.arch}
                          </span>
                        </div>
                        <div className="text-[10px] font-mono text-zinc-200 truncate" title={x.instruction}>
                          {x.instruction}
                        </div>
                        <div className="text-[9.5px] font-mono text-zinc-500 truncate" title={x.preview}>
                          {x.preview}
                        </div>
                      </button>
                    ))}
                  </div>
                )
              )}
            </section>

            {/* Bosch / Siemens Acronym & DE/EN Map Translator */}
            <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                  <Languages className="w-3 h-3 text-[#0a84ff]" />
                  ECU Glossary &amp; Translator
                </span>
              </div>

              <div className="grid grid-cols-3 gap-0.5 rounded-md bg-white/[0.05] p-0.5">
                {(
                  [
                    ['original', 'XDF'],
                    ['en', 'EN'],
                    ['de', 'DE'],
                  ] as const
                ).map(([m, lbl]) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setTranslationMode(m)}
                    className={`py-0.5 rounded text-[10.5px] font-medium transition-colors cursor-pointer ${
                      translationMode === m
                        ? 'bg-[#0a84ff] text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>

              {item ? (
                <div className="rounded-lg bg-[#101115] border border-white/[0.06] p-2.5 space-y-1">
                  <div className="text-[11.5px] font-semibold text-zinc-100 leading-snug">
                    {translateMapText(item.title, translationMode)}
                  </div>
                  {item.description && (
                    <div className="text-[10.5px] text-zinc-400 leading-relaxed">
                      {translateMapText(item.description, translationMode)}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-[11px] text-zinc-500">Select a map to translate its title.</div>
              )}

              {detectedAcronyms.length > 0 && (
                <div className="space-y-1.5">
                  {detectedAcronyms.map((ac) => (
                    <div
                      key={ac.code}
                      className="rounded-lg bg-[#0a84ff]/10 border border-[#0a84ff]/25 px-2.5 py-2 space-y-0.5"
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[11px] font-mono font-bold text-sky-300">
                          {ac.code}
                        </span>
                        <span className="text-[9.5px] text-zinc-400">{ac.vendor}</span>
                      </div>
                      <div className="text-[11px] text-zinc-100 leading-snug">
                        {translationMode === 'de' ? ac.de : ac.en}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Quick Acronym Dictionary Lookup */}
              <div className="space-y-1.5 pt-1 border-t border-white/[0.06]">
                <div className="relative">
                  <BookOpen className="w-3 h-3 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={acronymLookup}
                    onChange={(e) => setAcronymLookup(e.target.value)}
                    placeholder="Lookup LDRXN, KFZWOP, LAMFA…"
                    className="w-full pl-7 pr-2.5 py-1.5 rounded-lg bg-[#101115] border border-white/[0.07] focus:border-[#0a84ff] focus:outline-none text-[11px] font-mono text-zinc-100 placeholder:text-zinc-600"
                  />
                </div>
                {searchAcronyms.length > 0 && (
                  <div className="space-y-1 max-h-36 overflow-y-auto">
                    {searchAcronyms.map((a) => (
                      <div
                        key={a.code}
                        className="rounded-md bg-[#101115] border border-white/[0.05] px-2 py-1.5"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[10.5px] font-mono font-semibold text-sky-300">
                            {a.code}
                          </span>
                          <span className="text-[9px] text-zinc-500">{a.vendor}</span>
                        </div>
                        <div className="text-[10.5px] text-zinc-300 leading-tight">
                          {translationMode === 'de' ? a.de : a.en}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            {/* Per-Map Persistent Notes */}
            <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                  <StickyNote className="w-3 h-3 text-[#0a84ff]" />
                  Calibration Notes
                </span>
                {activeNote.length > 0 && (
                  <span className="text-[9.5px] font-mono text-emerald-400">Saved</span>
                )}
              </div>
              {item ? (
                <textarea
                  value={activeNote}
                  onChange={(e) => updateActiveNote(e.target.value)}
                  rows={4}
                  placeholder={`Notes for ${item.title} (persisted locally)…`}
                  className="w-full rounded-lg bg-[#101115] border border-white/[0.07] focus:border-[#0a84ff] focus:outline-none p-2 text-[11.5px] text-zinc-200 placeholder:text-zinc-600 resize-y leading-relaxed"
                />
              ) : (
                <div className="text-[11px] text-zinc-500">Select a map to add notes.</div>
              )}
            </section>
          </>
        )}

        {/* TAB 2: PREFLIGHT (Checksums + Forgotten Twins + Definition Lint) */}
        {activeTab === 'preflight' && (
          <>
            {/* Checksum Triage Card */}
            <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                  <ShieldCheck className="w-3 h-3 text-[#0a84ff]" />
                  Checksum Triage
                </span>
                {effectiveChecksumSummary && (
                  <span
                    className={`px-1.5 py-0.5 rounded-full text-[9.5px] font-semibold ${
                      effectiveChecksumSummary.invalidCount === 0
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'bg-rose-500/15 text-rose-300'
                    }`}
                  >
                    {effectiveChecksumSummary.invalidCount === 0
                      ? 'ALL OK'
                      : `${effectiveChecksumSummary.invalidCount} INVALID`}
                  </span>
                )}
              </div>

              {effectiveChecksumSummary ? (
                <>
                  <div className="rounded-lg bg-[#101115] border border-white/[0.06] p-2.5 space-y-1">
                    {effectiveChecksumSummary.pluginName && (
                      <div className="text-[11px] font-medium text-zinc-200 truncate">
                        {effectiveChecksumSummary.pluginName}
                      </div>
                    )}
                    <div className="flex items-center justify-between text-[10.5px] font-mono">
                      <span className="text-emerald-400">
                        {effectiveChecksumSummary.validCount} valid
                      </span>
                      <span
                        className={
                          effectiveChecksumSummary.invalidCount > 0
                            ? 'text-rose-400 font-semibold'
                            : 'text-zinc-500'
                        }
                      >
                        {effectiveChecksumSummary.invalidCount} invalid
                      </span>
                    </div>
                  </div>

                  {effectiveChecksumSummary.invalidCount > 0 &&
                    (onFixChecksums || onApplyPatches) && (
                      <button
                        type="button"
                        onClick={handleFixChecksumsClick}
                        className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#0a84ff] hover:bg-[#1e8fff] text-white shadow-[0_1px_8px_rgba(10,132,255,0.35)] transition-colors cursor-pointer"
                      >
                        <Wrench className="w-3.5 h-3.5" />
                        Fix Checksums
                      </button>
                    )}
                </>
              ) : (
                <div className="text-[11px] text-zinc-500">Load a BIN to verify checksums.</div>
              )}
            </section>

            {/* Forgotten Twins Card */}
            <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                  <Copy className="w-3 h-3 text-amber-400" />
                  Forgotten Twins
                </span>
                <span className="text-[10px] font-mono text-zinc-500">
                  {forgottenTwins.length}
                </span>
              </div>

              {forgottenTwins.length === 0 ? (
                <div className="rounded-lg bg-[#101115] border border-white/[0.06] px-2.5 py-2 flex items-center gap-2 text-[11px] text-emerald-300/90">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span>No untouched twin maps detected.</span>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {forgottenTwins.map(({ source, target, similarity }) => (
                    <div
                      key={`${source.id}-${target.id}`}
                      className="rounded-lg bg-amber-500/10 border border-amber-500/25 p-2 space-y-1.5"
                    >
                      <div className="flex items-start justify-between gap-1.5">
                        <button
                          type="button"
                          onClick={() => onSelectMap?.(target.id)}
                          className="text-left text-[11px] font-semibold text-amber-200 hover:underline leading-tight cursor-pointer"
                        >
                          {target.title}
                        </button>
                        <span className="text-[9.5px] font-mono text-amber-300/80 shrink-0">
                          {Math.round(similarity * 100)}%
                        </span>
                      </div>
                      <div className="text-[10px] text-zinc-400 leading-snug">
                        Twin of <span className="text-zinc-200">{source.title}</span> is unmodified.
                      </div>
                      {onApplyPatches && (
                        <button
                          type="button"
                          onClick={() => handleCopyToTwin(source, target)}
                          className="w-full inline-flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[10.5px] font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 transition-colors cursor-pointer"
                        >
                          <Copy className="w-3 h-3" />
                          Copy to Twin
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Definition Lint Card */}
            <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                  <AlertTriangle className="w-3 h-3 text-amber-400" />
                  Definition Lint
                </span>
                <span className="text-[10px] font-mono text-zinc-500">
                  {effectiveDiagnostics.length}
                </span>
              </div>

              {effectiveDiagnostics.length === 0 ? (
                <div className="rounded-lg bg-[#101115] border border-white/[0.06] px-2.5 py-2 flex items-center gap-2 text-[11px] text-emerald-300/90">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span>All XDF definitions pass lint checks.</span>
                </div>
              ) : (
                <div className="space-y-1.5 max-h-72 overflow-y-auto pr-0.5">
                  {effectiveDiagnostics.slice(0, 30).map((f) => (
                    <div
                      key={f.id}
                      className={`rounded-lg border p-2 space-y-1 ${
                        f.severity === 'error'
                          ? 'bg-rose-500/10 border-rose-500/25'
                          : f.severity === 'warning'
                            ? 'bg-amber-500/10 border-amber-500/25'
                            : 'bg-white/[0.03] border-white/[0.065]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <span
                          className={`text-[9.5px] font-semibold uppercase tracking-wider ${
                            f.severity === 'error'
                              ? 'text-rose-300'
                              : f.severity === 'warning'
                                ? 'text-amber-300'
                                : 'text-sky-300'
                          }`}
                        >
                          {f.category}
                        </span>
                        {f.address !== undefined && (
                          <button
                            type="button"
                            onClick={() =>
                              f.itemId !== undefined && onSelectMap
                                ? onSelectMap(f.itemId)
                                : onJumpToHex?.(f.address!)
                            }
                            className="text-[9.5px] font-mono text-zinc-400 hover:text-white cursor-pointer"
                          >
                            {hexAddr(f.address)}
                          </button>
                        )}
                      </div>
                      <div className="text-[11px] font-medium text-zinc-100 leading-snug">
                        {f.title}
                      </div>
                      <div className="text-[10px] text-zinc-400 leading-relaxed">{f.detail}</div>
                      {onAutoFixDiagnostic && (
                        <button
                          type="button"
                          onClick={() => onAutoFixDiagnostic(f)}
                          className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/[0.08] hover:bg-white/[0.15] text-[10px] font-medium text-zinc-100 transition-colors cursor-pointer"
                        >
                          <Wrench className="w-2.5 h-2.5 text-[#0a84ff]" />
                          Auto-Fix
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {/* TAB 3: PHYSICS CALCULATOR */}
        {activeTab === 'physics' && (
          <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3 space-y-3">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                <Gauge className="w-3 h-3 text-[#0a84ff]" />
                Tuning Physics Calc
              </span>
              <span className="text-[9.5px] font-mono text-zinc-500 uppercase">{unitSystem}</span>
            </div>

            <div className="grid grid-cols-2 gap-0.5 rounded-lg bg-white/[0.05] p-0.5">
              <button
                type="button"
                onClick={() => setFuelMode('diesel')}
                className={`py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                  fuelMode === 'diesel'
                    ? 'bg-[#0a84ff] text-white shadow-[0_1px_5px_rgba(10,132,255,0.35)]'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Diesel (TDI/CDI)
              </button>
              <button
                type="button"
                onClick={() => setFuelMode('gasoline')}
                className={`py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                  fuelMode === 'gasoline'
                    ? 'bg-[#0a84ff] text-white shadow-[0_1px_5px_rgba(10,132,255,0.35)]'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Gasoline (TSI/N55)
              </button>
            </div>

            {fuelMode === 'diesel' ? (
              <div className="space-y-3">
                <CalcSlider
                  label="Air Mass (MAF)"
                  value={dieselAirMg}
                  min={400}
                  max={1800}
                  step={10}
                  unit="mg/Hub"
                  onChange={setDieselAirMg}
                />
                <CalcSlider
                  label="Injection Qty (IQ)"
                  value={dieselIqMg}
                  min={20}
                  max={130}
                  step={0.5}
                  unit="mg/Hub"
                  decimals={1}
                  onChange={setDieselIqMg}
                />
                <CalcSlider
                  label="Engine Speed"
                  value={dieselRpm}
                  min={1500}
                  max={5200}
                  step={50}
                  unit="rpm"
                  onChange={setDieselRpm}
                />

                <div
                  className={`rounded-lg border px-2.5 py-2 flex items-center justify-between text-[11px] font-semibold ${
                    dieselCalc.smokeStatus === 'clean'
                      ? 'bg-emerald-500/12 border-emerald-500/30 text-emerald-300'
                      : dieselCalc.smokeStatus === 'borderline'
                        ? 'bg-amber-500/12 border-amber-500/30 text-amber-300'
                        : 'bg-rose-500/12 border-rose-500/30 text-rose-300'
                  }`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Flame className="w-3.5 h-3.5" />
                    Smoke Limit
                  </span>
                  <span>
                    {dieselCalc.smokeStatus === 'clean'
                      ? 'Clean (λ ≥ 1.15)'
                      : dieselCalc.smokeStatus === 'borderline'
                        ? 'Haze Zone'
                        : 'Heavy Smoke!'}
                  </span>
                </div>

                <div className="rounded-lg bg-[#101115] border border-white/[0.06] p-2.5 space-y-1.5">
                  <KvRow label="Lambda (λ)" value={dieselCalc.lambda.toFixed(3)} mono highlight />
                  <KvRow label="AFR (Diesel 14.5:1)" value={`${dieselCalc.afr.toFixed(1)} : 1`} mono />
                  <KvRow
                    label="Est. Torque"
                    value={
                      unitSystem === 'imperial'
                        ? `~${dieselCalc.estLbFt.toFixed(0)} lb-ft`
                        : `~${dieselCalc.estNm.toFixed(0)} Nm`
                    }
                    mono
                  />
                  <KvRow
                    label="Est. Power"
                    value={`~${dieselCalc.estHp.toFixed(0)} HP · ${dieselCalc.estPs.toFixed(0)} PS`}
                    mono
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <CalcSlider
                  label="Boost (Abs.)"
                  value={gasBoostBar}
                  min={1.0}
                  max={3.4}
                  step={0.05}
                  unit={
                    unitSystem === 'imperial'
                      ? `bar (${gasCalc.absPsi.toFixed(1)} psi)`
                      : 'bar'
                  }
                  decimals={2}
                  onChange={setGasBoostBar}
                />
                <CalcSlider
                  label="Displacement"
                  value={gasDispL}
                  min={1.0}
                  max={6.2}
                  step={0.1}
                  unit="L"
                  decimals={1}
                  onChange={setGasDispL}
                />
                <CalcSlider
                  label="Engine Speed"
                  value={gasRpm}
                  min={2000}
                  max={8000}
                  step={100}
                  unit="rpm"
                  onChange={setGasRpm}
                />

                <div className="rounded-lg bg-[#101115] border border-white/[0.06] p-2.5 space-y-1.5">
                  <KvRow
                    label="Gauge Boost"
                    value={
                      unitSystem === 'imperial'
                        ? `+${gasCalc.gaugePsi.toFixed(1)} psi`
                        : `+${gasCalc.gaugeBar.toFixed(2)} bar`
                    }
                    mono
                    highlight
                  />
                  <KvRow label="Est. Rel. Load" value={`~${gasCalc.estLoadPct.toFixed(0)} %`} mono />
                  <KvRow
                    label="Target Fueling"
                    value={
                      unitSystem === 'imperial'
                        ? `AFR ${gasCalc.targetAfr.toFixed(2)} (λ ${gasCalc.targetLambda.toFixed(2)})`
                        : `λ ${gasCalc.targetLambda.toFixed(2)} (AFR ${gasCalc.targetAfr.toFixed(1)})`
                    }
                    mono
                  />
                  <KvRow
                    label="Est. Torque"
                    value={
                      unitSystem === 'imperial'
                        ? `~${gasCalc.estLbFt.toFixed(0)} lb-ft`
                        : `~${gasCalc.estNm.toFixed(0)} Nm`
                    }
                    mono
                  />
                  <KvRow
                    label="Est. Power"
                    value={`~${gasCalc.estHp.toFixed(0)} HP · ${gasCalc.estPs.toFixed(0)} PS`}
                    mono
                  />
                </div>
              </div>
            )}
          </section>
        )}

        {/* TAB 4: ECU & PROPERTIES */}
        {activeTab === 'properties' && (
          <>
            {/* ECU Identity Summary Card */}
            <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                  <Cpu className="w-3 h-3 text-[#0a84ff]" />
                  ECU Identity
                </span>
                {ecuIdentity.hasTPROT && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/15 text-[9.5px] font-mono font-semibold text-amber-300">
                    <ShieldAlert className="w-2.5 h-2.5" />
                    TPROT
                  </span>
                )}
              </div>
              <div className="space-y-1.5">
                <KvRow label="Family" value={ecuIdentity.ecuFamily} highlight />
                <KvRow label="HW Number" value={ecuIdentity.hardwareNumber} mono />
                <KvRow label="SW Number" value={ecuIdentity.softwareNumber} mono />
                {ecuIdentity.oemPartNumber && (
                  <KvRow label="OEM / EPK" value={ecuIdentity.oemPartNumber} mono />
                )}
                <KvRow
                  label="Arch"
                  value={`${ecuIdentity.architecture} (${ecuIdentity.endianness})`}
                  mono
                />
                <KvRow label="Binary Size" value={`${ecuIdentity.fileSizeKB} KB`} mono />
              </div>
            </section>

            {/* Open BINs Quick-Switcher */}
            {openBins && openBins.length > 0 && (
              <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                    <HardDrive className="w-3 h-3 text-[#0a84ff]" />
                    Open BINs
                  </span>
                  <span className="text-[10px] font-mono text-zinc-500">{openBins.length}</span>
                </div>
                <div className="space-y-1">
                  {openBins.map((b) => {
                    const active = b.id === activeBinId;
                    return (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => onSelectOpenBin?.(b.id)}
                        className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-[11px] border transition-colors cursor-pointer ${
                          active
                            ? 'bg-[#0a84ff]/15 border-[#0a84ff]/40 text-sky-200 font-medium'
                            : 'bg-[#101115] border-white/[0.05] text-zinc-300 hover:bg-white/[0.06]'
                        }`}
                      >
                        <span className="truncate">{b.name}</span>
                        <span className="flex items-center gap-1.5 shrink-0 font-mono text-[10px] text-zinc-500">
                          {b.modified && (
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" title="Modified" />
                          )}
                          {b.size !== undefined ? `${Math.round(b.size / 1024)}K` : ''}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {!item || !mapMetrics ? (
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-5 text-center text-xs text-zinc-500">
                Select a map in the workspace to inspect its binary layout and diff summary.
              </div>
            ) : (
              <>
                {/* Exact Memory & Encoding Card */}
                <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3 space-y-2">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                    Binary Layout
                  </div>
                  <div className="space-y-1.5">
                    <KvRow
                      label="Byte Range"
                      value={`${hexAddr(mapMetrics.start)} – ${hexAddr(Math.max(mapMetrics.start, mapMetrics.end - 1))}`}
                      mono
                    />
                    <KvRow
                      label="Size"
                      value={`${mapMetrics.byteLen} B (${mapMetrics.totalCells} × ${mapMetrics.elemSize}B)`}
                      mono
                    />
                    <KvRow
                      label="Dimensions"
                      value={`${item.data.rows} × ${item.data.cols} (${item.data.columnMajor ? 'Col-Major' : 'Row-Major'})`}
                      mono
                    />
                    <KvRow label="Encoding" value={layoutTypeDescription(item.data)} mono />
                    <KvRow
                      label="Raw Range"
                      value={
                        item.data.isFloat
                          ? 'IEEE-754 Float32'
                          : `${mapMetrics.rawMin} … ${mapMetrics.rawMax}`
                      }
                      mono
                    />
                  </div>
                </section>

                {/* Scaling Card */}
                <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3 space-y-2">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                    Scaling &amp; Equation
                  </div>
                  <div className="space-y-1.5">
                    <KvRow label="Equation" value={item.scaling.equation || 'X'} mono />
                    <KvRow label="Units" value={item.scaling.units || '—'} />
                    <KvRow
                      label="1 Raw Step"
                      value={`${scalingFormat(item.scaling, scalingRawStep(item.scaling))}${item.scaling.units ? ` ${item.scaling.units}` : ''}`}
                      mono
                    />
                    <KvRow
                      label="Min / Max"
                      value={
                        mapMetrics.min !== null && mapMetrics.max !== null
                          ? `${scalingFormat(item.scaling, mapMetrics.min)} … ${scalingFormat(item.scaling, mapMetrics.max)}`
                          : '—'
                      }
                      mono
                    />
                    <KvRow
                      label="First Cell"
                      value={(() => {
                        const raw = BinCodec.raw(item.data, { r: 0, c: 0 }, bin);
                        return raw !== null ? scalingDisplay(item.scaling, raw, item.data) : '—';
                      })()}
                      mono
                    />
                  </div>
                </section>

                {/* Axis Addresses Card */}
                {(mapMetrics.xAxisInfo || mapMetrics.yAxisInfo) && (
                  <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3 space-y-2.5">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                      Axis Addresses
                    </div>
                    {mapMetrics.xAxisInfo && (
                      <div className="rounded-lg bg-[#101115] border border-white/[0.06] p-2 space-y-1">
                        <div className="text-[10px] font-semibold text-zinc-400">
                          X-Axis ({item.data.cols} cols)
                        </div>
                        <KvRow label="Address" value={mapMetrics.xAxisInfo.source} mono />
                        <KvRow label="Type" value={mapMetrics.xAxisInfo.encoding} mono />
                        <KvRow label="Range" value={mapMetrics.xAxisInfo.range} mono />
                      </div>
                    )}
                    {mapMetrics.yAxisInfo && (
                      <div className="rounded-lg bg-[#101115] border border-white/[0.06] p-2 space-y-1">
                        <div className="text-[10px] font-semibold text-zinc-400">
                          Y-Axis ({item.data.rows} rows)
                        </div>
                        <KvRow label="Address" value={mapMetrics.yAxisInfo.source} mono />
                        <KvRow label="Type" value={mapMetrics.yAxisInfo.encoding} mono />
                        <KvRow label="Range" value={mapMetrics.yAxisInfo.range} mono />
                      </div>
                    )}
                  </section>
                )}

                {/* Diff Summary Card */}
                <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3 space-y-2">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                    Diff Summary
                  </div>
                  {compareBin ? (
                    <div className="space-y-1.5">
                      <KvRow
                        label="Changed Cells"
                        value={`${mapMetrics.changedCells} / ${mapMetrics.totalCells} (${Math.round(
                          (mapMetrics.changedCells / Math.max(1, mapMetrics.totalCells)) * 100,
                        )}%)`}
                        mono
                        highlight={mapMetrics.changedCells > 0}
                      />
                      <KvRow
                        label="Changed Bytes"
                        value={`${mapMetrics.changedBytes} / ${mapMetrics.byteLen} B`}
                        mono
                      />
                      <KvRow
                        label="Max Raw Δ"
                        value={String(Math.round(mapMetrics.maxRawDelta))}
                        mono
                      />
                    </div>
                  ) : (
                    <div className="text-[11px] text-zinc-500">
                      Load a comparison BIN to see cell-level differences.
                    </div>
                  )}
                </section>

                {/* Quick Navigation Buttons */}
                {(onJumpToHex || onOpenXdfEditor) && (
                  <div className="grid grid-cols-2 gap-1.5">
                    {onJumpToHex && (
                      <button
                        type="button"
                        onClick={() => onJumpToHex(item.data.address)}
                        className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200 transition-colors cursor-pointer"
                      >
                        <Binary className="w-3.5 h-3.5 text-zinc-400" />
                        Hex View
                      </button>
                    )}
                    {onOpenXdfEditor && (
                      <button
                        type="button"
                        onClick={onOpenXdfEditor}
                        className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200 transition-colors cursor-pointer"
                      >
                        <SlidersHorizontal className="w-3.5 h-3.5 text-zinc-400" />
                        Edit XDF
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
};

interface KvRowProps {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}

const KvRow: React.FC<KvRowProps> = ({ label, value, mono = false, highlight = false }) => (
  <div className="flex items-baseline justify-between gap-2 text-[11px]">
    <span className="text-zinc-500 shrink-0">{label}</span>
    <span
      className={`truncate text-right ${mono ? 'font-mono tabular-nums' : 'font-medium'} ${
        highlight ? 'text-sky-300 font-semibold' : 'text-zinc-200'
      }`}
      title={value}
    >
      {value}
    </span>
  </div>
);

interface CalcSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  decimals?: number;
  onChange: (v: number) => void;
}

const CalcSlider: React.FC<CalcSliderProps> = ({
  label,
  value,
  min,
  max,
  step,
  unit,
  decimals = 0,
  onChange,
}) => (
  <div className="space-y-1">
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-zinc-400">{label}</span>
      <span className="font-mono font-semibold tabular-nums text-zinc-100">
        {value.toFixed(decimals)} <span className="text-zinc-400 font-normal">{unit}</span>
      </span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="w-full h-1.5 rounded-lg appearance-none bg-white/[0.1] accent-[#0a84ff] cursor-pointer"
    />
  </div>
);

export default InspectorPanel;
