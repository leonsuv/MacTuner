import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Flame,
  Gauge,
  Grid3x3,
  ScatterChart,
  Sparkles,
  Upload,
  Wand2,
} from 'lucide-react';
import {
  BinCodec,
  cellOffset,
  createMed17DemoBundle,
  elementBytes,
  scalingFormat,
  scalingRawFor,
  scalingValue,
  type Patch,
  type XDFDefinition,
  type XDFItem,
} from '@mactuner/core';

export interface DatalogViewProps {
  xdf?: XDFDefinition | null;
  bin?: Uint8Array;
  onApplyPatches?: (patches: Patch[], label: string) => void;
}

export interface DatalogChannel {
  key: string;
  label: string;
  unit: string;
  color: string;
  min: number;
  max: number;
  decimals: number;
  values: number[];
}

export interface DatalogSession {
  name: string;
  sampleRateHz: number;
  timestamps: number[];
  channels: DatalogChannel[];
}

type DatalogMode = 'timeseries' | 'scatter' | 'dyno' | 'autotune';
type AutoTuneTargetMode = 'lambda' | 'boost' | 'hits';

interface AutoTuneSuggestion {
  key: string;
  r: number;
  c: number;
  xLabel: string;
  yLabel: string;
  hits: number;
  avgMeasured: number;
  targetValue: number;
  currentValue: number;
  suggestedValue: number;
  deltaPercent: number;
}

interface DynoPoint {
  rpm: number;
  hp: number;
  torqueNm: number;
  boost: number | null;
  speedKmh: number;
}

const CHANNEL_COLORS = ['#0a84ff', '#f59e0b', '#10b981', '#ec4899', '#a855f7', '#06b6d4'];

function thermalColor(tRaw: number): string {
  const t = Math.max(0, Math.min(1, Number.isFinite(tRaw) ? tRaw : 0.5));
  const stops: [number, number, number][] = [
    [30, 100, 235],
    [20, 184, 218],
    [16, 185, 129],
    [245, 158, 11],
    [239, 68, 68],
  ];
  const scaled = t * (stops.length - 1);
  const idx = Math.min(stops.length - 2, Math.floor(scaled));
  const frac = scaled - idx;
  const a = stops[idx];
  const b = stops[idx + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * frac)}, ${Math.round(a[1] + (b[1] - a[1]) * frac)}, ${Math.round(a[2] + (b[2] - a[2]) * frac)})`;
}

/**
 * Generates a realistic 20 Hz 3rd-gear WOT dyno pull (7.5 s, 150 samples) with
 * nonlinear turbo spool, torque curve, lambda enrichment, timing pull & ramp,
 * and aerodynamic drag-curved acceleration.
 */
function createRealisticWotPull(): DatalogSession {
  const sampleRateHz = 20;
  const totalSamples = 150;
  const timestamps: number[] = [];
  const rpm: number[] = [];
  const boost: number[] = [];
  const load: number[] = [];
  const lambda: number[] = [];
  const timing: number[] = [];
  const speed: number[] = [];

  let curRpm = 2150;
  let curBoost = 0.08;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRateHz;
    timestamps.push(t);

    const wot =
      t < 0.45
        ? 0
        : t > 6.65
          ? Math.max(0, 1 - (t - 6.65) * 3.5)
          : Math.min(1, (t - 0.45) / 0.25);

    const normRpm = Math.max(0, Math.min(1, (curRpm - 2000) / 5000));
    const torqueShape = Math.sin(Math.pow(normRpm, 0.72) * Math.PI * 0.92);

    const targetBoost =
      wot > 0.2
        ? (1.58 * Math.min(1, (curRpm - 1800) / 1450) - 0.24 * Math.max(0, normRpm - 0.68)) * wot
        : -0.58;
    const spoolRate = targetBoost > curBoost ? 0.16 : 0.34;
    curBoost += (targetBoost - curBoost) * spoolRate;
    const boostRipple = Math.sin(t * 17.5) * 0.014 * wot;
    const boostVal = Math.max(-0.7, curBoost + boostRipple);

    const accel =
      wot > 0.1
        ? (420 + 610 * torqueShape * Math.max(0.25, (boostVal + 0.5) / 1.9) - 140 * normRpm * normRpm) * wot
        : -680 * (curRpm > 2300 ? 1 : 0.2);
    curRpm = Math.max(1950, Math.min(6980, curRpm + accel / sampleRateHz));

    const loadVal = Math.max(
      18,
      Math.min(225, 34 + (boostVal + 0.6) * 84 * (0.85 + 0.2 * torqueShape) + Math.sin(t * 9.2) * 1.4),
    );

    const lambdaVal =
      t > 6.75
        ? Math.min(1.65, 0.84 + (t - 6.75) * 1.4)
        : 1.0 - wot * (0.14 + 0.08 * normRpm) + Math.sin(t * 13) * 0.006;

    const peakCylDip = Math.exp(-Math.pow((curRpm - 3850) / 850, 2)) * 5.2;
    const timingVal =
      wot > 0.2
        ? 11.5 - peakCylDip + 7.2 * Math.pow(normRpm, 1.35) + Math.sin(t * 11) * 0.25
        : 24.0 - normRpm * 4.0;

    const speedVal = curRpm * 0.0248;

    rpm.push(Math.round(curRpm));
    boost.push(Number(boostVal.toFixed(2)));
    load.push(Number(loadVal.toFixed(1)));
    lambda.push(Number(lambdaVal.toFixed(3)));
    timing.push(Number(timingVal.toFixed(1)));
    speed.push(Number(speedVal.toFixed(1)));
  }

  return {
    name: '3rd Gear WOT Dyno Pull (20 Hz Sample)',
    sampleRateHz,
    timestamps,
    channels: [
      { key: 'rpm', label: 'Engine RPM', unit: 'rpm', color: '#0a84ff', min: 1500, max: 7500, decimals: 0, values: rpm },
      { key: 'boost', label: 'Boost Pressure', unit: 'bar', color: '#f59e0b', min: -0.8, max: 2.0, decimals: 2, values: boost },
      { key: 'load', label: 'Engine Load', unit: '%', color: '#10b981', min: 0, max: 240, decimals: 1, values: load },
      { key: 'lambda', label: 'Lambda (AFR)', unit: 'λ', color: '#ec4899', min: 0.65, max: 1.7, decimals: 3, values: lambda },
      { key: 'timing', label: 'Ignition Timing', unit: '°BTDC', color: '#a855f7', min: 0, max: 30, decimals: 1, values: timing },
      { key: 'speed', label: 'Vehicle Speed', unit: 'km/h', color: '#06b6d4', min: 0, max: 200, decimals: 1, values: speed },
    ],
  };
}

function parseCsvDatalog(text: string, name: string): DatalogSession | null {
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 3) return null;

  const sep = lines[0].includes(';') ? ';' : lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(sep).map((h) => h.trim().replace(/^"|"$/g, ''));
  if (headers.length < 2) return null;

  const cols: number[][] = headers.map(() => []);
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(sep);
    if (parts.length < 2) continue;
    for (let c = 0; c < headers.length; c++) {
      const v = parseFloat((parts[c] ?? '').replace(',', '.'));
      cols[c].push(Number.isFinite(v) ? v : 0);
    }
  }

  const timeIdx = headers.findIndex((h) => /time|sec|ms|timestamp/i.test(h));
  const timestamps =
    timeIdx >= 0 ? cols[timeIdx] : cols[0].map((_, idx) => idx * 0.05);

  const channels: DatalogChannel[] = [];
  for (let c = 0; c < headers.length; c++) {
    if (c === timeIdx) continue;
    const vals = cols[c];
    if (vals.length === 0) continue;
    let min = Infinity;
    let max = -Infinity;
    for (const v of vals) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.08;
    channels.push({
      key: `ch-${c}`,
      label: headers[c] || `Channel ${c + 1}`,
      unit: '',
      color: CHANNEL_COLORS[channels.length % CHANNEL_COLORS.length],
      min: min - pad,
      max: max + pad,
      decimals: max - min < 5 ? 3 : max - min < 50 ? 1 : 0,
      values: vals,
    });
  }

  if (channels.length === 0) return null;
  const dt =
    timestamps.length > 1
      ? Math.max(0.001, (timestamps[timestamps.length - 1] - timestamps[0]) / (timestamps.length - 1))
      : 0.05;
  return {
    name,
    sampleRateHz: Math.round(1 / dt),
    timestamps,
    channels,
  };
}

function smoothArray(values: number[], windowRadius: number): number[] {
  if (windowRadius <= 0 || values.length < 3) return values;
  return values.map((_, i) => {
    let sum = 0;
    let count = 0;
    const lo = Math.max(0, i - windowRadius);
    const hi = Math.min(values.length - 1, i + windowRadius);
    for (let k = lo; k <= hi; k++) {
      sum += values[k];
      count++;
    }
    return sum / Math.max(1, count);
  });
}

function computeVirtualDyno(
  session: DatalogSession,
  massKg: number,
  cda: number,
  drivetrainLossPct: number,
  showCrank: boolean,
  smoothRadius: number,
): {
  points: DynoPoint[];
  peakHp: { value: number; rpm: number };
  peakTorque: { value: number; rpm: number };
  peakBoost: number | null;
  pullDurationSec: number;
} {
  const rpmCh =
    session.channels.find((c) => /rpm|engine speed|nmot/i.test(c.label) || c.key === 'rpm') ??
    session.channels[0];
  const speedCh = session.channels.find(
    (c) => /speed|vss|km\/h|kmh|mph/i.test(c.label) || c.key === 'speed',
  );
  const boostCh = session.channels.find(
    (c) => /boost|map|pressure|pvdks/i.test(c.label) || c.key === 'boost',
  );

  if (!rpmCh || session.timestamps.length < 5) {
    return {
      points: [],
      peakHp: { value: 0, rpm: 0 },
      peakTorque: { value: 0, rpm: 0 },
      peakBoost: null,
      pullDurationSec: 0,
    };
  }

  const n = session.timestamps.length;
  const rpms = rpmCh.values;
  const speedsKmh = speedCh ? speedCh.values : rpms.map((r) => r * 0.0248);

  // Find longest contiguous rising-RPM WOT pull segment
  let bestStart = 0;
  let bestEnd = 0;
  let curStart = 0;
  for (let i = 1; i < n; i++) {
    if (rpms[i] > rpms[i - 1] + 2) {
      if (i - curStart > bestEnd - bestStart) {
        bestStart = curStart;
        bestEnd = i;
      }
    } else {
      curStart = i;
    }
  }

  if (bestEnd - bestStart < 5) {
    bestStart = 0;
    bestEnd = n - 1;
  }

  const sliceLen = bestEnd - bestStart + 1;
  const sliceT = session.timestamps.slice(bestStart, bestEnd + 1);
  const sliceRpm = rpms.slice(bestStart, bestEnd + 1);
  const sliceVms = smoothArray(
    speedsKmh.slice(bestStart, bestEnd + 1).map((k) => k / 3.6),
    smoothRadius,
  );
  const sliceBoost = boostCh ? boostCh.values.slice(bestStart, bestEnd + 1) : null;

  const rawHp: number[] = [];
  const rawNm: number[] = [];
  const validIndices: number[] = [];
  const lossFactor = showCrank ? 1 / Math.max(0.5, 1 - drivetrainLossPct / 100) : 1;

  for (let i = 1; i < sliceLen - 1; i++) {
    const dt = sliceT[i + 1] - sliceT[i - 1];
    if (dt <= 0.001) continue;
    const v = sliceVms[i];
    const a = (sliceVms[i + 1] - sliceVms[i - 1]) / dt;
    if (a <= 0.05 || sliceRpm[i] < 500) continue;

    const fAccel = massKg * a;
    const fRoll = 0.015 * massKg * 9.80665;
    const fAero = 0.5 * 1.225 * cda * v * v;
    const watts = Math.max(0, (fAccel + fRoll + fAero) * v) * lossFactor;
    const hp = watts / 745.7;
    const torqueNm = (watts * 60) / (2 * Math.PI * sliceRpm[i]);

    rawHp.push(hp);
    rawNm.push(torqueNm);
    validIndices.push(i);
  }

  const smHp = smoothArray(rawHp, smoothRadius);
  const smNm = smoothArray(rawNm, smoothRadius);

  const points: DynoPoint[] = validIndices.map((idx, k) => ({
    rpm: sliceRpm[idx],
    hp: Number(smHp[k].toFixed(1)),
    torqueNm: Number(smNm[k].toFixed(1)),
    boost: sliceBoost ? sliceBoost[idx] : null,
    speedKmh: sliceVms[idx] * 3.6,
  }));

  let peakHp = { value: 0, rpm: 0 };
  let peakTorque = { value: 0, rpm: 0 };
  let peakBoost: number | null = null;

  for (const pt of points) {
    if (pt.hp > peakHp.value) peakHp = { value: pt.hp, rpm: pt.rpm };
    if (pt.torqueNm > peakTorque.value) peakTorque = { value: pt.torqueNm, rpm: pt.rpm };
    if (pt.boost !== null && (peakBoost === null || pt.boost > peakBoost)) {
      peakBoost = pt.boost;
    }
  }

  const pullDurationSec =
    sliceT.length > 1 ? Math.max(0, sliceT[sliceT.length - 1] - sliceT[0]) : 0;

  return { points, peakHp, peakTorque, peakBoost, pullDurationSec };
}

function nearestAxisIndex(axisValues: number[], sampleVal: number): number {
  if (axisValues.length === 0) return 0;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < axisValues.length; i++) {
    const d = Math.abs(axisValues[i] - sampleVal);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export const DatalogView: React.FC<DatalogViewProps> = ({
  xdf: propXdf = null,
  bin: propBin,
  onApplyPatches,
}) => {
  const [session, setSession] = useState<DatalogSession>(() => createRealisticWotPull());
  const [mode, setMode] = useState<DatalogMode>('timeseries');
  const [enabledKeys, setEnabledKeys] = useState<Set<string>>(
    () => new Set(['rpm', 'boost', 'load', 'lambda', 'timing', 'speed']),
  );
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Scatterplot selectors
  const [scatterXKey, setScatterXKey] = useState<string>('rpm');
  const [scatterYKey, setScatterYKey] = useState<string>('boost');
  const [scatterZKey, setScatterZKey] = useState<string>('timing');
  const [scatterHoverIdx, setScatterHoverIdx] = useState<number | null>(null);

  // Virtual Dyno vehicle params
  const [massKg, setMassKg] = useState<number>(1450);
  const [cda, setCda] = useState<number>(0.68);
  const [drivetrainLossPct, setDrivetrainLossPct] = useState<number>(12);
  const [showCrank, setShowCrank] = useState<boolean>(false);
  const [smoothRadius, setSmoothRadius] = useState<number>(3);
  const [dynoHoverIdx, setDynoHoverIdx] = useState<number | null>(null);

  // Map Hit-Overlay & Auto-Tune state
  const [demoFallback, setDemoFallback] = useState<{
    xdf: XDFDefinition;
    bin: Uint8Array;
  } | null>(null);
  const effectiveXdf = propXdf ?? demoFallback?.xdf ?? null;
  const effectiveBin = propBin ?? demoFallback?.bin ?? null;

  const tableItems = useMemo<XDFItem[]>(
    () => (effectiveXdf ? effectiveXdf.items.filter((it) => it.itemKind.kind === 'table') : []),
    [effectiveXdf],
  );
  const [selectedMapId, setSelectedMapId] = useState<number | null>(null);
  const [autoTuneTarget, setAutoTuneTarget] = useState<AutoTuneTargetMode>('lambda');
  const [autoTuneDamping, setAutoTuneDamping] = useState<number>(0.6);
  const [autoTuneMinHits, setAutoTuneMinHits] = useState<number>(2);
  const [wotFilterOnly, setWotFilterOnly] = useState<boolean>(true);
  const [targetLambdaGoal, setTargetLambdaGoal] = useState<number>(0.82);
  const [targetBoostGoalBar, setTargetBoostGoalBar] = useState<number>(1.55);
  const [excludedCells, setExcludedCells] = useState<Set<string>>(() => new Set());
  const [hoveredCellKey, setHoveredCellKey] = useState<string | null>(null);
  const [autoTuneNotice, setAutoTuneNotice] = useState<string | null>(null);

  const activeMap = useMemo<XDFItem | null>(() => {
    if (tableItems.length === 0) return null;
    if (selectedMapId !== null) {
      const found = tableItems.find((t) => t.id === selectedMapId);
      if (found) return found;
    }
    if (autoTuneTarget === 'lambda') {
      const lam = tableItems.find((t) => /lambda|lamfa|afr/i.test(t.title));
      if (lam) return lam;
    } else if (autoTuneTarget === 'boost') {
      const bst = tableItems.find((t) => /boost|ldrxn|pressure/i.test(t.title));
      if (bst) return bst;
    }
    return tableItems[0];
  }, [tableItems, selectedMapId, autoTuneTarget]);

  // Compute live RPM x Load hit counts + target-lambda / boost Auto-Tune cell suggestions
  const autoTuneAnalysis = useMemo(() => {
    if (!activeMap || activeMap.itemKind.kind !== 'table' || !effectiveBin) {
      return null;
    }
    const l = activeMap.data;
    const xVals = BinCodec.axisValues(activeMap.itemKind.x, l.cols, effectiveBin);
    const yVals = BinCodec.axisValues(activeMap.itemKind.y, l.rows, effectiveBin);
    const xLabels = BinCodec.axisLabels(activeMap.itemKind.x, l.cols, effectiveBin);
    const yLabels = BinCodec.axisLabels(activeMap.itemKind.y, l.rows, effectiveBin);

    const rpmCh =
      session.channels.find((c) => /rpm|engine speed|nmot/i.test(c.label) || c.key === 'rpm') ??
      session.channels[0];
    const loadCh =
      session.channels.find((c) => /load|pedal|throttle|tps/i.test(c.label) || c.key === 'load') ??
      session.channels[2] ??
      session.channels[1];
    const lambdaCh = session.channels.find(
      (c) => /lambda|afr/i.test(c.label) || c.key === 'lambda',
    );
    const boostCh = session.channels.find(
      (c) => /boost|pressure|map/i.test(c.label) || c.key === 'boost',
    );

    const hits: number[][] = Array.from({ length: l.rows }, () => new Array<number>(l.cols).fill(0));
    const sumMeas: number[][] = Array.from({ length: l.rows }, () =>
      new Array<number>(l.cols).fill(0),
    );

    const maxYAxis = Math.max(...yVals, 1);
    const loadMax = loadCh ? Math.max(...loadCh.values, 1) : 100;
    const scaleLoadToY = maxYAxis <= 105 && loadMax > 115 ? maxYAxis / loadMax : 1;

    const n = session.timestamps.length;
    let totalHits = 0;

    for (let i = 0; i < n; i++) {
      const rpm = rpmCh?.values[i] ?? 0;
      const rawLoad = loadCh?.values[i] ?? 0;
      if (wotFilterOnly && rawLoad < 65) continue;

      const ySample = rawLoad * scaleLoadToY;
      const c = nearestAxisIndex(xVals, rpm);
      const r = nearestAxisIndex(yVals, ySample);
      hits[r][c]++;
      totalHits++;

      if (autoTuneTarget === 'lambda' && lambdaCh) {
        sumMeas[r][c] += lambdaCh.values[i];
      } else if (autoTuneTarget === 'boost' && boostCh) {
        // Convert gauge bar (e.g. 1.45 bar) to absolute mbar (2450 mbar) when map is in mbar
        const rawB = boostCh.values[i];
        const inMbar = /mbar|hpa/i.test(activeMap.scaling.units)
          ? rawB < 5
            ? 1000 + rawB * 1000
            : rawB
          : rawB;
        sumMeas[r][c] += inMbar;
      } else if (boostCh) {
        sumMeas[r][c] += boostCh.values[i];
      }
    }

    let maxCellHits = 0;
    let coveredCells = 0;
    const mapValues: number[][] = [];
    const suggestions: AutoTuneSuggestion[] = [];
    const suggestionMap = new Map<string, AutoTuneSuggestion>();

    for (let r = 0; r < l.rows; r++) {
      const rowVals: number[] = [];
      for (let c = 0; c < l.cols; c++) {
        const raw = BinCodec.raw(l, { r, c }, effectiveBin);
        const curVal = raw !== null ? scalingValue(activeMap.scaling, raw) : 0;
        rowVals.push(curVal);

        const h = hits[r][c];
        if (h > 0) coveredCells++;
        if (h > maxCellHits) maxCellHits = h;

        if (h >= autoTuneMinHits && autoTuneTarget !== 'hits') {
          const avgMeas = sumMeas[r][c] / h;
          let targetVal = curVal;
          let suggested = curVal;

          if (autoTuneTarget === 'lambda' && lambdaCh && avgMeas > 0.4 && avgMeas < 1.5) {
            // Compare measured lambda against desired goal (or map target if map is lambda)
            const isLambdaMap = /λ|lambda/i.test(activeMap.scaling.units) || (curVal > 0.5 && curVal < 1.3);
            targetVal = isLambdaMap ? targetLambdaGoal : curVal;
            const errRatio = targetVal / avgMeas;
            const dampedFactor = 1 + (errRatio - 1) * autoTuneDamping;
            suggested = isLambdaMap
              ? Math.max(0.72, Math.min(1.05, curVal * dampedFactor))
              : curVal * dampedFactor;
          } else if (autoTuneTarget === 'boost' && boostCh) {
            const isMbar = /mbar|hpa/i.test(activeMap.scaling.units);
            targetVal = isMbar ? 1000 + targetBoostGoalBar * 1000 : targetBoostGoalBar;
            if (avgMeas > 1e-3) {
              const delta = (targetVal - avgMeas) * autoTuneDamping;
              suggested = Math.max(isMbar ? 900 : 0, curVal + delta);
            }
          }

          const deltaPct = Math.abs(curVal) > 1e-6 ? ((suggested - curVal) / Math.abs(curVal)) * 100 : 0;
          if (Math.abs(deltaPct) >= 0.35) {
            const key = `${r}:${c}`;
            const sug: AutoTuneSuggestion = {
              key,
              r,
              c,
              xLabel: xLabels[c] ?? String(c),
              yLabel: yLabels[r] ?? String(r),
              hits: h,
              avgMeasured: avgMeas,
              targetValue: targetVal,
              currentValue: curVal,
              suggestedValue: suggested,
              deltaPercent: deltaPct,
            };
            suggestions.push(sug);
            suggestionMap.set(key, sug);
          }
        }
      }
      mapValues.push(rowVals);
    }

    suggestions.sort((a, b) => b.hits - a.hits || Math.abs(b.deltaPercent) - Math.abs(a.deltaPercent));

    return {
      xLabels,
      yLabels,
      hits,
      sumMeas,
      mapValues,
      maxCellHits,
      totalHits,
      coveredCells,
      suggestions,
      suggestionMap,
    };
  }, [
    activeMap,
    effectiveBin,
    session,
    wotFilterOnly,
    autoTuneTarget,
    autoTuneMinHits,
    autoTuneDamping,
    targetLambdaGoal,
    targetBoostGoalBar,
  ]);

  const handleApplyAutoTune = useCallback(() => {
    if (!activeMap || !effectiveBin || !autoTuneAnalysis) return;
    const selectedSugs = autoTuneAnalysis.suggestions.filter((s) => !excludedCells.has(s.key));
    if (selectedSugs.length === 0) return;

    const l = activeMap.data;
    const nb = elementBytes(l);
    const patches: Patch[] = [];

    for (const s of selectedSugs) {
      const nextRaw = scalingRawFor(activeMap.scaling, s.suggestedValue, l);
      if (nextRaw === null) continue;
      const off = cellOffset(l, { r: s.r, c: s.c });
      if (off < 0 || off + nb > effectiveBin.length) continue;
      const oldBytes = effectiveBin.slice(off, off + nb);
      const nextBytes = BinCodec.encode(l, nextRaw);
      let differs = false;
      for (let k = 0; k < nb; k++) {
        if (oldBytes[k] !== nextBytes[k]) {
          differs = true;
          break;
        }
      }
      if (differs) {
        patches.push({ offset: off, old: oldBytes, next: nextBytes });
      }
    }

    if (patches.length === 0) {
      setAutoTuneNotice('All selected cells are already within raw quantization step.');
      return;
    }

    if (onApplyPatches) {
      onApplyPatches(
        patches,
        `Auto-Tune ${activeMap.title} (${patches.length} cell${patches.length === 1 ? '' : 's'})`,
      );
      setAutoTuneNotice(
        `Applied ${patches.length} Auto-Tune cell correction(s) to ${activeMap.title} (undoable with ⌘Z).`,
      );
    } else if (demoFallback) {
      const nextBin = new Uint8Array(demoFallback.bin);
      for (const p of patches) nextBin.set(p.next, p.offset);
      setDemoFallback({ ...demoFallback, bin: nextBin });
      setAutoTuneNotice(
        `Applied ${patches.length} correction(s) to demo preview buffer (${activeMap.title}).`,
      );
    }
  }, [activeMap, effectiveBin, autoTuneAnalysis, excludedCells, onApplyPatches, demoFallback]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeChannels = useMemo(
    () => session.channels.filter((ch) => enabledKeys.has(ch.key)),
    [session.channels, enabledKeys],
  );

  const scatterXCh = useMemo(
    () => session.channels.find((c) => c.key === scatterXKey) ?? session.channels[0],
    [session.channels, scatterXKey],
  );
  const scatterYCh = useMemo(
    () => session.channels.find((c) => c.key === scatterYKey) ?? session.channels[1] ?? session.channels[0],
    [session.channels, scatterYKey],
  );
  const scatterZCh = useMemo(
    () => session.channels.find((c) => c.key === scatterZKey) ?? session.channels[2] ?? session.channels[0],
    [session.channels, scatterZKey],
  );

  const dynoData = useMemo(
    () => computeVirtualDyno(session, massKg, cda, drivetrainLossPct, showCrank, smoothRadius),
    [session, massKg, cda, drivetrainLossPct, showCrank, smoothRadius],
  );

  const loadCsvFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseCsvDatalog(String(reader.result ?? ''), file.name);
      if (parsed) {
        setSession(parsed);
        setEnabledKeys(new Set(parsed.channels.slice(0, 6).map((c) => c.key)));
        setScatterXKey(parsed.channels[0]?.key ?? '');
        setScatterYKey(parsed.channels[1]?.key ?? parsed.channels[0]?.key ?? '');
        setScatterZKey(parsed.channels[2]?.key ?? parsed.channels[0]?.key ?? '');
        setHoverIdx(null);
        setScatterHoverIdx(null);
        setDynoHoverIdx(null);
      }
    };
    reader.readAsText(file);
  }, []);

  const handleLoadSample = () => {
    const sample = createRealisticWotPull();
    setSession(sample);
    setEnabledKeys(new Set(sample.channels.map((c) => c.key)));
    setScatterXKey('rpm');
    setScatterYKey('boost');
    setScatterZKey('timing');
    setHoverIdx(null);
    setScatterHoverIdx(null);
    setDynoHoverIdx(null);
  };

  const toggleChannel = (key: string) => {
    setEnabledKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // High-DPI Canvas Renderer for all 3 modes
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const draw = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width));
      const height = Math.max(260, Math.floor(rect.height));
      const dpr = window.devicePixelRatio || 1;

      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);

      // Obsidian background
      ctx.fillStyle = '#0c0d10';
      ctx.fillRect(0, 0, width, height);

      if (mode === 'timeseries') {
        const padL = 46;
        const padR = 20;
        const padT = 18;
        const padB = 30;
        const plotW = width - padL - padR;
        const plotH = height - padT - padB;

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.055)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 5; i++) {
          const y = padT + (plotH * i) / 5;
          ctx.beginPath();
          ctx.moveTo(padL, y);
          ctx.lineTo(padL + plotW, y);
          ctx.stroke();

          ctx.fillStyle = 'rgba(161, 161, 170, 0.55)';
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.textAlign = 'right';
          ctx.fillText(`${100 - i * 20}%`, padL - 8, y + 3);
        }

        const n = session.timestamps.length;
        const tMin = session.timestamps[0] ?? 0;
        const tMax = session.timestamps[n - 1] ?? 1;
        const tSpan = Math.max(0.001, tMax - tMin);

        for (let i = 0; i <= 6; i++) {
          const x = padL + (plotW * i) / 6;
          ctx.beginPath();
          ctx.moveTo(x, padT);
          ctx.lineTo(x, padT + plotH);
          ctx.stroke();

          const tLabel = tMin + (tSpan * i) / 6;
          ctx.fillStyle = 'rgba(161, 161, 170, 0.65)';
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(`${tLabel.toFixed(1)}s`, x, height - 10);
        }

        for (const ch of activeChannels) {
          const span = Math.max(1e-6, ch.max - ch.min);
          ctx.strokeStyle = ch.color;
          ctx.lineWidth = 2;
          ctx.lineJoin = 'round';
          ctx.beginPath();

          for (let i = 0; i < n; i++) {
            const x = padL + ((session.timestamps[i] - tMin) / tSpan) * plotW;
            const norm = Math.max(0, Math.min(1, (ch.values[i] - ch.min) / span));
            const y = padT + plotH * (1 - norm);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }

        if (hoverIdx !== null && hoverIdx >= 0 && hoverIdx < n) {
          const x = padL + ((session.timestamps[hoverIdx] - tMin) / tSpan) * plotW;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(x, padT);
          ctx.lineTo(x, padT + plotH);
          ctx.stroke();
          ctx.setLineDash([]);

          for (const ch of activeChannels) {
            const span = Math.max(1e-6, ch.max - ch.min);
            const norm = Math.max(0, Math.min(1, (ch.values[hoverIdx] - ch.min) / span));
            const y = padT + plotH * (1 - norm);
            ctx.fillStyle = ch.color;
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#0c0d10';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
      } else if (mode === 'scatter' && scatterXCh && scatterYCh && scatterZCh) {
        const padL = 56;
        const padR = 26;
        const padT = 22;
        const padB = 38;
        const plotW = width - padL - padR;
        const plotH = height - padT - padB;

        const xSpan = Math.max(1e-6, scatterXCh.max - scatterXCh.min);
        const ySpan = Math.max(1e-6, scatterYCh.max - scatterYCh.min);
        const zSpan = Math.max(1e-6, scatterZCh.max - scatterZCh.min);

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.055)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 5; i++) {
          const y = padT + (plotH * i) / 5;
          ctx.beginPath();
          ctx.moveTo(padL, y);
          ctx.lineTo(padL + plotW, y);
          ctx.stroke();

          const yVal = scatterYCh.max - (ySpan * i) / 5;
          ctx.fillStyle = 'rgba(161, 161, 170, 0.65)';
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.textAlign = 'right';
          ctx.fillText(yVal.toFixed(scatterYCh.decimals), padL - 8, y + 3);
        }

        for (let i = 0; i <= 6; i++) {
          const x = padL + (plotW * i) / 6;
          ctx.beginPath();
          ctx.moveTo(x, padT);
          ctx.lineTo(x, padT + plotH);
          ctx.stroke();

          const xVal = scatterXCh.min + (xSpan * i) / 6;
          ctx.fillStyle = 'rgba(161, 161, 170, 0.65)';
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(xVal.toFixed(scatterXCh.decimals), x, height - 14);
        }

        // Axis titles
        ctx.fillStyle = 'rgba(212, 212, 216, 0.7)';
        ctx.font = '10.5px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(
          `${scatterXCh.label}${scatterXCh.unit ? ` (${scatterXCh.unit})` : ''}`,
          padL + plotW / 2,
          height - 2,
        );

        const n = Math.min(scatterXCh.values.length, scatterYCh.values.length, scatterZCh.values.length);
        for (let i = 0; i < n; i++) {
          const nx = (scatterXCh.values[i] - scatterXCh.min) / xSpan;
          const ny = (scatterYCh.values[i] - scatterYCh.min) / ySpan;
          const nz = (scatterZCh.values[i] - scatterZCh.min) / zSpan;
          const px = padL + Math.max(0, Math.min(1, nx)) * plotW;
          const py = padT + (1 - Math.max(0, Math.min(1, ny))) * plotH;
          const isHov = scatterHoverIdx === i;

          ctx.fillStyle = thermalColor(nz);
          ctx.globalAlpha = isHov ? 1 : 0.85;
          ctx.beginPath();
          ctx.arc(px, py, isHov ? 6 : 4, 0, Math.PI * 2);
          ctx.fill();
          if (isHov) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      } else if (mode === 'dyno') {
        const padL = 56;
        const padR = 56;
        const padT = 26;
        const padB = 38;
        const plotW = width - padL - padR;
        const plotH = height - padT - padB;
        const pts = dynoData.points;

        if (pts.length < 2) {
          ctx.fillStyle = 'rgba(161, 161, 170, 0.7)';
          ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(
            'No accelerating WOT pull detected — load the 20 Hz WOT Pull or a CSV with RPM & Speed.',
            width / 2,
            height / 2,
          );
          return;
        }

        const rpmMin = Math.floor(pts[0].rpm / 500) * 500;
        const rpmMax = Math.ceil(pts[pts.length - 1].rpm / 500) * 500;
        const rpmSpan = Math.max(500, rpmMax - rpmMin);

        const maxVal = Math.max(
          100,
          Math.ceil(Math.max(dynoData.peakHp.value, dynoData.peakTorque.value) / 50) * 50,
        );

        // Horizontal grid + Left (HP) & Right (Nm) axes
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.055)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 5; i++) {
          const y = padT + (plotH * i) / 5;
          ctx.beginPath();
          ctx.moveTo(padL, y);
          ctx.lineTo(padL + plotW, y);
          ctx.stroke();

          const val = Math.round(maxVal - (maxVal * i) / 5);
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.fillStyle = 'rgba(56, 189, 248, 0.78)';
          ctx.textAlign = 'right';
          ctx.fillText(`${val}`, padL - 8, y + 3);

          ctx.fillStyle = 'rgba(251, 191, 36, 0.78)';
          ctx.textAlign = 'left';
          ctx.fillText(`${val}`, padL + plotW + 8, y + 3);
        }

        // Axis corner headers
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = '#38bdf8';
        ctx.textAlign = 'right';
        ctx.fillText(showCrank ? 'BHP' : 'WHP', padL - 8, padT - 10);
        ctx.fillStyle = '#fbbf24';
        ctx.textAlign = 'left';
        ctx.fillText('Nm', padL + plotW + 8, padT - 10);

        // Vertical RPM grid
        const rpmSteps = 6;
        for (let i = 0; i <= rpmSteps; i++) {
          const x = padL + (plotW * i) / rpmSteps;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.055)';
          ctx.beginPath();
          ctx.moveTo(x, padT);
          ctx.lineTo(x, padT + plotH);
          ctx.stroke();

          const rLabel = Math.round(rpmMin + (rpmSpan * i) / rpmSteps);
          ctx.fillStyle = 'rgba(161, 161, 170, 0.65)';
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(`${rLabel}`, x, height - 14);
        }
        ctx.fillStyle = 'rgba(212, 212, 216, 0.6)';
        ctx.font = '10.5px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Engine Speed (RPM)', padL + plotW / 2, height - 2);

        const toX = (rpm: number) => padL + ((rpm - rpmMin) / rpmSpan) * plotW;
        const toY = (v: number) => padT + (1 - Math.max(0, Math.min(1, v / maxVal))) * plotH;

        // Area fill under Torque (Amber)
        const torqueGrad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
        torqueGrad.addColorStop(0, 'rgba(245, 158, 11, 0.22)');
        torqueGrad.addColorStop(1, 'rgba(245, 158, 11, 0.0)');
        ctx.beginPath();
        ctx.moveTo(toX(pts[0].rpm), padT + plotH);
        for (const p of pts) ctx.lineTo(toX(p.rpm), toY(p.torqueNm));
        ctx.lineTo(toX(pts[pts.length - 1].rpm), padT + plotH);
        ctx.closePath();
        ctx.fillStyle = torqueGrad;
        ctx.fill();

        // Area fill under Power (Apple Blue / Sky)
        const hpGrad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
        hpGrad.addColorStop(0, 'rgba(10, 132, 255, 0.25)');
        hpGrad.addColorStop(1, 'rgba(10, 132, 255, 0.0)');
        ctx.beginPath();
        ctx.moveTo(toX(pts[0].rpm), padT + plotH);
        for (const p of pts) ctx.lineTo(toX(p.rpm), toY(p.hp));
        ctx.lineTo(toX(pts[pts.length - 1].rpm), padT + plotH);
        ctx.closePath();
        ctx.fillStyle = hpGrad;
        ctx.fill();

        // Torque Curve Stroke
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        pts.forEach((p, idx) => {
          const x = toX(p.rpm);
          const y = toY(p.torqueNm);
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // Power Curve Stroke
        ctx.strokeStyle = '#0a84ff';
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        pts.forEach((p, idx) => {
          const x = toX(p.rpm);
          const y = toY(p.hp);
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // Peak markers
        const drawPeakDot = (rpm: number, val: number, color: string, label: string) => {
          const x = toX(rpm);
          const y = toY(val);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(x, y, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#0c0d10';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          ctx.fillStyle = color;
          ctx.font = 'bold 10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.textAlign = x > padL + plotW * 0.72 ? 'right' : 'left';
          ctx.fillText(label, x > padL + plotW * 0.72 ? x - 8 : x + 8, Math.max(padT + 12, y - 6));
        };

        drawPeakDot(
          dynoData.peakHp.rpm,
          dynoData.peakHp.value,
          '#38bdf8',
          `${dynoData.peakHp.value.toFixed(0)} ${showCrank ? 'BHP' : 'WHP'} @ ${dynoData.peakHp.rpm}`,
        );
        drawPeakDot(
          dynoData.peakTorque.rpm,
          dynoData.peakTorque.value,
          '#fbbf24',
          `${dynoData.peakTorque.value.toFixed(0)} Nm @ ${dynoData.peakTorque.rpm}`,
        );

        // Hover scrubber
        if (dynoHoverIdx !== null && dynoHoverIdx >= 0 && dynoHoverIdx < pts.length) {
          const p = pts[dynoHoverIdx];
          const x = toX(p.rpm);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(x, padT);
          ctx.lineTo(x, padT + plotH);
          ctx.stroke();
          ctx.setLineDash([]);

          for (const [val, color] of [
            [p.hp, '#0a84ff'],
            [p.torqueNm, '#f59e0b'],
          ] as const) {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x, toY(val), 4.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(container);
    return () => ro.disconnect();
  }, [
    mode,
    session,
    activeChannels,
    hoverIdx,
    scatterXCh,
    scatterYCh,
    scatterZCh,
    scatterHoverIdx,
    dynoData,
    dynoHoverIdx,
    showCrank,
  ]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();

    if (mode === 'timeseries') {
      if (session.timestamps.length < 2) return;
      const padL = 46;
      const padR = 20;
      const plotW = Math.max(1, rect.width - padL - padR);
      const relX = Math.max(0, Math.min(1, (e.clientX - rect.left - padL) / plotW));
      setHoverIdx(Math.round(relX * (session.timestamps.length - 1)));
    } else if (mode === 'scatter' && scatterXCh && scatterYCh) {
      const padL = 56;
      const padR = 26;
      const padT = 22;
      const padB = 38;
      const plotW = Math.max(1, rect.width - padL - padR);
      const plotH = Math.max(1, rect.height - padT - padB);
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const xSpan = Math.max(1e-6, scatterXCh.max - scatterXCh.min);
      const ySpan = Math.max(1e-6, scatterYCh.max - scatterYCh.min);
      let best = -1;
      let bestDist = 24 * 24;
      const n = Math.min(scatterXCh.values.length, scatterYCh.values.length);
      for (let i = 0; i < n; i++) {
        const px = padL + ((scatterXCh.values[i] - scatterXCh.min) / xSpan) * plotW;
        const py = padT + (1 - (scatterYCh.values[i] - scatterYCh.min) / ySpan) * plotH;
        const d2 = (px - mx) * (px - mx) + (py - my) * (py - my);
        if (d2 < bestDist) {
          bestDist = d2;
          best = i;
        }
      }
      setScatterHoverIdx(best >= 0 ? best : null);
    } else if (mode === 'dyno' && dynoData.points.length >= 2) {
      const padL = 56;
      const padR = 56;
      const plotW = Math.max(1, rect.width - padL - padR);
      const relX = Math.max(0, Math.min(1, (e.clientX - rect.left - padL) / plotW));
      setDynoHoverIdx(Math.round(relX * (dynoData.points.length - 1)));
    }
  };

  const inspectIdx = hoverIdx ?? Math.floor(session.timestamps.length * 0.6);
  const inspectTime = session.timestamps[inspectIdx] ?? 0;
  const activeDynoPt =
    dynoHoverIdx !== null ? dynoData.points[dynoHoverIdx] ?? null : null;

  return (
    <div
      className="h-full flex flex-col bg-[#0c0d10] text-zinc-100 overflow-hidden"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) loadCsvFile(file);
      }}
    >
      {/* Top Bar */}
      <div className="px-5 py-3 border-b border-white/[0.065] bg-[#121317] flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#0a84ff]/15 border border-[#0a84ff]/30 flex items-center justify-center">
            <Activity className="w-4 h-4 text-[#5ac8fa]" />
          </div>
          <div>
            <h2 className="text-sm font-semibold tracking-[-0.01em] text-white">{session.name}</h2>
            <p className="text-[11px] font-mono tabular-nums text-zinc-400">
              {session.timestamps.length} samples · {session.sampleRateHz} Hz ·{' '}
              {(session.timestamps[session.timestamps.length - 1] ?? 0).toFixed(2)}s duration
            </p>
          </div>
        </div>

        {/* 4-Mode Segmented Control */}
        <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] border border-white/[0.065]">
          {(
            [
              { id: 'timeseries', label: 'Time-Series', icon: <Activity className="w-3.5 h-3.5" /> },
              { id: 'scatter', label: 'XY Scatter', icon: <ScatterChart className="w-3.5 h-3.5" /> },
              { id: 'dyno', label: 'Virtual Dyno', icon: <Gauge className="w-3.5 h-3.5" /> },
              { id: 'autotune', label: 'Hit-Overlay & Auto-Tune', icon: <Grid3x3 className="w-3.5 h-3.5" /> },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11.5px] font-medium transition-all cursor-pointer ${
                mode === m.id
                  ? 'bg-[#0a84ff] text-white shadow-[0_1px_10px_rgba(10,132,255,0.4)]'
                  : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
              }`}
            >
              {m.icon}
              <span>{m.label}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt,.log"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) loadCsvFile(file);
            }}
          />
          <button
            type="button"
            onClick={handleLoadSample}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 text-xs font-medium transition-colors cursor-pointer"
          >
            <Flame className="w-3.5 h-3.5" />
            <span>20 Hz WOT Pull</span>
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-semibold shadow-[0_2px_10px_rgba(10,132,255,0.3)] transition-colors cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Import CSV</span>
          </button>
        </div>
      </div>

      {/* Mode-Specific Control & Readout Strip */}
      {mode === 'timeseries' && (
        <div className="px-5 py-2.5 border-b border-white/[0.065] bg-[#15161b] flex items-center gap-2.5 overflow-x-auto">
          <div className="px-2.5 py-1.5 rounded-lg bg-[#0c0d10] border border-white/[0.065] shrink-0">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Time</div>
            <div className="text-xs font-mono tabular-nums font-bold text-white">
              {inspectTime.toFixed(2)} s
            </div>
          </div>

          {session.channels.map((ch) => {
            const isOn = enabledKeys.has(ch.key);
            const val = ch.values[inspectIdx] ?? 0;
            return (
              <button
                key={ch.key}
                type="button"
                onClick={() => toggleChannel(ch.key)}
                className={`px-2.5 py-1.5 rounded-lg border text-left transition-all shrink-0 cursor-pointer ${
                  isOn
                    ? 'bg-[#0c0d10] border-white/[0.12] opacity-100'
                    : 'bg-transparent border-white/[0.04] opacity-40 hover:opacity-75'
                }`}
              >
                <div className="flex items-center gap-1.5 text-[10px] text-zinc-400">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: ch.color }}
                  />
                  <span>{ch.label}</span>
                </div>
                <div className="text-xs font-mono tabular-nums font-semibold text-zinc-100 mt-0.5">
                  {val.toFixed(ch.decimals)}
                  {ch.unit ? <span className="text-zinc-500 ml-1 text-[10px]">{ch.unit}</span> : null}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {mode === 'scatter' && (
        <div className="px-5 py-2.5 border-b border-white/[0.065] bg-[#15161b] flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            {(
              [
                { label: 'X Axis', value: scatterXKey, setter: setScatterXKey },
                { label: 'Y Axis', value: scatterYKey, setter: setScatterYKey },
                { label: 'Color (Z)', value: scatterZKey, setter: setScatterZKey },
              ] as const
            ).map((axis) => (
              <label key={axis.label} className="flex items-center gap-1.5 text-xs text-zinc-400">
                <span className="text-[10.5px] uppercase tracking-wider text-zinc-500">{axis.label}</span>
                <select
                  value={axis.value}
                  onChange={(e) => axis.setter(e.target.value)}
                  className="px-2.5 py-1 rounded-lg bg-[#0c0d10] border border-white/[0.08] text-xs text-zinc-100 focus:outline-none focus:border-[#0a84ff]"
                >
                  {session.channels.map((ch) => (
                    <option key={ch.key} value={ch.key}>
                      {ch.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <div className="flex items-center gap-3 text-[11px] font-mono tabular-nums">
            {scatterHoverIdx !== null && scatterXCh && scatterYCh && scatterZCh ? (
              <div className="flex items-center gap-3 px-3 py-1 rounded-lg bg-[#0c0d10] border border-white/[0.08] text-zinc-200">
                <span>
                  {scatterXCh.label}:{' '}
                  <strong className="text-white">
                    {scatterXCh.values[scatterHoverIdx]?.toFixed(scatterXCh.decimals)}
                  </strong>
                </span>
                <span>
                  {scatterYCh.label}:{' '}
                  <strong className="text-[#5ac8fa]">
                    {scatterYCh.values[scatterHoverIdx]?.toFixed(scatterYCh.decimals)}
                  </strong>
                </span>
                <span>
                  {scatterZCh.label}:{' '}
                  <strong className="text-amber-300">
                    {scatterZCh.values[scatterHoverIdx]?.toFixed(scatterZCh.decimals)}
                  </strong>
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-zinc-400">
                <span>{scatterZCh?.min.toFixed(scatterZCh.decimals)}</span>
                <div
                  className="h-2 w-24 rounded-full border border-white/10"
                  style={{
                    background:
                      'linear-gradient(90deg, rgb(30,100,235), rgb(20,184,218), rgb(16,185,129), rgb(245,158,11), rgb(239,68,68))',
                  }}
                />
                <span>{scatterZCh?.max.toFixed(scatterZCh.decimals)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {mode === 'dyno' && (
        <div className="px-5 py-3 border-b border-white/[0.065] bg-[#15161b] space-y-3">
          {/* 4 Dyno KPI Pills */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] px-3.5 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                Peak {showCrank ? 'Crank Power' : 'Wheel Power'}
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-lg font-mono tabular-nums font-bold text-[#38bdf8]">
                  {dynoData.peakHp.value.toFixed(1)} {showCrank ? 'BHP' : 'WHP'}
                </span>
                <span className="text-[11px] font-mono tabular-nums text-zinc-400">
                  @ {dynoData.peakHp.rpm} rpm
                </span>
              </div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] px-3.5 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                Peak Torque
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-lg font-mono tabular-nums font-bold text-amber-400">
                  {dynoData.peakTorque.value.toFixed(1)} Nm
                </span>
                <span className="text-[11px] font-mono tabular-nums text-zinc-400">
                  @ {dynoData.peakTorque.rpm} rpm
                </span>
              </div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] px-3.5 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                Peak Boost
              </div>
              <div className="mt-1 text-lg font-mono tabular-nums font-bold text-emerald-400">
                {dynoData.peakBoost !== null ? `${dynoData.peakBoost.toFixed(2)} bar` : 'N/A'}
              </div>
            </div>

            <div className="rounded-xl bg-[#17181d] border border-white/[0.065] px-3.5 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                {activeDynoPt ? `Scrubber @ ${activeDynoPt.rpm} RPM` : 'WOT Pull Window'}
              </div>
              <div className="mt-1 text-sm font-mono tabular-nums font-semibold text-zinc-100">
                {activeDynoPt ? (
                  <span>
                    <span className="text-[#38bdf8]">{activeDynoPt.hp.toFixed(0)} HP</span>
                    <span className="text-zinc-600 mx-1.5">·</span>
                    <span className="text-amber-400">{activeDynoPt.torqueNm.toFixed(0)} Nm</span>
                  </span>
                ) : (
                  <span>{dynoData.pullDurationSec.toFixed(2)} s · {dynoData.points.length} pts</span>
                )}
              </div>
            </div>
          </div>

          {/* Vehicle Physics Controls */}
          <div className="flex items-center justify-between gap-3 flex-wrap text-xs">
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-1.5 text-zinc-400">
                <span>Mass</span>
                <input
                  type="number"
                  min={600}
                  max={3500}
                  step={25}
                  value={massKg}
                  onChange={(e) => setMassKg(Math.max(600, Number(e.target.value) || 1450))}
                  className="w-20 px-2 py-1 rounded-md bg-[#0c0d10] border border-white/[0.08] font-mono tabular-nums text-zinc-100 focus:outline-none focus:border-[#0a84ff]"
                />
                <span className="text-zinc-500">kg</span>
              </label>

              <label className="flex items-center gap-1.5 text-zinc-400">
                <span>CdA</span>
                <input
                  type="number"
                  min={0.3}
                  max={1.5}
                  step={0.02}
                  value={cda}
                  onChange={(e) => setCda(Math.max(0.2, Number(e.target.value) || 0.68))}
                  className="w-16 px-2 py-1 rounded-md bg-[#0c0d10] border border-white/[0.08] font-mono tabular-nums text-zinc-100 focus:outline-none focus:border-[#0a84ff]"
                />
                <span className="text-zinc-500">m²</span>
              </label>

              <label className="flex items-center gap-1.5 text-zinc-400">
                <span>Smooth</span>
                <select
                  value={smoothRadius}
                  onChange={(e) => setSmoothRadius(Number(e.target.value))}
                  className="px-2 py-1 rounded-md bg-[#0c0d10] border border-white/[0.08] text-zinc-100 focus:outline-none focus:border-[#0a84ff]"
                >
                  <option value={1}>Light (3-pt)</option>
                  <option value={3}>Medium (7-pt)</option>
                  <option value={5}>Heavy (11-pt)</option>
                </select>
              </label>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center rounded-lg bg-[#0c0d10] border border-white/[0.08] p-0.5">
                <button
                  type="button"
                  onClick={() => setShowCrank(false)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                    !showCrank ? 'bg-[#0a84ff] text-white' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Wheel (WHP)
                </button>
                <button
                  type="button"
                  onClick={() => setShowCrank(true)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                    showCrank ? 'bg-[#0a84ff] text-white' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Crank (+{drivetrainLossPct}%)
                </button>
              </div>
              {showCrank && (
                <input
                  type="number"
                  min={5}
                  max={25}
                  value={drivetrainLossPct}
                  onChange={(e) => setDrivetrainLossPct(Math.max(0, Math.min(30, Number(e.target.value) || 12)))}
                  className="w-14 px-2 py-1 rounded-md bg-[#0c0d10] border border-white/[0.08] font-mono tabular-nums text-zinc-100 text-[11px]"
                  title="Drivetrain loss %"
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main High-DPI Canvas Area OR Map Hit-Overlay & Auto-Tune Workbench */}
      {mode === 'autotune' ? (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* Auto-Tune Controls Bar */}
          <div className="px-5 py-2.5 border-b border-white/[0.065] bg-[#15161b] flex items-center justify-between gap-3 flex-wrap text-xs">
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-1.5 text-zinc-400">
                <span className="text-[10.5px] uppercase tracking-wider text-zinc-500">Map</span>
                <select
                  value={activeMap?.id ?? ''}
                  onChange={(e) => {
                    setSelectedMapId(Number(e.target.value));
                    setExcludedCells(new Set());
                    setAutoTuneNotice(null);
                  }}
                  disabled={tableItems.length === 0}
                  className="px-2.5 py-1 rounded-lg bg-[#0c0d10] border border-white/[0.08] text-xs text-zinc-100 focus:outline-none focus:border-[#0a84ff] max-w-[230px]"
                >
                  {tableItems.length === 0 ? (
                    <option value="">No XDF table maps</option>
                  ) : (
                    tableItems.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title} ({t.data.rows}×{t.data.cols})
                      </option>
                    ))
                  )}
                </select>
              </label>

              <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-[#0c0d10] border border-white/[0.08]">
                {(
                  [
                    { id: 'lambda', label: 'Lambda Auto-Tune' },
                    { id: 'boost', label: 'Boost Auto-Tune' },
                    { id: 'hits', label: 'Hit Density Only' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setAutoTuneTarget(opt.id);
                      setExcludedCells(new Set());
                      setAutoTuneNotice(null);
                    }}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                      autoTuneTarget === opt.id
                        ? 'bg-[#0a84ff] text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {autoTuneTarget === 'lambda' && (
                <label className="flex items-center gap-1.5 text-zinc-400">
                  <span>Target λ</span>
                  <input
                    type="number"
                    step={0.01}
                    min={0.7}
                    max={1.05}
                    value={targetLambdaGoal}
                    onChange={(e) => setTargetLambdaGoal(Number(e.target.value) || 0.82)}
                    className="w-16 px-2 py-1 rounded-md bg-[#0c0d10] border border-white/[0.08] font-mono tabular-nums text-zinc-100"
                  />
                </label>
              )}

              {autoTuneTarget === 'boost' && (
                <label className="flex items-center gap-1.5 text-zinc-400">
                  <span>Target Boost</span>
                  <input
                    type="number"
                    step={0.05}
                    min={0.5}
                    max={3.0}
                    value={targetBoostGoalBar}
                    onChange={(e) => setTargetBoostGoalBar(Number(e.target.value) || 1.55)}
                    className="w-16 px-2 py-1 rounded-md bg-[#0c0d10] border border-white/[0.08] font-mono tabular-nums text-zinc-100"
                  />
                  <span className="text-zinc-500">bar</span>
                </label>
              )}
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-1.5 text-zinc-400">
                <span>Damping</span>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.1}
                  value={autoTuneDamping}
                  onChange={(e) => setAutoTuneDamping(Number(e.target.value))}
                  className="w-20 accent-[#0a84ff]"
                />
                <span className="font-mono text-zinc-200 w-8">
                  {Math.round(autoTuneDamping * 100)}%
                </span>
              </label>

              <label className="flex items-center gap-1.5 text-zinc-400">
                <span>Min Hits</span>
                <input
                  type="number"
                  min={1}
                  max={25}
                  value={autoTuneMinHits}
                  onChange={(e) => setAutoTuneMinHits(Math.max(1, Number(e.target.value) || 1))}
                  className="w-12 px-2 py-1 rounded-md bg-[#0c0d10] border border-white/[0.08] font-mono tabular-nums text-zinc-100"
                />
              </label>

              <label className="flex items-center gap-1.5 text-zinc-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={wotFilterOnly}
                  onChange={(e) => setWotFilterOnly(e.target.checked)}
                  className="accent-[#0a84ff]"
                />
                <span>WOT Only (≥65% Load)</span>
              </label>
            </div>
          </div>

          {!activeMap || !autoTuneAnalysis ? (
            <div className="flex-1 flex items-center justify-center p-8">
              <div className="max-w-md w-full rounded-2xl bg-[#17181d] border border-white/[0.065] p-8 text-center space-y-4">
                <div className="w-12 h-12 rounded-2xl bg-[#0a84ff]/15 border border-[#0a84ff]/30 flex items-center justify-center mx-auto">
                  <Grid3x3 className="w-6 h-6 text-[#5ac8fa]" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">
                    Map Hit-Overlay &amp; Auto-Tune Ready
                  </h3>
                  <p className="text-xs text-zinc-400 mt-1">
                    Connect an XDF + BIN calibration to overlay live RPM×Load hit counts from the 20 Hz WOT pull and calculate 1-click lambda &amp; boost cell corrections.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const demo = createMed17DemoBundle();
                    setDemoFallback({ xdf: demo.xdf, bin: demo.stage1Bin });
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] text-white text-xs font-semibold shadow-[0_3px_14px_rgba(10,132,255,0.35)] cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Load MED17 Demo Map Preview</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-4 p-5 overflow-hidden">
              {/* Left: Interactive RPM x Load Map Heatmap with Hit-Count Overlay */}
              <div className="lg:col-span-7 rounded-xl bg-[#17181d] border border-white/[0.065] flex flex-col overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                <div className="px-4 py-2.5 border-b border-white/[0.065] bg-[#14151a] flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-white">{activeMap.title}</span>
                    <span className="px-2 py-0.5 rounded-md bg-white/[0.06] font-mono text-[10px] text-zinc-400">
                      {activeMap.data.rows}×{activeMap.data.cols} · {activeMap.scaling.units || 'raw'}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 font-mono text-[10.5px] text-zinc-400">
                    <span>
                      Hits: <strong className="text-[#5ac8fa]">{autoTuneAnalysis.totalHits}</strong>
                    </span>
                    <span>
                      Cells Hit:{' '}
                      <strong className="text-emerald-400">
                        {autoTuneAnalysis.coveredCells}/{activeMap.data.rows * activeMap.data.cols}
                      </strong>
                    </span>
                  </div>
                </div>

                <div className="flex-1 overflow-auto p-3">
                  <table className="border-collapse text-[10.5px] font-mono tabular-nums w-full">
                    <thead>
                      <tr>
                        <th className="p-1.5 text-left text-[9.5px] text-zinc-500 border border-white/[0.05] bg-[#121317] sticky top-0 left-0 z-20">
                          Load \ RPM
                        </th>
                        {autoTuneAnalysis.xLabels.map((xl, c) => (
                          <th
                            key={c}
                            className="p-1.5 text-center text-zinc-400 border border-white/[0.05] bg-[#121317] sticky top-0 z-10 whitespace-nowrap"
                          >
                            {xl}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {autoTuneAnalysis.yLabels.map((yl, r) => (
                        <tr key={r}>
                          <th className="p-1.5 text-right text-zinc-400 border border-white/[0.05] bg-[#121317] sticky left-0 z-10 whitespace-nowrap">
                            {yl}
                          </th>
                          {autoTuneAnalysis.xLabels.map((_, c) => {
                            const h = autoTuneAnalysis.hits[r][c];
                            const val = autoTuneAnalysis.mapValues[r][c];
                            const key = `${r}:${c}`;
                            const sug = autoTuneAnalysis.suggestionMap.get(key);
                            const isHov = hoveredCellKey === key;
                            const hitFrac =
                              autoTuneAnalysis.maxCellHits > 0
                                ? h / autoTuneAnalysis.maxCellHits
                                : 0;
                            const bgStyle =
                              h > 0
                                ? {
                                    backgroundColor: `rgba(10, 132, 255, ${0.12 + hitFrac * 0.42})`,
                                  }
                                : undefined;

                            return (
                              <td
                                key={c}
                                onMouseEnter={() => setHoveredCellKey(key)}
                                onMouseLeave={() => setHoveredCellKey(null)}
                                style={bgStyle}
                                className={`p-1 text-center border transition-all relative ${
                                  isHov
                                    ? 'border-white ring-1 ring-white/60 z-10'
                                    : sug
                                      ? 'border-amber-400/50'
                                      : 'border-white/[0.05]'
                                } ${h === 0 ? 'bg-[#0c0d10] text-zinc-500' : 'text-white'}`}
                              >
                                <div className="leading-tight">
                                  {scalingFormat(activeMap.scaling, val)}
                                </div>
                                {h > 0 && (
                                  <div className="mt-0.5 flex items-center justify-center gap-0.5">
                                    <span className="px-1 rounded bg-black/55 text-[9px] font-bold text-[#5ac8fa]">
                                      {h}×
                                    </span>
                                    {sug && (
                                      <span
                                        className={`px-1 rounded bg-black/55 text-[9px] font-bold ${
                                          sug.deltaPercent > 0 ? 'text-emerald-300' : 'text-amber-300'
                                        }`}
                                      >
                                        {sug.deltaPercent > 0 ? '+' : ''}
                                        {sug.deltaPercent.toFixed(1)}%
                                      </span>
                                    )}
                                  </div>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Right: Auto-Tune Suggestions & 1-Click Apply */}
              <div className="lg:col-span-5 rounded-xl bg-[#17181d] border border-white/[0.065] flex flex-col overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                <div className="px-4 py-2.5 border-b border-white/[0.065] bg-[#14151a] flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Wand2 className="w-3.5 h-3.5 text-[#5ac8fa]" />
                    <span className="text-xs font-semibold text-white">
                      Auto-Tune Cell Corrections
                    </span>
                  </div>
                  <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 font-mono text-[10px] text-amber-300">
                    {autoTuneAnalysis.suggestions.filter((s) => !excludedCells.has(s.key)).length}{' '}
                    selected
                  </span>
                </div>

                {autoTuneNotice && (
                  <div className="mx-3 mt-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-3 py-2 text-[11px] text-emerald-300 flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    <span>{autoTuneNotice}</span>
                  </div>
                )}

                <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
                  {autoTuneAnalysis.suggestions.length === 0 ? (
                    <div className="p-8 text-center text-xs text-zinc-400">
                      {autoTuneTarget === 'hits'
                        ? 'Switch to Lambda Auto-Tune or Boost Auto-Tune above to compute cell corrections.'
                        : 'No cells exceed the minimum hit count & delta threshold. Try lowering Min Hits or adjusting Target.'}
                    </div>
                  ) : (
                    autoTuneAnalysis.suggestions.map((sug) => {
                      const included = !excludedCells.has(sug.key);
                      const isHov = hoveredCellKey === sug.key;
                      return (
                        <div
                          key={sug.key}
                          onMouseEnter={() => setHoveredCellKey(sug.key)}
                          onMouseLeave={() => setHoveredCellKey(null)}
                          className={`rounded-lg p-2.5 border flex items-center justify-between gap-2 transition-colors ${
                            isHov
                              ? 'bg-[#0a84ff]/15 border-[#0a84ff]/45'
                              : included
                                ? 'bg-[#0c0d10] border-white/[0.07]'
                                : 'bg-[#0c0d10]/40 border-white/[0.04] opacity-50'
                          }`}
                        >
                          <label className="flex items-center gap-2.5 min-w-0 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={included}
                              onChange={() =>
                                setExcludedCells((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(sug.key)) next.delete(sug.key);
                                  else next.add(sug.key);
                                  return next;
                                })
                              }
                              className="accent-[#0a84ff]"
                            />
                            <div className="min-w-0">
                              <div className="text-[11px] font-mono font-semibold text-zinc-100">
                                [{sug.yLabel} / {sug.xLabel}]
                                <span className="ml-1.5 px-1.5 py-0.5 rounded bg-[#0a84ff]/15 text-[#5ac8fa] text-[9.5px]">
                                  {sug.hits} hits
                                </span>
                              </div>
                              <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
                                Logged avg: {sug.avgMeasured.toFixed(autoTuneTarget === 'lambda' ? 3 : 0)}
                              </div>
                            </div>
                          </label>

                          <div className="text-right font-mono tabular-nums shrink-0">
                            <div className="text-[11px] text-zinc-200">
                              {scalingFormat(activeMap.scaling, sug.currentValue)}{' '}
                              <span className="text-zinc-500">→</span>{' '}
                              <span className="text-amber-300 font-semibold">
                                {scalingFormat(activeMap.scaling, sug.suggestedValue)}
                              </span>
                            </div>
                            <div
                              className={`text-[10px] font-semibold ${
                                sug.deltaPercent > 0 ? 'text-emerald-400' : 'text-sky-400'
                              }`}
                            >
                              {sug.deltaPercent > 0 ? '+' : ''}
                              {sug.deltaPercent.toFixed(1)}%
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="p-3 border-t border-white/[0.065] bg-[#14151a]">
                  <button
                    type="button"
                    disabled={
                      autoTuneAnalysis.suggestions.filter((s) => !excludedCells.has(s.key))
                        .length === 0
                    }
                    onClick={handleApplyAutoTune}
                    className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-[#0a84ff] hover:bg-[#1e8fff] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold shadow-[0_3px_14px_rgba(10,132,255,0.35)] transition-all cursor-pointer"
                  >
                    <Wand2 className="w-3.5 h-3.5" />
                    <span>
                      Apply{' '}
                      {autoTuneAnalysis.suggestions.filter((s) => !excludedCells.has(s.key)).length}{' '}
                      Cell Correction(s)
                    </span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 p-5 min-h-0 flex flex-col">
          <div
            ref={containerRef}
            className={`relative flex-1 rounded-xl bg-[#17181d] border overflow-hidden transition-colors shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ${
              isDragging ? 'border-[#0a84ff] ring-2 ring-[#0a84ff]/30' : 'border-white/[0.065]'
            }`}
          >
            <canvas
              ref={canvasRef}
              onMouseMove={handleMouseMove}
              onMouseLeave={() => {
                setHoverIdx(null);
                setScatterHoverIdx(null);
                setDynoHoverIdx(null);
              }}
              className="w-full h-full block cursor-crosshair"
            />

            {isDragging && (
              <div className="absolute inset-0 bg-[#0c0d10]/85 backdrop-blur-sm flex flex-col items-center justify-center pointer-events-none">
                <Upload className="w-8 h-8 text-[#0a84ff] mb-2" />
                <p className="text-sm font-semibold text-white">Drop CSV datalog to plot channels</p>
              </div>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500">
            <span>
              {mode === 'timeseries' &&
                'Hover chart to scrub synchronized channels · Click channel pills above to toggle traces'}
              {mode === 'scatter' &&
                'MegaLogViewer-style XY scatter · Hover any data point to inspect X, Y & Z color value'}
              {mode === 'dyno' &&
                'Road-load physics Virtual Dyno (F_accel + F_roll + F_aero) · Hover curve to inspect RPM / HP / Nm'}
            </span>
            <span>Drag &amp; drop any .csv log anywhere in this view</span>
          </div>
        </div>
      )}
    </div>
  );
};
