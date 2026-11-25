import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  Cpu,
  Download,
  Eye,
  FilePlus2,
  FolderPlus,
  FunctionSquare,
  Grid3X3,
  Hash,
  Plus,
  SlidersHorizontal,
  Tag,
  ToggleLeft,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react';
import {
  Axis,
  BinCodec,
  DataLayout,
  Expr,
  OutputType,
  Scaling,
  XDFItem,
  XDFItemKind,
  XdfPatchEntry,
  createScaling,
  elementBytes,
  scalingDisplay,
  scalingFormat,
  scalingValue,
} from '@mactuner/core';

export interface XdfEditorModalProps {
  open: boolean;
  item: XDFItem | null;
  bin: Uint8Array;
  categories: Record<number, string>;
  onSave: (updatedItem: XDFItem) => void;
  onCreateNew?: (item?: XDFItem) => void;
  onDelete?: (id: number) => void;
  onClose: () => void;
  /** Optional pre-populated draft when creating a new item from Hex Selection, Potential Map, etc. */
  initialDraft?: Partial<XDFItem> | null;
  /** Optional category map alias */
  xdfCategories?: Record<number, string>;
  /** Optional callback to persist a newly added category */
  onAddCategory?: (name: string) => number | void;
}

type EditorKind = 'table' | 'constant' | 'flag' | 'patch';

interface PatchEntryDraft {
  id: string;
  name: string;
  addressText: string;
  baseHex: string;
  patchHex: string;
}

interface ScalingPreset {
  label: string;
  equation: string;
  units: string;
  decimals: number;
  hint: string;
}

const SCALING_PRESETS: ScalingPreset[] = [
  { label: 'RPM', equation: 'X * 0.25', units: 'rpm', decimals: 0, hint: 'Bosch 16-bit RPM (0.25 rpm/bit)' },
  { label: 'mbar', equation: 'X * 0.1', units: 'mbar', decimals: 1, hint: 'Boost / MAP pressure (0.1 mbar/bit)' },
  { label: 'bar', equation: 'X * 0.1', units: 'bar', decimals: 1, hint: 'Rail / Boost pressure (0.1 bar/bit)' },
  { label: '°C', equation: 'X * 0.1 - 273.15', units: '°C', decimals: 1, hint: 'Bosch Kelvin temperature (0.1 K)' },
  { label: '°C (−40)', equation: 'X * 0.75 - 48', units: '°C', decimals: 1, hint: '8-bit Coolant/IAT temp' },
  { label: 'Nm', equation: 'X * 0.1', units: 'Nm', decimals: 1, hint: 'Engine torque (0.1 Nm/bit)' },
  { label: 'mg/Hub', equation: 'X * 0.01', units: 'mg/Hub', decimals: 2, hint: 'Injection quantity (0.01 mg/stroke)' },
  { label: 'λ', equation: 'X * 0.001', units: 'λ', decimals: 3, hint: 'Target Lambda (0.001 λ/bit)' },
  { label: '°KW', equation: 'X * 0.75 - 23.4', units: '°KW', decimals: 2, hint: 'Ignition timing advance (°BTDC)' },
];

/** Jewel-tile thermal ramp matching MapEditorView & Surface3DCanvas */
const THERMAL_STOPS: [number, number, number][] = [
  [43, 100, 232],  // #2b64e8
  [23, 168, 201],  // #17a8c9
  [39, 176, 92],   // #27b05c
  [217, 164, 22],  // #d9a416
  [235, 110, 31],  // #eb6e1f
  [224, 60, 72],   // #e03c48
];

function thermalRgb(tRaw: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, Number.isFinite(tRaw) ? tRaw : 0.5));
  const scaled = t * (THERMAL_STOPS.length - 1);
  const idx = Math.min(THERMAL_STOPS.length - 2, Math.floor(scaled));
  const frac = scaled - idx;
  const a = THERMAL_STOPS[idx];
  const b = THERMAL_STOPS[idx + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
  ];
}

function parseHexOrDec(text: string): number | null {
  const s = text.trim();
  if (!s) return null;
  if (/^0x[0-9a-fA-F]+$/.test(s)) {
    const n = parseInt(s.slice(2), 16);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  if (/^[0-9a-fA-F]+$/.test(s) && /[a-fA-F]/.test(s)) {
    const n = parseInt(s, 16);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

function formatHex(addr: number): string {
  return `0x${Math.max(0, Math.floor(addr)).toString(16).toUpperCase()}`;
}

function bytesToHexStr(bytes: number[]): string {
  return bytes.map((b) => (b & 0xff).toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function parseHexBytes(text: string): number[] | null {
  const cleaned = text.replace(/0x/gi, '').replace(/[^0-9a-fA-F\s,]/g, '').trim();
  if (!cleaned) return [];
  const tokens = cleaned.split(/[\s,]+/).filter(Boolean);
  const out: number[] = [];
  for (const tok of tokens) {
    if (tok.length <= 2) {
      const v = parseInt(tok, 16);
      if (!Number.isFinite(v)) return null;
      out.push(v & 0xff);
    } else if (tok.length % 2 === 0) {
      for (let i = 0; i < tok.length; i += 2) {
        const v = parseInt(tok.slice(i, i + 2), 16);
        if (!Number.isFinite(v)) return null;
        out.push(v & 0xff);
      }
    } else {
      return null;
    }
  }
  return out;
}

let draftSeq = 1;
function makeEmptyPatchDraft(address = 0): PatchEntryDraft {
  return {
    id: `pe-${draftSeq++}`,
    name: '',
    addressText: formatHex(address),
    baseHex: '',
    patchHex: '90 90',
  };
}

export const XdfEditorModal: React.FC<XdfEditorModalProps> = ({
  open,
  item,
  bin,
  categories,
  onSave,
  onCreateNew,
  onDelete,
  onClose,
  initialDraft = null,
  xdfCategories,
  onAddCategory,
}) => {
  const [kind, setKind] = useState<EditorKind>('table');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState<number>(-1);
  const [extraCategories, setExtraCategories] = useState<Record<number, string>>({});
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');

  // Data layout
  const [addressText, setAddressText] = useState('0x0');
  const [bits, setBits] = useState<number>(16);
  const [signed, setSigned] = useState<boolean>(false);
  const [lsbFirst, setLsbFirst] = useState<boolean>(true);
  const [columnMajor, setColumnMajor] = useState<boolean>(false);
  const [isFloat, setIsFloat] = useState<boolean>(false);
  const [rows, setRows] = useState<number>(8);
  const [cols, setCols] = useState<number>(8);

  // Scaling
  const [equation, setEquation] = useState<string>('X');
  const [units, setUnits] = useState<string>('');
  const [decimals, setDecimals] = useState<number>(1);
  const [outputType, setOutputType] = useState<OutputType>(1);

  // X Axis
  const [xAddrText, setXAddrText] = useState<string>('');
  const [xBits, setXBits] = useState<number>(16);
  const [xSigned, setXSigned] = useState<boolean>(false);
  const [xIsFloat, setXIsFloat] = useState<boolean>(false);
  const [xEq, setXEq] = useState<string>('X');
  const [xUnits, setXUnits] = useState<string>('');

  // Y Axis
  const [yAddrText, setYAddrText] = useState<string>('');
  const [yBits, setYBits] = useState<number>(16);
  const [ySigned, setYSigned] = useState<boolean>(false);
  const [yIsFloat, setYIsFloat] = useState<boolean>(false);
  const [yEq, setYEq] = useState<string>('X');
  const [yUnits, setYUnits] = useState<string>('');

  // Flag
  const [flagMaskText, setFlagMaskText] = useState<string>('0x01');
  const [flagInvert, setFlagInvert] = useState<boolean>(false);

  // Patch (XDFPATCH)
  const [patchDrafts, setPatchDrafts] = useState<PatchEntryDraft[]>([makeEmptyPatchDraft(0)]);

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const mergedCategories = useMemo(
    () => ({
      ...(xdfCategories ?? categories),
      ...extraCategories,
    }),
    [xdfCategories, categories, extraCategories],
  );

  const resetToBlank = () => {
    setKind('table');
    setTitle('New Map');
    setDescription('');
    setCategoryId(-1);
    setAddressText('0x0');
    setBits(16);
    setSigned(false);
    setLsbFirst(true);
    setColumnMajor(false);
    setIsFloat(false);
    setRows(8);
    setCols(8);
    setEquation('X');
    setUnits('');
    setDecimals(1);
    setOutputType(1);
    setXAddrText('');
    setXBits(16);
    setXSigned(false);
    setXIsFloat(false);
    setXEq('X');
    setXUnits('');
    setYAddrText('');
    setYBits(16);
    setYSigned(false);
    setYIsFloat(false);
    setYEq('X');
    setYUnits('');
    setFlagMaskText('0x01');
    setFlagInvert(false);
    setPatchDrafts([makeEmptyPatchDraft(0)]);
  };

  // Sync form state whenever modal opens or item/initialDraft changes
  useEffect(() => {
    if (!open) return;
    setAddingCategory(false);
    setNewCategoryName('');

    const source: Partial<XDFItem> | null = item ?? initialDraft ?? null;

    if (source) {
      setTitle(source.title ?? 'New Map');
      setDescription(source.description ?? '');
      setCategoryId(source.categories?.[0] ?? -1);
      const d = source.data;
      setAddressText(formatHex(d?.address ?? 0));
      setBits(d && (d.bits === 8 || d.bits === 16 || d.bits === 32) ? d.bits : 16);
      setSigned(d?.signed ?? false);
      setLsbFirst(d?.lsbFirst ?? true);
      setColumnMajor(d?.columnMajor ?? false);
      setIsFloat(d?.isFloat ?? false);
      setRows(Math.max(1, d?.rows ?? 8));
      setCols(Math.max(1, d?.cols ?? 8));

      const sc = source.scaling;
      setEquation(sc?.equation || 'X');
      setUnits(sc?.units || '');
      setDecimals(Math.max(0, Math.min(6, sc?.decimals ?? 1)));
      setOutputType(sc?.output ?? 1);

      const ik = source.itemKind;
      if (!ik || ik.kind === 'table') {
        setKind('table');
        if (ik && ik.kind === 'table') {
          const { x, y } = ik;
          if (x.source.kind === 'data') {
            setXAddrText(formatHex(x.source.layout.address));
            setXBits(x.source.layout.bits);
            setXSigned(x.source.layout.signed);
            setXIsFloat(x.source.layout.isFloat);
          } else {
            setXAddrText('');
            setXBits(16);
            setXSigned(false);
            setXIsFloat(false);
          }
          setXEq(x.scaling.equation || 'X');
          setXUnits(x.scaling.units || '');

          if (y.source.kind === 'data') {
            setYAddrText(formatHex(y.source.layout.address));
            setYBits(y.source.layout.bits);
            setYSigned(y.source.layout.signed);
            setYIsFloat(y.source.layout.isFloat);
          } else {
            setYAddrText('');
            setYBits(16);
            setYSigned(false);
            setYIsFloat(false);
          }
          setYEq(y.scaling.equation || 'X');
          setYUnits(y.scaling.units || '');
        } else {
          setXAddrText('');
          setXBits(16);
          setXSigned(false);
          setXIsFloat(false);
          setXEq('X');
          setXUnits('');
          setYAddrText('');
          setYBits(16);
          setYSigned(false);
          setYIsFloat(false);
          setYEq('X');
          setYUnits('');
        }
        setFlagMaskText('0x01');
        setFlagInvert(false);
        setPatchDrafts([makeEmptyPatchDraft(d?.address ?? 0)]);
      } else if (ik.kind === 'constant') {
        setKind('constant');
        setXAddrText('');
        setYAddrText('');
        setFlagMaskText('0x01');
        setFlagInvert(false);
        setPatchDrafts([makeEmptyPatchDraft(d?.address ?? 0)]);
      } else if (ik.kind === 'flag') {
        setKind('flag');
        setFlagMaskText(formatHex(ik.mask));
        setFlagInvert(ik.invert);
        setXAddrText('');
        setYAddrText('');
        setPatchDrafts([makeEmptyPatchDraft(d?.address ?? 0)]);
      } else if (ik.kind === 'patch') {
        setKind('patch');
        setXAddrText('');
        setYAddrText('');
        const entries = source.patchEntries ?? ik.entries ?? [];
        if (entries.length > 0) {
          setPatchDrafts(
            entries.map((e, idx) => ({
              id: `pe-${draftSeq++}-${idx}`,
              name: e.name ?? '',
              addressText: formatHex(e.address),
              baseHex: bytesToHexStr(e.baseBytes),
              patchHex: bytesToHexStr(e.patchBytes),
            })),
          );
        } else {
          setPatchDrafts([makeEmptyPatchDraft(d?.address ?? 0)]);
        }
      }
    } else {
      resetToBlank();
    }
  }, [open, item, initialDraft]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !addingCategory) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, addingCategory]);

  const parsedAddress = useMemo(() => parseHexOrDec(addressText), [addressText]);
  const parsedFlagMask = useMemo(() => parseHexOrDec(flagMaskText) ?? 1, [flagMaskText]);
  const parsedEquationValid = useMemo(() => {
    const eq = equation.trim() || 'X';
    return Expr.parse(eq) !== null;
  }, [equation]);

  // Parse patch entries
  const parsedPatchEntries = useMemo(() => {
    if (kind !== 'patch') return { entries: [] as XdfPatchEntry[], valid: true };
    const entries: XdfPatchEntry[] = [];
    for (const d of patchDrafts) {
      const addr = parseHexOrDec(d.addressText);
      const pBytes = parseHexBytes(d.patchHex);
      const bBytes = parseHexBytes(d.baseHex);
      if (addr === null || pBytes === null || bBytes === null || pBytes.length === 0) {
        return { entries: [], valid: false };
      }
      entries.push({
        address: addr,
        patchBytes: pBytes,
        baseBytes: bBytes.length === pBytes.length ? bBytes : bBytes,
        ...(d.name.trim() ? { name: d.name.trim() } : {}),
      });
    }
    return { entries, valid: entries.length > 0 };
  }, [kind, patchDrafts]);

  const activeLayout: DataLayout | null = useMemo(() => {
    if (kind === 'patch') {
      const firstAddr = parsedPatchEntries.entries[0]?.address ?? parsedAddress ?? 0;
      const totalPatchBytes = parsedPatchEntries.entries.reduce(
        (acc, e) => acc + e.patchBytes.length,
        0,
      );
      return {
        address: firstAddr,
        bits: 8,
        signed: false,
        lsbFirst: true,
        columnMajor: false,
        isFloat: false,
        rows: 1,
        cols: Math.max(1, totalPatchBytes),
      };
    }
    if (parsedAddress === null) return null;
    const safeRows = kind === 'table' ? Math.max(1, Math.min(256, Math.floor(rows) || 1)) : 1;
    const safeCols = kind === 'table' ? Math.max(1, Math.min(256, Math.floor(cols) || 1)) : 1;
    return {
      address: parsedAddress,
      bits: isFloat ? 32 : bits,
      signed: kind === 'flag' ? false : signed,
      lsbFirst,
      columnMajor: kind === 'table' ? columnMajor : false,
      isFloat: kind === 'flag' ? false : isFloat,
      rows: safeRows,
      cols: safeCols,
    };
  }, [parsedAddress, parsedPatchEntries, kind, rows, cols, bits, signed, lsbFirst, columnMajor, isFloat]);

  const activeScaling: Scaling = useMemo(() => {
    const cleanEq = equation.trim() || 'X';
    return createScaling(cleanEq, units.trim(), Math.max(0, Math.min(6, decimals)), outputType);
  }, [equation, units, decimals, outputType]);

  const byteCount = useMemo(() => {
    if (kind === 'patch') {
      return parsedPatchEntries.entries.reduce((sum, e) => sum + e.patchBytes.length, 0);
    }
    if (!activeLayout) return 0;
    return activeLayout.rows * activeLayout.cols * elementBytes(activeLayout);
  }, [kind, parsedPatchEntries, activeLayout]);

  const isOutOfBounds = useMemo(() => {
    if (kind === 'patch') {
      return parsedPatchEntries.entries.some(
        (e) => e.address < 0 || e.address + e.patchBytes.length > bin.length,
      );
    }
    return activeLayout !== null && activeLayout.address + byteCount > bin.length;
  }, [kind, parsedPatchEntries, activeLayout, byteCount, bin.length]);

  // Compute live preview stats & mini matrix
  const preview = useMemo(() => {
    if (kind === 'patch') {
      if (!parsedPatchEntries.valid || bin.length === 0) return null;
      const items = parsedPatchEntries.entries.map((entry, idx) => {
        const inRange = entry.address >= 0 && entry.address + entry.patchBytes.length <= bin.length;
        const currentBytes = inRange
          ? Array.from(bin.slice(entry.address, entry.address + entry.patchBytes.length))
          : [];
        const matchesPatch =
          inRange &&
          currentBytes.length === entry.patchBytes.length &&
          currentBytes.every((b, i) => b === entry.patchBytes[i]);
        const matchesBase =
          inRange &&
          entry.baseBytes.length === currentBytes.length &&
          currentBytes.every((b, i) => b === entry.baseBytes[i]);
        const status: 'applied' | 'base' | 'custom' | 'oob' = !inRange
          ? 'oob'
          : matchesPatch
            ? 'applied'
            : matchesBase
              ? 'base'
              : 'custom';
        return {
          idx,
          entry,
          currentBytes,
          status,
        };
      });
      return {
        kind: 'patch' as const,
        items,
        totalBytes: items.reduce((s, it) => s + it.entry.patchBytes.length, 0),
        appliedCount: items.filter((it) => it.status === 'applied').length,
      };
    }

    if (!activeLayout || bin.length === 0 || activeLayout.address >= bin.length) {
      return null;
    }

    if (kind === 'table') {
      const maxR = Math.min(activeLayout.rows, 24);
      const maxC = Math.min(activeLayout.cols, 24);
      const matrix: number[][] = [];
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      let count = 0;

      for (let r = 0; r < maxR; r++) {
        const rowVals: number[] = [];
        for (let c = 0; c < maxC; c++) {
          const raw = BinCodec.raw(activeLayout, { r, c }, bin);
          const v = raw !== null ? scalingValue(activeScaling, raw) : 0;
          const safe = Number.isFinite(v) ? v : 0;
          rowVals.push(safe);
          if (safe < min) min = safe;
          if (safe > max) max = safe;
          sum += safe;
          count++;
        }
        matrix.push(rowVals);
      }

      const sampleR = Math.min(4, activeLayout.rows);
      const sampleC = Math.min(4, activeLayout.cols);
      const sampleCells: { text: string; norm: number }[][] = [];
      const span = max - min > 1e-12 ? max - min : 1;

      for (let r = 0; r < sampleR; r++) {
        const sRow: { text: string; norm: number }[] = [];
        for (let c = 0; c < sampleC; c++) {
          const raw = BinCodec.raw(activeLayout, { r, c }, bin);
          const text = raw !== null ? scalingDisplay(activeScaling, raw, activeLayout) : '—';
          const v = raw !== null ? scalingValue(activeScaling, raw) : min;
          const norm = Number.isFinite(v) ? (v - min) / span : 0.5;
          sRow.push({ text, norm });
        }
        sampleCells.push(sRow);
      }

      const buildAxisSummary = (
        addrStr: string,
        axBits: number,
        axSigned: boolean,
        axFloat: boolean,
        axEq: string,
        axUnits: string,
        axCount: number,
      ): string | null => {
        const addr = parseHexOrDec(addrStr);
        if (addr === null || axCount <= 0) return null;
        const sc = createScaling(axEq.trim() || 'X', axUnits.trim(), 1, 1);
        const l: DataLayout = {
          address: addr,
          bits: axFloat ? 32 : axBits,
          signed: axSigned,
          lsbFirst,
          columnMajor: false,
          isFloat: axFloat,
          rows: 1,
          cols: axCount,
        };
        const first = BinCodec.raw(l, { r: 0, c: 0 }, bin);
        const last = BinCodec.raw(l, { r: 0, c: axCount - 1 }, bin);
        if (first === null || last === null) return null;
        const u = axUnits.trim() ? ` ${axUnits.trim()}` : '';
        return `${scalingDisplay(sc, first, l)} … ${scalingDisplay(sc, last, l)}${u}`;
      };

      return {
        kind: 'table' as const,
        matrix,
        maxR,
        maxC,
        min: Number.isFinite(min) ? min : 0,
        max: Number.isFinite(max) ? max : 0,
        avg: count > 0 ? sum / count : 0,
        span,
        sampleCells,
        xSummary: buildAxisSummary(xAddrText, xBits, xSigned, xIsFloat, xEq, xUnits, activeLayout.cols),
        ySummary: buildAxisSummary(yAddrText, yBits, ySigned, yIsFloat, yEq, yUnits, activeLayout.rows),
      };
    }

    if (kind === 'constant') {
      const raw = BinCodec.raw(activeLayout, { r: 0, c: 0 }, bin);
      if (raw === null) return null;
      return {
        kind: 'constant' as const,
        raw,
        formatted: scalingDisplay(activeScaling, raw, activeLayout),
      };
    }

    // flag
    const raw = BinCodec.raw(activeLayout, { r: 0, c: 0 }, bin);
    if (raw === null) return null;
    const uval = Math.max(0, Math.round(raw)) >>> 0;
    const masked = (uval & (parsedFlagMask >>> 0)) !== 0;
    return {
      kind: 'flag' as const,
      uval,
      active: flagInvert ? !masked : masked,
      mask: parsedFlagMask >>> 0,
    };
  }, [
    activeLayout,
    activeScaling,
    bin,
    kind,
    lsbFirst,
    xAddrText,
    xBits,
    xSigned,
    xIsFloat,
    xEq,
    xUnits,
    yAddrText,
    yBits,
    ySigned,
    yIsFloat,
    yEq,
    yUnits,
    parsedFlagMask,
    flagInvert,
    parsedPatchEntries,
  ]);

  // Paint crisp jewel-tile 2D Mini-Heatmap or 1D Sparkline preview on canvas
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !preview || preview.kind !== 'table') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = 276;
    const H = 128;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const { matrix, maxR, maxC, min, span } = preview;
    const is1D = maxR === 1 || maxC === 1;

    if (is1D) {
      const flat = matrix.flat();
      ctx.fillStyle = '#0f1014';
      ctx.fillRect(0, 0, W, H);
      if (flat.length < 2) return;

      const pad = 10;
      const pts = flat.map((v, i) => ({
        x: pad + (i / (flat.length - 1)) * (W - pad * 2),
        y: H - pad - ((v - min) / span) * (H - pad * 2),
      }));

      const grad = ctx.createLinearGradient(0, pad, 0, H - pad);
      grad.addColorStop(0, 'rgba(10, 132, 255, 0.35)');
      grad.addColorStop(1, 'rgba(10, 132, 255, 0)');
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.lineTo(pts[pts.length - 1].x, H - pad);
      ctx.lineTo(pts[0].x, H - pad);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.strokeStyle = '#0a84ff';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }

    ctx.fillStyle = '#0c0d10';
    ctx.fillRect(0, 0, W, H);
    const gap = maxC <= 16 && maxR <= 16 ? 1.5 : 0.75;
    const cw = (W - gap * (maxC + 1)) / Math.max(1, maxC);
    const ch = (H - gap * (maxR + 1)) / Math.max(1, maxR);
    const rad = Math.min(3, Math.min(cw, ch) * 0.22);

    for (let r = 0; r < maxR; r++) {
      for (let c = 0; c < maxC; c++) {
        const t = (matrix[r][c] - min) / span;
        const [red, green, blue] = thermalRgb(t);
        const x = gap + c * (cw + gap);
        const y = gap + r * (ch + gap);

        ctx.fillStyle = `rgba(${red}, ${green}, ${blue}, 0.94)`;
        ctx.beginPath();
        ctx.roundRect(x, y, Math.max(1, cw), Math.max(1, ch), rad);
        ctx.fill();
      }
    }
  }, [preview]);

  if (!open) return null;

  const nudgeAddress = (delta: number) => {
    const cur = parsedAddress ?? 0;
    setAddressText(formatHex(Math.max(0, cur + delta)));
  };

  const applyPreset = (p: ScalingPreset) => {
    setEquation(p.equation);
    setUnits(p.units);
    setDecimals(p.decimals);
    setOutputType(1);
  };

  const handleConfirmAddCategory = () => {
    const trimmed = newCategoryName.trim();
    if (!trimmed) {
      setAddingCategory(false);
      return;
    }
    const existingIds = Object.keys(mergedCategories).map(Number).filter(Number.isFinite);
    const fallbackId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;
    const returned = onAddCategory?.(trimmed);
    const newId = typeof returned === 'number' && Number.isFinite(returned) ? returned : fallbackId;
    setExtraCategories((prev) => ({ ...prev, [newId]: trimmed }));
    setCategoryId(newId);
    setNewCategoryName('');
    setAddingCategory(false);
  };

  const buildAxis = (
    addrStr: string,
    axBits: number,
    axSigned: boolean,
    axFloat: boolean,
    axEq: string,
    axUnits: string,
    count: number,
  ): Axis => {
    const sc = createScaling(axEq.trim() || 'X', axUnits.trim(), 1, 1);
    const addr = parseHexOrDec(addrStr);
    if (addr !== null) {
      const layout: DataLayout = {
        address: addr,
        bits: axFloat ? 32 : axBits,
        signed: axSigned,
        lsbFirst,
        columnMajor: false,
        isFloat: axFloat,
        rows: 1,
        cols: count,
      };
      return { source: { kind: 'data', layout }, count, scaling: sc };
    }
    return { source: { kind: 'none' }, count, scaling: sc };
  };

  const canSave =
    title.trim().length > 0 &&
    activeLayout !== null &&
    (kind === 'patch' ? parsedPatchEntries.valid : parsedEquationValid);

  const handleSave = () => {
    if (!canSave || !activeLayout) return;
    let itemKind: XDFItemKind;
    let patchEntries: XdfPatchEntry[] | undefined;

    if (kind === 'table') {
      itemKind = {
        kind: 'table',
        x: buildAxis(xAddrText, xBits, xSigned, xIsFloat, xEq, xUnits, activeLayout.cols),
        y: buildAxis(yAddrText, yBits, ySigned, yIsFloat, yEq, yUnits, activeLayout.rows),
      };
    } else if (kind === 'constant') {
      itemKind = { kind: 'constant' };
    } else if (kind === 'flag') {
      itemKind = { kind: 'flag', mask: parsedFlagMask >>> 0, invert: flagInvert };
    } else {
      patchEntries = parsedPatchEntries.entries;
      itemKind = { kind: 'patch', entries: patchEntries };
    }

    const updated: XDFItem = {
      id: item?.id ?? Date.now(),
      title: title.trim(),
      description: description.trim(),
      categories: categoryId >= 0 ? [categoryId] : [],
      itemKind,
      data: activeLayout,
      scaling: activeScaling,
      ...(patchEntries ? { patchEntries } : {}),
    };

    if (!item && onCreateNew && onCreateNew.length >= 1) {
      onCreateNew(updated);
    } else {
      onSave(updated);
    }
  };

  const updatePatchDraft = (id: string, patch: Partial<PatchEntryDraft>) => {
    setPatchDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  };

  const readBaseFromBin = (draft: PatchEntryDraft) => {
    const addr = parseHexOrDec(draft.addressText);
    const pBytes = parseHexBytes(draft.patchHex);
    if (addr === null || !pBytes || pBytes.length === 0) return;
    if (addr < 0 || addr + pBytes.length > bin.length) return;
    const baseSlice = Array.from(bin.slice(addr, addr + pBytes.length));
    updatePatchDraft(draft.id, { baseHex: bytesToHexStr(baseSlice) });
  };

  const sortedCategoryEntries = Object.entries(mergedCategories)
    .map(([k, v]) => [Number(k), v] as const)
    .sort((a, b) => a[0] - b[0]);

  const inputCls =
    'px-2.5 py-1.5 rounded-lg bg-[#0f1014] border border-white/[0.08] focus:border-[#0a84ff] focus:outline-none text-xs text-zinc-100 placeholder:text-zinc-600 transition-colors';

  const pillToggle = (label: string, active: boolean, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
        active
          ? 'bg-[#0a84ff]/20 border-[#0a84ff]/50 text-sky-300'
          : 'bg-white/[0.03] border-white/[0.065] text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-200'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[940px] h-[min(88vh,690px)] flex flex-col rounded-2xl bg-[#121317] border border-white/[0.09] shadow-[0_30px_90px_rgba(0,0,0,0.75)] overflow-hidden text-zinc-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b border-white/[0.065] bg-[#17181d]">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-[#0a84ff]/15 border border-[#0a84ff]/30 flex items-center justify-center text-[#0a84ff] shrink-0">
              {kind === 'table' ? (
                <Grid3X3 className="w-4 h-4" />
              ) : kind === 'constant' ? (
                <Hash className="w-4 h-4" />
              ) : kind === 'flag' ? (
                <ToggleLeft className="w-4 h-4" />
              ) : (
                <Wrench className="w-4 h-4" />
              )}
            </div>
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold tracking-[-0.01em] text-zinc-100 truncate">
                {item ? 'Edit XDF Item' : 'New XDF Item'}
              </div>
              <div className="text-[11px] font-mono tabular-nums text-zinc-400">
                {kind === 'patch'
                  ? `${parsedPatchEntries.entries.length} patch ${parsedPatchEntries.entries.length === 1 ? 'entry' : 'entries'} · ${byteCount} bytes`
                  : parsedAddress !== null && byteCount > 0
                    ? `${formatHex(parsedAddress)} – ${formatHex(parsedAddress + byteCount - 1)} · ${byteCount} bytes`
                    : 'Enter a valid start address'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Kind Segmented Selector */}
            <div className="inline-flex rounded-lg bg-white/[0.05] p-0.5">
              {(
                [
                  ['table', 'Map / Table'],
                  ['constant', 'Constant'],
                  ['flag', 'Flag'],
                  ['patch', 'Patch'],
                ] as const
              ).map(([k, lbl]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                    kind === k
                      ? 'bg-[#0a84ff] text-white shadow-[0_1px_6px_rgba(10,132,255,0.35)]'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {lbl}
                </button>
              ))}
            </div>

            {onCreateNew && (
              <button
                type="button"
                onClick={() => {
                  if (onCreateNew.length === 0) onCreateNew();
                  else resetToBlank();
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200 transition-colors cursor-pointer"
                title="Create a blank XDF item"
              >
                <FilePlus2 className="w-3.5 h-3.5 text-zinc-400" />
                New
              </button>
            )}

            {item && onDelete && (
              <button
                type="button"
                onClick={() => {
                  onDelete(item.id);
                  onClose();
                }}
                className="p-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 transition-colors cursor-pointer"
                title="Delete item from XDF"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-white transition-colors cursor-pointer"
              title="Close (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 2-Column Body */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Left Column: Structured Editor Cards */}
          <div className="flex-1 min-w-0 overflow-y-auto p-4 space-y-3 bg-[#0c0d10]">
            {/* General Card */}
            <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3.5 space-y-2.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                <Tag className="w-3.5 h-3.5 text-[#0a84ff]" />
                General
              </div>
              <div className="grid grid-cols-[88px_1fr] items-center gap-2">
                <label className="text-[11.5px] text-zinc-400">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Target Boost Pressure (LDRXN)"
                  className={inputCls}
                />

                <label className="text-[11.5px] text-zinc-400">Description</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional calibration notes or function summary"
                  className={inputCls}
                />

                <label className="text-[11.5px] text-zinc-400">Category</label>
                <div className="flex items-center gap-1.5">
                  {addingCategory ? (
                    <>
                      <input
                        type="text"
                        autoFocus
                        value={newCategoryName}
                        onChange={(e) => setNewCategoryName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleConfirmAddCategory();
                          if (e.key === 'Escape') {
                            setAddingCategory(false);
                            setNewCategoryName('');
                          }
                        }}
                        placeholder="New category name…"
                        className={`${inputCls} flex-1`}
                      />
                      <button
                        type="button"
                        onClick={handleConfirmAddCategory}
                        className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-[#0a84ff] hover:bg-[#1e8fff] text-white cursor-pointer"
                      >
                        Add
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAddingCategory(false);
                          setNewCategoryName('');
                        }}
                        className="px-2 py-1.5 rounded-lg text-[11px] bg-white/[0.05] hover:bg-white/[0.1] text-zinc-400 cursor-pointer"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <select
                        value={categoryId}
                        onChange={(e) => setCategoryId(Number(e.target.value))}
                        className={`${inputCls} flex-1 cursor-pointer`}
                      >
                        <option value={-1}>Uncategorized</option>
                        {sortedCategoryEntries.map(([id, name]) => (
                          <option key={id} value={id}>
                            {name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => setAddingCategory(true)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-white/[0.05] hover:bg-white/[0.1] text-zinc-300 hover:text-white transition-colors cursor-pointer shrink-0"
                        title="Create a new XDF category"
                      >
                        <FolderPlus className="w-3.5 h-3.5 text-[#0a84ff]" />
                        New
                      </button>
                    </>
                  )}
                </div>
              </div>
            </section>

            {/* Patch Entries Card (XDFPATCH) */}
            {kind === 'patch' && (
              <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3.5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                    <Wrench className="w-3.5 h-3.5 text-[#0a84ff]" />
                    Patch Entries (XDFPATCH)
                  </div>
                  <button
                    type="button"
                    onClick={() => setPatchDrafts((prev) => [...prev, makeEmptyPatchDraft(0)])}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-[#0a84ff]/15 hover:bg-[#0a84ff]/25 text-sky-300 border border-[#0a84ff]/30 transition-colors cursor-pointer"
                  >
                    <Plus className="w-3 h-3" />
                    Add Entry
                  </button>
                </div>

                <div className="space-y-2.5">
                  {patchDrafts.map((draft, idx) => (
                    <div
                      key={draft.id}
                      className="rounded-lg bg-[#121317] border border-white/[0.065] p-2.5 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10.5px] font-mono font-semibold text-zinc-400">
                          Entry #{idx + 1}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => readBaseFromBin(draft)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10.5px] bg-white/[0.05] hover:bg-white/[0.1] text-zinc-300 transition-colors cursor-pointer"
                            title="Populate Base Bytes from current BIN at this address"
                          >
                            <Download className="w-3 h-3 text-sky-400" />
                            Read Base
                          </button>
                          {patchDrafts.length > 1 && (
                            <button
                              type="button"
                              onClick={() =>
                                setPatchDrafts((prev) => prev.filter((d) => d.id !== draft.id))
                              }
                              className="p-1 rounded text-rose-400 hover:bg-rose-500/15 transition-colors cursor-pointer"
                              title="Remove patch entry"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-[120px_1fr] gap-2">
                        <div>
                          <label className="block text-[10px] text-zinc-500 mb-1">Hex Address</label>
                          <input
                            type="text"
                            value={draft.addressText}
                            onChange={(e) => updatePatchDraft(draft.id, { addressText: e.target.value })}
                            placeholder="0x24000"
                            className={`${inputCls} w-full font-mono`}
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-zinc-500 mb-1">Label (Optional)</label>
                          <input
                            type="text"
                            value={draft.name}
                            onChange={(e) => updatePatchDraft(draft.id, { name: e.target.value })}
                            placeholder="e.g. NOP speed limiter check"
                            className={`${inputCls} w-full`}
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] text-zinc-500 mb-1">Base Bytes (Hex)</label>
                          <input
                            type="text"
                            value={draft.baseHex}
                            onChange={(e) => updatePatchDraft(draft.id, { baseHex: e.target.value })}
                            placeholder="e.g. 0F 85 12 00"
                            className={`${inputCls} w-full font-mono uppercase`}
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-zinc-500 mb-1">Patch Bytes (Hex)</label>
                          <input
                            type="text"
                            value={draft.patchHex}
                            onChange={(e) => updatePatchDraft(draft.id, { patchHex: e.target.value })}
                            placeholder="e.g. 90 90 90 90"
                            className={`${inputCls} w-full font-mono uppercase`}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Data Layout Card */}
            {kind !== 'patch' && (
              <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3.5 space-y-2.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                  <Cpu className="w-3.5 h-3.5 text-[#0a84ff]" />
                  Data Layout
                </div>

                <div className="grid grid-cols-[88px_1fr] items-center gap-2.5">
                  <label className="text-[11.5px] text-zinc-400">Hex Address</label>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={addressText}
                      onChange={(e) => setAddressText(e.target.value)}
                      placeholder="0x20044"
                      className={`${inputCls} w-28 font-mono tabular-nums`}
                    />
                    <div className="inline-flex rounded-lg bg-white/[0.04] border border-white/[0.065] overflow-hidden">
                      {[-2, -1, 1, 2].map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => nudgeAddress(d)}
                          className="px-2 py-1 text-[10.5px] font-mono text-zinc-300 hover:bg-white/[0.08] hover:text-white transition-colors border-r last:border-r-0 border-white/[0.065] cursor-pointer"
                          title={`Shift address by ${d > 0 ? `+${d}` : d} byte(s)`}
                        >
                          {d > 0 ? `+${d}` : d}
                        </button>
                      ))}
                    </div>

                    <div className="ml-auto flex items-center gap-1.5">
                      <span className="text-[11px] text-zinc-500">Bits</span>
                      <div className="inline-flex rounded-md bg-white/[0.05] p-0.5">
                        {[8, 16, 32].map((b) => (
                          <button
                            key={b}
                            type="button"
                            onClick={() => {
                              setBits(b);
                              if (b !== 32 && isFloat) setIsFloat(false);
                            }}
                            className={`px-2 py-0.5 rounded text-[11px] font-mono transition-colors cursor-pointer ${
                              bits === b
                                ? 'bg-[#0a84ff] text-white'
                                : 'text-zinc-400 hover:text-zinc-200'
                            }`}
                          >
                            {b}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {kind === 'table' && (
                    <>
                      <label className="text-[11.5px] text-zinc-400">Dimensions</label>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] text-zinc-500">Rows</span>
                          <input
                            type="number"
                            min={1}
                            max={256}
                            value={rows}
                            onChange={(e) => setRows(Math.max(1, Math.min(256, parseInt(e.target.value, 10) || 1)))}
                            className={`${inputCls} w-16 font-mono text-center tabular-nums`}
                          />
                        </div>
                        <span className="text-zinc-500 text-xs">×</span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] text-zinc-500">Cols</span>
                          <input
                            type="number"
                            min={1}
                            max={256}
                            value={cols}
                            onChange={(e) => setCols(Math.max(1, Math.min(256, parseInt(e.target.value, 10) || 1)))}
                            className={`${inputCls} w-16 font-mono text-center tabular-nums`}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setRows(cols);
                            setCols(rows);
                          }}
                          className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-white/[0.05] hover:bg-white/[0.1] text-zinc-300 hover:text-white transition-colors cursor-pointer"
                          title="Swap rows and columns"
                        >
                          <ArrowLeftRight className="w-3 h-3" />
                          Swap
                        </button>
                      </div>
                    </>
                  )}

                  <label className="text-[11.5px] text-zinc-400">Encoding</label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {kind !== 'flag' && pillToggle('Signed (±)', signed, () => setSigned((v) => !v))}
                    {pillToggle('LSB First (LE)', lsbFirst, () => setLsbFirst((v) => !v))}
                    {kind === 'table' &&
                      pillToggle('Column-Major', columnMajor, () => setColumnMajor((v) => !v))}
                    {kind !== 'flag' &&
                      pillToggle('Float32', isFloat, () => {
                        setIsFloat((v) => {
                          const next = !v;
                          if (next) setBits(32);
                          return next;
                        });
                      })}
                  </div>
                </div>
              </section>
            )}

            {/* Scaling & Presets Card */}
            {kind !== 'flag' && kind !== 'patch' && (
              <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3.5 space-y-2.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                  <FunctionSquare className="w-3.5 h-3.5 text-[#0a84ff]" />
                  Scaling &amp; Physical Units
                </div>

                <div className="grid grid-cols-[88px_1fr] items-center gap-2.5">
                  <label className="text-[11.5px] text-zinc-400">Equation</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={equation}
                      onChange={(e) => setEquation(e.target.value)}
                      placeholder="X * 0.1 - 40"
                      className={`${inputCls} flex-1 font-mono ${
                        !parsedEquationValid ? 'border-rose-500/70' : ''
                      }`}
                    />
                    <span className="text-[11px] text-zinc-500 shrink-0">Units</span>
                    <input
                      type="text"
                      value={units}
                      onChange={(e) => setUnits(e.target.value)}
                      placeholder="mbar, °C"
                      className={`${inputCls} w-24`}
                    />
                  </div>

                  <label className="text-[11.5px] text-zinc-400">Presets</label>
                  <div className="flex flex-wrap gap-1.5">
                    {SCALING_PRESETS.map((p) => {
                      const active = equation.trim() === p.equation && units.trim() === p.units;
                      return (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() => applyPreset(p)}
                          title={`${p.hint} — ${p.equation} (${p.units})`}
                          className={`px-2 py-0.5 rounded-full text-[10.5px] font-medium border transition-colors cursor-pointer ${
                            active
                              ? 'bg-[#0a84ff] border-[#0a84ff] text-white'
                              : 'bg-[#0a84ff]/10 border-[#0a84ff]/25 text-sky-300 hover:bg-[#0a84ff]/20'
                          }`}
                        >
                          {p.label}
                        </button>
                      );
                    })}
                  </div>

                  <label className="text-[11.5px] text-zinc-400">Format</label>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="inline-flex rounded-md bg-white/[0.05] p-0.5">
                      {(
                        [
                          [1, 'Float'],
                          [2, 'Integer'],
                          [3, 'Hex'],
                        ] as const
                      ).map(([code, lbl]) => (
                        <button
                          key={code}
                          type="button"
                          onClick={() => setOutputType(code)}
                          className={`px-2.5 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                            outputType === code
                              ? 'bg-[#0a84ff] text-white'
                              : 'text-zinc-400 hover:text-zinc-200'
                          }`}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-zinc-500">Decimals</span>
                      <div className="inline-flex items-center rounded-md bg-white/[0.04] border border-white/[0.065]">
                        <button
                          type="button"
                          onClick={() => setDecimals((d) => Math.max(0, d - 1))}
                          className="px-2 py-0.5 text-xs text-zinc-300 hover:bg-white/[0.08] cursor-pointer"
                        >
                          −
                        </button>
                        <span className="w-6 text-center text-xs font-mono tabular-nums text-zinc-100">
                          {decimals}
                        </span>
                        <button
                          type="button"
                          onClick={() => setDecimals((d) => Math.min(6, d + 1))}
                          className="px-2 py-0.5 text-xs text-zinc-300 hover:bg-white/[0.08] cursor-pointer"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* Axes Card (Table only) */}
            {kind === 'table' && (
              <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3.5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                    <SlidersHorizontal className="w-3.5 h-3.5 text-[#0a84ff]" />
                    Axes Breakpoints
                  </div>
                  <span className="text-[10.5px] text-zinc-500">Leave address empty for 0…N index</span>
                </div>

                {/* X Axis */}
                <div className="rounded-lg bg-[#121317] border border-white/[0.06] p-2.5 space-y-2">
                  <div className="text-[11px] font-semibold text-zinc-300">
                    X-Axis (Columns · {cols})
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={xAddrText}
                      onChange={(e) => setXAddrText(e.target.value)}
                      placeholder="0x… (index)"
                      className={`${inputCls} w-28 font-mono`}
                    />
                    <select
                      value={xBits}
                      onChange={(e) => setXBits(Number(e.target.value))}
                      className={`${inputCls} w-20 font-mono cursor-pointer`}
                    >
                      <option value={8}>8-bit</option>
                      <option value={16}>16-bit</option>
                      <option value={32}>32-bit</option>
                    </select>
                    {pillToggle('Signed', xSigned, () => setXSigned((v) => !v))}
                    {pillToggle('Float', xIsFloat, () => setXIsFloat((v) => !v))}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={xEq}
                      onChange={(e) => setXEq(e.target.value)}
                      placeholder="Equation (e.g. X * 0.25)"
                      className={`${inputCls} flex-1 font-mono`}
                    />
                    <input
                      type="text"
                      value={xUnits}
                      onChange={(e) => setXUnits(e.target.value)}
                      placeholder="rpm, %"
                      className={`${inputCls} w-24`}
                    />
                  </div>
                </div>

                {/* Y Axis */}
                <div className="rounded-lg bg-[#121317] border border-white/[0.06] p-2.5 space-y-2">
                  <div className="text-[11px] font-semibold text-zinc-300">
                    Y-Axis (Rows · {rows})
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={yAddrText}
                      onChange={(e) => setYAddrText(e.target.value)}
                      placeholder="0x… (index)"
                      className={`${inputCls} w-28 font-mono`}
                    />
                    <select
                      value={yBits}
                      onChange={(e) => setYBits(Number(e.target.value))}
                      className={`${inputCls} w-20 font-mono cursor-pointer`}
                    >
                      <option value={8}>8-bit</option>
                      <option value={16}>16-bit</option>
                      <option value={32}>32-bit</option>
                    </select>
                    {pillToggle('Signed', ySigned, () => setYSigned((v) => !v))}
                    {pillToggle('Float', yIsFloat, () => setYIsFloat((v) => !v))}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={yEq}
                      onChange={(e) => setYEq(e.target.value)}
                      placeholder="Equation (e.g. X * 0.0234)"
                      className={`${inputCls} flex-1 font-mono`}
                    />
                    <input
                      type="text"
                      value={yUnits}
                      onChange={(e) => setYUnits(e.target.value)}
                      placeholder="%, load"
                      className={`${inputCls} w-24`}
                    />
                  </div>
                </div>
              </section>
            )}

            {/* Flag Bitmask Card */}
            {kind === 'flag' && (
              <section className="rounded-xl bg-[#17181d] border border-white/[0.065] p-3.5 space-y-2.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                  <ToggleLeft className="w-3.5 h-3.5 text-[#0a84ff]" />
                  Bitmask Configuration
                </div>
                <div className="grid grid-cols-[88px_1fr] items-center gap-2.5">
                  <label className="text-[11.5px] text-zinc-400">Mask</label>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={flagMaskText}
                      onChange={(e) => setFlagMaskText(e.target.value)}
                      className={`${inputCls} w-24 font-mono`}
                    />
                    {bits === 8 && (
                      <div className="flex items-center gap-1">
                        {[7, 6, 5, 4, 3, 2, 1, 0].map((bit) => {
                          const isSet = ((parsedFlagMask >>> 0) & (1 << bit)) !== 0;
                          return (
                            <button
                              key={bit}
                              type="button"
                              onClick={() => {
                                const toggled = (parsedFlagMask >>> 0) ^ (1 << bit);
                                const next = toggled === 0 ? 1 << bit : toggled;
                                setFlagMaskText(`0x${next.toString(16).toUpperCase().padStart(2, '0')}`);
                              }}
                              className={`w-6 h-6 rounded text-[10.5px] font-mono font-semibold transition-colors cursor-pointer ${
                                isSet
                                  ? 'bg-[#0a84ff] text-white'
                                  : 'bg-white/[0.06] text-zinc-400 hover:bg-white/[0.12]'
                              }`}
                              title={`Toggle bit ${bit}`}
                            >
                              {bit}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <label className="text-[11.5px] text-zinc-400">Logic</label>
                  <label className="inline-flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={flagInvert}
                      onChange={(e) => setFlagInvert(e.target.checked)}
                      className="rounded accent-[#0a84ff]"
                    />
                    Inverted (0 = Enabled, 1 = Disabled)
                  </label>
                </div>
              </section>
            )}
          </div>

          {/* Right Column: Live Decoded Preview */}
          <aside className="w-[312px] shrink-0 border-l border-white/[0.065] bg-[#121317] overflow-y-auto p-4 space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                <Eye className="w-3.5 h-3.5 text-[#0a84ff]" />
                Live Preview
              </div>
              {kind === 'patch' ? (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-[#0a84ff]/15 text-sky-300">
                  XDFPATCH
                </span>
              ) : activeLayout ? (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-[#0a84ff]/15 text-sky-300">
                  {activeLayout.isFloat ? 'F32' : `${activeLayout.bits}b`}{' '}
                  {activeLayout.lsbFirst ? 'LE' : 'BE'}
                </span>
              ) : null}
            </div>

            {!preview ? (
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-6 text-center space-y-2">
                <TriangleAlert className="w-5 h-5 text-amber-400 mx-auto" />
                <div className="text-xs text-zinc-400">
                  {bin.length === 0
                    ? 'No BIN file loaded.'
                    : kind === 'patch'
                      ? 'Enter at least one valid address and hex patch bytes.'
                      : 'Invalid address or offset outside BIN range.'}
                </div>
              </div>
            ) : preview.kind === 'patch' ? (
              <div className="space-y-2.5">
                <div className="grid grid-cols-2 gap-1.5">
                  <div className="rounded-lg bg-[#17181d] border border-white/[0.065] px-2.5 py-2">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500">Entries</div>
                    <div className="text-xs font-mono font-semibold text-zinc-100">
                      {preview.items.length} ({preview.totalBytes} B)
                    </div>
                  </div>
                  <div className="rounded-lg bg-[#17181d] border border-white/[0.065] px-2.5 py-2">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500">Applied</div>
                    <div className="text-xs font-mono font-semibold text-emerald-300">
                      {preview.appliedCount} / {preview.items.length}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  {preview.items.map((it) => (
                    <div
                      key={it.idx}
                      className="rounded-lg bg-[#17181d] border border-white/[0.065] p-2.5 space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-mono font-semibold text-zinc-200 truncate">
                          {formatHex(it.entry.address)}
                          {it.entry.name ? ` · ${it.entry.name}` : ''}
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[9.5px] font-semibold uppercase ${
                            it.status === 'applied'
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : it.status === 'base'
                                ? 'bg-white/[0.06] text-zinc-400'
                                : it.status === 'oob'
                                  ? 'bg-rose-500/15 text-rose-300'
                                  : 'bg-amber-500/15 text-amber-300'
                          }`}
                        >
                          {it.status === 'applied'
                            ? 'Applied'
                            : it.status === 'base'
                              ? 'Base'
                              : it.status === 'oob'
                                ? 'OOB'
                                : 'Custom'}
                        </span>
                      </div>
                      <div className="text-[10px] font-mono text-zinc-400 break-all">
                        <span className="text-zinc-500">BIN: </span>
                        {it.currentBytes.length > 0 ? bytesToHexStr(it.currentBytes) : '—'}
                      </div>
                      <div className="text-[10px] font-mono text-sky-300 break-all">
                        <span className="text-zinc-500">PAT: </span>
                        {bytesToHexStr(it.entry.patchBytes)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : preview.kind === 'table' ? (
              <>
                {/* Jewel-Tile Mini-Heatmap / 1D Curve */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[10.5px] text-zinc-400">
                    <span>
                      {activeLayout && (activeLayout.rows === 1 || activeLayout.cols === 1)
                        ? `1D Curve (${activeLayout.rows}×${activeLayout.cols})`
                        : `2D Mini-Heatmap (${activeLayout?.rows}×${activeLayout?.cols})`}
                    </span>
                    {activeLayout && (activeLayout.rows > 24 || activeLayout.cols > 24) && (
                      <span className="text-zinc-500">24×24 sample</span>
                    )}
                  </div>
                  <div className="rounded-xl overflow-hidden border border-white/[0.08] bg-[#0c0d10]">
                    <canvas
                      ref={previewCanvasRef}
                      className="block w-full h-[128px]"
                      style={{ width: 276, height: 128 }}
                    />
                  </div>
                </div>

                {/* Min / Avg / Max KPI Strip */}
                <div className="grid grid-cols-3 gap-1.5">
                  {[
                    ['Min', preview.min],
                    ['Avg', preview.avg],
                    ['Max', preview.max],
                  ].map(([lbl, val]) => (
                    <div
                      key={lbl as string}
                      className="rounded-lg bg-[#17181d] border border-white/[0.065] px-2.5 py-2"
                    >
                      <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                        {lbl as string}
                      </div>
                      <div className="text-[11.5px] font-mono font-semibold tabular-nums text-zinc-100 truncate">
                        {scalingFormat(activeScaling, val as number)}
                        {activeScaling.units ? ` ${activeScaling.units}` : ''}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Decoded First Cells (4×4 extract) */}
                <div className="space-y-1.5">
                  <div className="text-[10.5px] font-medium text-zinc-400">
                    Decoded First Cells ({preview.sampleCells.length}×
                    {preview.sampleCells[0]?.length ?? 0})
                  </div>
                  <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-1.5 space-y-1">
                    {preview.sampleCells.map((sRow, rIdx) => (
                      <div key={rIdx} className="grid gap-1" style={{ gridTemplateColumns: `repeat(${sRow.length}, minmax(0, 1fr))` }}>
                        {sRow.map((cell, cIdx) => {
                          const [red, green, blue] = thermalRgb(cell.norm);
                          return (
                            <div
                              key={cIdx}
                              style={{
                                backgroundColor: `rgba(${red}, ${green}, ${blue}, 0.24)`,
                                borderColor: `rgba(${red}, ${green}, ${blue}, 0.35)`,
                              }}
                              className="px-1.5 py-1 rounded text-[10px] font-mono tabular-nums text-right text-zinc-100 border truncate"
                            >
                              {cell.text}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Axis Preview */}
                {(preview.xSummary || preview.ySummary) && (
                  <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-2.5 space-y-1">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      Axis Preview
                    </div>
                    {preview.xSummary && (
                      <div className="text-[11px] font-mono text-zinc-200 truncate">
                        <span className="text-zinc-500">X: </span>
                        {preview.xSummary}
                      </div>
                    )}
                    {preview.ySummary && (
                      <div className="text-[11px] font-mono text-zinc-200 truncate">
                        <span className="text-zinc-500">Y: </span>
                        {preview.ySummary}
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : preview.kind === 'constant' ? (
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-5 text-center space-y-2">
                <div className="text-2xl font-mono font-bold tabular-nums text-[#0a84ff] truncate">
                  {preview.formatted}
                  {activeScaling.units ? ` ${activeScaling.units}` : ''}
                </div>
                <div className="text-[11px] font-mono text-zinc-400">
                  Raw: {Math.round(preview.raw)} ({formatHex(Math.max(0, Math.round(preview.raw)))})
                </div>
              </div>
            ) : (
              <div className="rounded-xl bg-[#17181d] border border-white/[0.065] p-5 text-center space-y-3">
                <div
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold ${
                    preview.active
                      ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                      : 'bg-white/[0.06] text-zinc-400 border border-white/[0.08]'
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      preview.active ? 'bg-emerald-400' : 'bg-zinc-500'
                    }`}
                  />
                  {preview.active ? 'ACTIVE (ON)' : 'INACTIVE (OFF)'}
                </div>
                <div className="text-[11px] font-mono text-zinc-400">
                  Byte: 0x{preview.uval.toString(16).toUpperCase().padStart(2, '0')} · Mask:{' '}
                  {formatHex(preview.mask)}
                </div>
              </div>
            )}
          </aside>
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2.5 border-t border-white/[0.065] bg-[#17181d]">
          <div className="flex items-center gap-1.5 text-[11.5px] min-w-0">
            {!title.trim() ? (
              <span className="inline-flex items-center gap-1.5 text-amber-400">
                <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
                Enter a title to save
              </span>
            ) : kind === 'patch' && !parsedPatchEntries.valid ? (
              <span className="inline-flex items-center gap-1.5 text-rose-400">
                <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
                Each patch entry requires a valid hex address and patch bytes
              </span>
            ) : kind !== 'patch' && parsedAddress === null ? (
              <span className="inline-flex items-center gap-1.5 text-rose-400">
                <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
                Invalid hex address
              </span>
            ) : kind !== 'patch' && !parsedEquationValid ? (
              <span className="inline-flex items-center gap-1.5 text-rose-400">
                <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
                Invalid scaling equation syntax
              </span>
            ) : isOutOfBounds ? (
              <span className="inline-flex items-center gap-1.5 text-amber-400">
                <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
                Byte range exceeds loaded BIN size ({bin.length} bytes)
              </span>
            ) : (
              <span className="text-zinc-500 truncate">
                Changes apply immediately to the active XDF definition.
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.05] hover:bg-white/[0.1] text-zinc-300 hover:text-white transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canSave}
              onClick={handleSave}
              className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-[#0a84ff] hover:bg-[#1e8fff] disabled:opacity-40 disabled:cursor-not-allowed text-white shadow-[0_1px_8px_rgba(10,132,255,0.4)] transition-colors cursor-pointer"
            >
              {item ? 'Save Changes' : 'Create Item'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default XdfEditorModal;
