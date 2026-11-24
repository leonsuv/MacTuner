import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Flame, Upload } from 'lucide-react';

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

const CHANNEL_COLORS = ['#2589ff', '#f59e0b', '#10b981', '#ec4899', '#a855f7', '#06b6d4'];

/**
 * Generates a realistic 20 Hz 3rd-gear WOT dyno pull (7.5 s, 150 samples) with
 * nonlinear turbo spool, torque curve, lambda enrichment, timing pull & ramp,
 * and aerodynamic drag-curved acceleration (not linear).
 */
function createRealisticWotPull(): DatalogSession {
  const sampleRateHz = 20;
  const totalSamples = 150; // 7.5 seconds
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

    // WOT throttle transition around t = 0.45s, lift-off at t = 6.65s
    const wot = t < 0.45 ? 0 : t > 6.65 ? Math.max(0, 1 - (t - 6.65) * 3.5) : Math.min(1, (t - 0.45) / 0.25);

    // Torque curve peaks around 4200 RPM, tapers gently past 5800 RPM
    const normRpm = Math.max(0, Math.min(1, (curRpm - 2000) / 5000));
    const torqueShape = Math.sin(Math.pow(normRpm, 0.72) * Math.PI * 0.92);

    // Turbo spool target boost (bar gauge) with realistic slight overshoot then taper
    const targetBoost =
      wot > 0.2
        ? (1.58 * Math.min(1, (curRpm - 1800) / 1450) - 0.24 * Math.max(0, normRpm - 0.68)) * wot
        : -0.58;
    const spoolRate = targetBoost > curBoost ? 0.16 : 0.34;
    curBoost += (targetBoost - curBoost) * spoolRate;
    const boostRipple = Math.sin(t * 17.5) * 0.014 * wot;
    const boostVal = Math.max(-0.7, curBoost + boostRipple);

    // Nonlinear RPM acceleration proportional to torque * boost - aero drag
    const accel =
      wot > 0.1
        ? (420 + 610 * torqueShape * Math.max(0.25, (boostVal + 0.5) / 1.9) - 140 * normRpm * normRpm) * wot
        : -680 * (curRpm > 2300 ? 1 : 0.2);
    curRpm = Math.max(1950, Math.min(6980, curRpm + accel / sampleRateHz));

    // Engine load (%) follows boost & volumetric efficiency
    const loadVal = Math.max(
      18,
      Math.min(225, 34 + (boostVal + 0.6) * 84 * (0.85 + 0.2 * torqueShape) + Math.sin(t * 9.2) * 1.4),
    );

    // Lambda: ~1.00 cruise -> enriches smoothly to ~0.79 at peak boost/RPM -> lean decel cut
    const lambdaVal =
      t > 6.75
        ? Math.min(1.65, 0.84 + (t - 6.75) * 1.4)
        : 1.0 - wot * (0.14 + 0.08 * normRpm) + Math.sin(t * 13) * 0.006;

    // Ignition timing (deg BTDC): dips during peak cylinder pressure (3500-4400 RPM), then climbs to ~16.5° at redline
    const peakCylDip = Math.exp(-Math.pow((curRpm - 3850) / 850, 2)) * 5.2;
    const timingVal =
      wot > 0.2
        ? 11.5 - peakCylDip + 7.2 * Math.pow(normRpm, 1.35) + Math.sin(t * 11) * 0.25
        : 24.0 - normRpm * 4.0;

    // 3rd gear ratio ~24.8 km/h per 1000 RPM
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
      { key: 'rpm', label: 'Engine RPM', unit: 'rpm', color: '#2589ff', min: 1500, max: 7500, decimals: 0, values: rpm },
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
    timeIdx >= 0
      ? cols[timeIdx]
      : cols[0].map((_, idx) => idx * 0.05);

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

export const DatalogView: React.FC = () => {
  const [session, setSession] = useState<DatalogSession>(() => createRealisticWotPull());
  const [enabledKeys, setEnabledKeys] = useState<Set<string>>(
    () => new Set(['rpm', 'boost', 'load', 'lambda', 'timing', 'speed']),
  );
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeChannels = useMemo(
    () => session.channels.filter((ch) => enabledKeys.has(ch.key)),
    [session.channels, enabledKeys],
  );

  const loadCsvFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseCsvDatalog(String(reader.result ?? ''), file.name);
      if (parsed) {
        setSession(parsed);
        setEnabledKeys(new Set(parsed.channels.slice(0, 6).map((c) => c.key)));
        setHoverIdx(null);
      }
    };
    reader.readAsText(file);
  }, []);

  const handleLoadSample = () => {
    const sample = createRealisticWotPull();
    setSession(sample);
    setEnabledKeys(new Set(sample.channels.map((c) => c.key)));
    setHoverIdx(null);
  };

  const toggleChannel = (key: string) => {
    setEnabledKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Render high-DPI multi-channel Canvas chart
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

      const padL = 44;
      const padR = 20;
      const padT = 18;
      const padB = 30;
      const plotW = width - padL - padR;
      const plotH = height - padT - padB;

      // Background
      ctx.fillStyle = '#0d1016';
      ctx.fillRect(0, 0, width, height);

      // Subtle grid lines
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 5; i++) {
        const y = padT + (plotH * i) / 5;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();

        ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'right';
        ctx.fillText(`${100 - i * 20}%`, padL - 6, y + 3);
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
        ctx.fillStyle = 'rgba(148, 163, 184, 0.65)';
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${tLabel.toFixed(1)}s`, x, height - 10);
      }

      // Draw each enabled channel
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

      // Hover scrubber vertical line + sample dots
      if (hoverIdx !== null && hoverIdx >= 0 && hoverIdx < n) {
        const x = padL + ((session.timestamps[hoverIdx] - tMin) / tSpan) * plotW;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
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
          ctx.strokeStyle = '#0d1016';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(container);
    return () => ro.disconnect();
  }, [session, activeChannels, hoverIdx]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || session.timestamps.length < 2) return;
    const rect = canvas.getBoundingClientRect();
    const padL = 44;
    const padR = 20;
    const plotW = Math.max(1, rect.width - padL - padR);
    const relX = Math.max(0, Math.min(1, (e.clientX - rect.left - padL) / plotW));
    const idx = Math.round(relX * (session.timestamps.length - 1));
    setHoverIdx(idx);
  };

  const inspectIdx = hoverIdx ?? Math.floor(session.timestamps.length * 0.6);
  const inspectTime = session.timestamps[inspectIdx] ?? 0;

  return (
    <div
      className="h-full flex flex-col bg-[#0d1016] text-slate-100 overflow-hidden"
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
      <div className="px-5 py-3 border-b border-white/10 bg-[#10141c] flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#2589ff]/15 border border-[#2589ff]/35 flex items-center justify-center">
            <Activity className="w-4 h-4 text-[#6ab0ff]" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white">{session.name}</h2>
            <p className="text-[11px] font-mono tabular-nums text-slate-400">
              {session.timestamps.length} samples · {session.sampleRateHz} Hz ·{' '}
              {(session.timestamps[session.timestamps.length - 1] ?? 0).toFixed(2)}s duration
            </p>
          </div>
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
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#f59e0b]/15 hover:bg-[#f59e0b]/25 text-[#fbbf24] border border-[#f59e0b]/35 text-xs font-medium transition-colors"
          >
            <Flame className="w-3.5 h-3.5" />
            <span>Load 20 Hz WOT Pull</span>
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#2589ff] hover:bg-[#1d78e8] text-white text-xs font-semibold transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Import CSV Log</span>
          </button>
        </div>
      </div>

      {/* Live Scrubber Readout Strip */}
      <div className="px-5 py-2.5 border-b border-white/10 bg-[#141821]/75 flex items-center gap-3 overflow-x-auto">
        <div className="px-2.5 py-1 rounded-md bg-[#0d1016] border border-white/10 shrink-0">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Time</div>
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
              className={`px-2.5 py-1 rounded-md border text-left transition-all shrink-0 cursor-pointer ${
                isOn
                  ? 'bg-[#0d1016] border-white/15 opacity-100'
                  : 'bg-transparent border-white/5 opacity-45 hover:opacity-75'
              }`}
            >
              <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: ch.color }}
                />
                <span>{ch.label}</span>
              </div>
              <div className="text-xs font-mono tabular-nums font-semibold text-slate-100 mt-0.5">
                {val.toFixed(ch.decimals)}
                {ch.unit ? <span className="text-slate-500 ml-1 text-[10px]">{ch.unit}</span> : null}
              </div>
            </button>
          );
        })}
      </div>

      {/* Multi-Channel Canvas Chart */}
      <div className="flex-1 p-5 min-h-0 flex flex-col">
        <div
          ref={containerRef}
          className={`relative flex-1 rounded-xl bg-[#141821] border overflow-hidden transition-colors ${
            isDragging ? 'border-[#2589ff] ring-2 ring-[#2589ff]/30' : 'border-white/10'
          }`}
        >
          <canvas
            ref={canvasRef}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHoverIdx(null)}
            className="w-full h-full block cursor-crosshair"
          />

          {isDragging && (
            <div className="absolute inset-0 bg-[#0d1016]/80 backdrop-blur-sm flex flex-col items-center justify-center pointer-events-none">
              <Upload className="w-8 h-8 text-[#2589ff] mb-2" />
              <p className="text-sm font-semibold text-white">Drop CSV datalog to plot channels</p>
            </div>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
          <span>Hover chart to scrub synchronized channels · Click channel pills above to toggle traces</span>
          <span>Drag &amp; drop any .csv log anywhere in this view</span>
        </div>
      </div>
    </div>
  );
};
