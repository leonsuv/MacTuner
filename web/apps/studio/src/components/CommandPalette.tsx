import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Binary,
  Camera,
  Columns2,
  Columns3,
  CornerDownLeft,
  Download,
  FileDown,
  HardDrive,
  LayoutDashboard,
  LayoutGrid,
  Lock,
  Palette,
  PanelBottom,
  PanelRight,
  Printer,
  Scale,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  Table2,
  Wand2,
} from 'lucide-react';
import type {
  DefinitionExportFormat,
  HeatmapPalette,
  MapCandidate,
  UnitSystem,
  XDFItem,
} from '@mactuner/core';

export type PaletteSection =
  | 'overview'
  | 'workspace'
  | 'compare'
  | 'discovery'
  | 'memory'
  | 'recipes'
  | 'datalog'
  | 'flash';

export type LayoutMode = 'studio' | 'ide' | 'canvas';

export interface CommandAction {
  id: string;
  label: string;
  subtitle?: string;
  shortcut?: string;
  group: 'Jump' | 'Navigation' | 'Actions' | 'Layout' | 'Export' | 'Appearance' | 'Maps' | 'Detected';
  icon: React.ReactNode;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  items: XDFItem[];
  candidates: MapCandidate[];
  onSelectMap: (item: XDFItem) => void;
  onJumpAddress: (addr: number) => void;
  onSelectHexRange?: (range: [number, number]) => void;
  onSetHexColumns?: (cols: number) => void;
  onSwitchSection: (sec: PaletteSection, workbenchMode?: 'hex' | 'map') => void;
  onFixChecksums: () => void;
  onSwapBins: () => void;
  onSetLayoutMode?: (mode: LayoutMode) => void;
  onToggleBottomDrawer?: () => void;
  onToggleInspector?: () => void;
  onToggleLock?: () => void;
  onToggleFavorite?: () => void;
  onNextChangedMap?: () => void;
  onPrevChangedMap?: () => void;
  onQuickSnapshot?: () => void;
  onExportBin?: () => void;
  onExportDefinition?: (format: DefinitionExportFormat, ext: string) => void;
  onPrint?: () => void;
  onSetHeatmapPalette?: (palette: HeatmapPalette) => void;
  onSetUnitSystem?: (unit: UnitSystem) => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  items,
  candidates,
  onSelectMap,
  onJumpAddress,
  onSelectHexRange,
  onSetHexColumns,
  onSwitchSection,
  onFixChecksums,
  onSwapBins,
  onSetLayoutMode,
  onToggleBottomDrawer,
  onToggleInspector,
  onToggleLock,
  onToggleFavorite,
  onNextChangedMap,
  onPrevChangedMap,
  onQuickSnapshot,
  onExportBin,
  onExportDefinition,
  onPrint,
  onSetHeatmapPalette,
  onSetUnitSystem,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const actions = useMemo<CommandAction[]>(() => {
    const q = query.trim();
    const out: CommandAction[] = [];

    // 1. WinOLS range syntax: 20000..201FF or 0x20000..0x201FF
    const rangeMatch = q.match(/^(?:0x)?([0-9a-fA-F]{2,7})\s*\.\.\s*(?:0x)?([0-9a-fA-F]{2,7})$/);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 16);
      const b = parseInt(rangeMatch[2], 16);
      const start = Math.min(a, b);
      const end = Math.max(a, b);
      out.push({
        id: `range-${start}-${end}`,
        label: `Select Range 0x${start.toString(16).toUpperCase()}..0x${end.toString(16).toUpperCase()}`,
        subtitle: `${end - start + 1} bytes in Split Hex-Diff`,
        group: 'Jump',
        icon: <Binary className="h-4 w-4 text-sky-400" />,
        run: () => {
          if (onSelectHexRange) onSelectHexRange([start, end]);
          else onJumpAddress(start);
        },
      });
    }

    // 2. WinOLS columns syntax: cols=16 or spalten=16 (1..32)
    const colsMatch = q.match(/^(?:cols|spalten)\s*=\s*(\d{1,2})$/i);
    if (colsMatch) {
      const cols = Math.max(1, Math.min(32, parseInt(colsMatch[1], 10)));
      out.push({
        id: `cols-${cols}`,
        label: `Set Hex-Diff Columns = ${cols}`,
        subtitle: 'Change bytes-per-row width (1–32)',
        group: 'Jump',
        icon: <Columns2 className="h-4 w-4 text-amber-400" />,
        run: () => onSetHexColumns?.(cols),
      });
    }

    // 3. Direct hex jump: :80000, 0x80000, or 4-6 hex chars
    const hexMatch = q.match(/^(?::|0x)?([0-9a-fA-F]{4,7})$/);
    if (hexMatch && !rangeMatch) {
      const addr = parseInt(hexMatch[1], 16);
      out.push({
        id: `jump-${addr}`,
        label: `Jump to 0x${addr.toString(16).toUpperCase().padStart(5, '0')}`,
        subtitle: 'Open in Split Hex-Diff Editor',
        group: 'Jump',
        icon: <Binary className="h-4 w-4 text-sky-400" />,
        run: () => onJumpAddress(addr),
      });
    }

    const baseActions: CommandAction[] = [
      // Navigation (9)
      {
        id: 'nav-overview',
        label: 'Overview',
        subtitle: 'ECU Identity, Modified Maps Summary & Health Dashboard',
        shortcut: '⌘0',
        group: 'Navigation',
        icon: <LayoutDashboard className="h-4 w-4 text-sky-400" />,
        run: () => onSwitchSection('overview'),
      },
      {
        id: 'nav-hex',
        label: 'Hex-Diff Editor',
        subtitle: 'Split binary diff, 2D waveform & code XRefs',
        group: 'Navigation',
        icon: <Binary className="h-4 w-4 text-sky-400" />,
        run: () => onSwitchSection('workspace', 'hex'),
      },
      {
        id: 'nav-map',
        label: 'Map Editor',
        subtitle: '2D table, 1D curves & 3D surface calibration',
        group: 'Navigation',
        icon: <Table2 className="h-4 w-4 text-sky-400" />,
        run: () => onSwitchSection('workspace', 'map'),
      },
      {
        id: 'nav-compare',
        label: 'Multi-Compare',
        subtitle: 'Side-by-side comparison across multiple BINs & Snapshots',
        group: 'Navigation',
        icon: <Columns3 className="h-4 w-4 text-purple-400" />,
        run: () => onSwitchSection('compare'),
      },
      {
        id: 'nav-discovery',
        label: 'Discovery & DTC',
        subtitle: 'Map Finder, DTC-Off Tables, Tune Porting & Batch',
        group: 'Navigation',
        icon: <Search className="h-4 w-4 text-sky-400" />,
        run: () => onSwitchSection('discovery'),
      },
      {
        id: 'nav-memory',
        label: 'Memory Atlas',
        subtitle: 'PFLASH Partitions, TPROT Sectors & Shared Axes',
        group: 'Navigation',
        icon: <HardDrive className="h-4 w-4 text-purple-400" />,
        run: () => onSwitchSection('memory'),
      },
      {
        id: 'nav-recipes',
        label: 'Recipes & Plugins',
        subtitle: 'Tuning recipes, JS plugins & reference library',
        group: 'Navigation',
        icon: <Sparkles className="h-4 w-4 text-amber-400" />,
        run: () => onSwitchSection('recipes'),
      },
      {
        id: 'nav-datalog',
        label: 'Datalog & Dyno',
        subtitle: '20 Hz WOT Dyno Pull, Scatter, Auto-Tune & OBD-II',
        group: 'Navigation',
        icon: <Activity className="h-4 w-4 text-emerald-400" />,
        run: () => onSwitchSection('datalog'),
      },
      {
        id: 'nav-flash',
        label: 'Flash Preflight',
        subtitle: 'Checksum triage, Diagnostics, Snapshots & HTML Report',
        group: 'Navigation',
        icon: <ShieldCheck className="h-4 w-4 text-sky-400" />,
        run: () => onSwitchSection('flash'),
      },

      // Layout (5)
      {
        id: 'layout-studio',
        label: 'Layout: Studio',
        subtitle: 'Balanced MacTuner workbench with sidebar & inspector',
        group: 'Layout',
        icon: <LayoutGrid className="h-4 w-4 text-sky-400" />,
        run: () => onSetLayoutMode?.('studio'),
      },
      {
        id: 'layout-ide',
        label: 'Layout: IDE',
        subtitle: 'Tabbed multi-map editor with Xcode-style bottom drawer',
        group: 'Layout',
        icon: <LayoutGrid className="h-4 w-4 text-purple-400" />,
        run: () => onSetLayoutMode?.('ide'),
      },
      {
        id: 'layout-canvas',
        label: 'Layout: Canvas',
        subtitle: 'Distraction-free full-bleed map & hex canvas',
        group: 'Layout',
        icon: <LayoutGrid className="h-4 w-4 text-emerald-400" />,
        run: () => onSetLayoutMode?.('canvas'),
      },
      {
        id: 'toggle-drawer',
        label: 'Toggle Bottom Drawer',
        subtitle: 'Show or hide 3D Surface, Datalog Trace & Preflight Atlas',
        shortcut: '⇧⌘Y',
        group: 'Layout',
        icon: <PanelBottom className="h-4 w-4 text-sky-400" />,
        run: () => onToggleBottomDrawer?.(),
      },
      {
        id: 'toggle-inspector',
        label: 'Toggle Inspector',
        subtitle: 'Show or hide right Map Properties & Preflight Inspector',
        shortcut: '⌥⌘I',
        group: 'Layout',
        icon: <PanelRight className="h-4 w-4 text-sky-400" />,
        run: () => onToggleInspector?.(),
      },

      // Actions (7)
      {
        id: 'act-toggle-lock',
        label: 'Toggle Map Lock',
        subtitle: 'Protect active map from accidental edits',
        shortcut: '⌘L',
        group: 'Actions',
        icon: <Lock className="h-4 w-4 text-amber-400" />,
        run: () => onToggleLock?.(),
      },
      {
        id: 'act-toggle-fav',
        label: 'Toggle Favorite',
        subtitle: 'Pin or unpin active map in Favorites scope',
        shortcut: '⌘D',
        group: 'Actions',
        icon: <Star className="h-4 w-4 text-amber-400" />,
        run: () => onToggleFavorite?.(),
      },
      {
        id: 'act-next-changed',
        label: 'Next Changed Map',
        subtitle: 'Jump to next modified map in XDF',
        shortcut: '⌥⌘↓',
        group: 'Actions',
        icon: <ArrowDown className="h-4 w-4 text-amber-400" />,
        run: () => onNextChangedMap?.(),
      },
      {
        id: 'act-prev-changed',
        label: 'Previous Changed Map',
        subtitle: 'Jump to previous modified map in XDF',
        shortcut: '⌥⌘↑',
        group: 'Actions',
        icon: <ArrowUp className="h-4 w-4 text-amber-400" />,
        run: () => onPrevChangedMap?.(),
      },
      {
        id: 'act-snapshot',
        label: 'Quick Snapshot',
        subtitle: 'Capture a named restore point of the current BIN',
        group: 'Actions',
        icon: <Camera className="h-4 w-4 text-emerald-400" />,
        run: () => onQuickSnapshot?.(),
      },
      {
        id: 'act-fix-cs',
        label: 'Fix Checksums',
        subtitle: 'Recalculate and repair all invalid ECU checksum blocks',
        group: 'Actions',
        icon: <Wand2 className="h-4 w-4 text-emerald-400" />,
        run: onFixChecksums,
      },
      {
        id: 'act-swap',
        label: 'Swap BINs',
        subtitle: 'Flip Active (L) and Comparison (R) files',
        group: 'Actions',
        icon: <ArrowLeftRight className="h-4 w-4 text-amber-400" />,
        run: onSwapBins,
      },

      // Export & Print (7)
      {
        id: 'exp-bin',
        label: 'Export BIN',
        subtitle: 'Open Pre-Save Review & download tuned .bin',
        shortcut: '⇧⌘E',
        group: 'Export',
        icon: <FileDown className="h-4 w-4 text-sky-400" />,
        run: () => onExportBin?.(),
      },
      {
        id: 'exp-xdf',
        label: 'Export XDF (.xdf)',
        subtitle: 'Export TunerPro v1.70 XML definition',
        group: 'Export',
        icon: <Download className="h-4 w-4 text-zinc-300" />,
        run: () => onExportDefinition?.('xdf', 'xdf'),
      },
      {
        id: 'exp-a2l',
        label: 'Export A2L (.a2l)',
        subtitle: 'Export ASAP2 ECU calibration definition',
        group: 'Export',
        icon: <Download className="h-4 w-4 text-zinc-300" />,
        run: () => onExportDefinition?.('a2l', 'a2l'),
      },
      {
        id: 'exp-csv',
        label: 'Export CSV (.csv)',
        subtitle: 'Export WinOLS CSV map list',
        group: 'Export',
        icon: <Download className="h-4 w-4 text-zinc-300" />,
        run: () => onExportDefinition?.('csv', 'csv'),
      },
      {
        id: 'exp-kp',
        label: 'Export KP (.kp)',
        subtitle: 'Export WinOLS binary map pack',
        group: 'Export',
        icon: <Download className="h-4 w-4 text-zinc-300" />,
        run: () => onExportDefinition?.('kp', 'kp'),
      },
      {
        id: 'exp-xml',
        label: 'Export RomRaider XML (.xml)',
        subtitle: 'Export RomRaider ECU XML definition',
        group: 'Export',
        icon: <Download className="h-4 w-4 text-zinc-300" />,
        run: () => onExportDefinition?.('xml', 'xml'),
      },
      {
        id: 'act-print',
        label: 'Print / Save PDF',
        subtitle: 'Print calibration summary or save PDF report',
        shortcut: '⌘P',
        group: 'Export',
        icon: <Printer className="h-4 w-4 text-zinc-300" />,
        run: () => onPrint?.(),
      },

      // Appearance: Heatmap Palettes (5) & Units (3)
      {
        id: 'pal-classic',
        label: 'Heatmap Palette: Classic',
        subtitle: 'Traditional blue → cyan → green → yellow → red',
        group: 'Appearance',
        icon: <Palette className="h-4 w-4 text-sky-400" />,
        run: () => onSetHeatmapPalette?.('classic'),
      },
      {
        id: 'pal-viridis',
        label: 'Heatmap Palette: Viridis',
        subtitle: 'Perceptually uniform scientific colormap (CVD-safe)',
        group: 'Appearance',
        icon: <Palette className="h-4 w-4 text-emerald-400" />,
        run: () => onSetHeatmapPalette?.('viridis'),
      },
      {
        id: 'pal-cividis',
        label: 'Heatmap Palette: Cividis',
        subtitle: 'Deuteranopia & protanopia safe colormap',
        group: 'Appearance',
        icon: <Palette className="h-4 w-4 text-amber-400" />,
        run: () => onSetHeatmapPalette?.('cividis'),
      },
      {
        id: 'pal-plasma',
        label: 'Heatmap Palette: Plasma',
        subtitle: 'High-dynamic indigo → magenta → bright yellow',
        group: 'Appearance',
        icon: <Palette className="h-4 w-4 text-fuchsia-400" />,
        run: () => onSetHeatmapPalette?.('plasma'),
      },
      {
        id: 'pal-hc',
        label: 'Heatmap Palette: High-Contrast',
        subtitle: 'Maximum legibility diverging slate-blue → crimson',
        group: 'Appearance',
        icon: <Palette className="h-4 w-4 text-rose-400" />,
        run: () => onSetHeatmapPalette?.('high-contrast'),
      },
      {
        id: 'unit-original',
        label: 'Units: Original',
        subtitle: 'Show native XDF units without conversion',
        group: 'Appearance',
        icon: <Scale className="h-4 w-4 text-zinc-300" />,
        run: () => onSetUnitSystem?.('original'),
      },
      {
        id: 'unit-metric',
        label: 'Units: Metric',
        subtitle: 'Convert to °C, bar, Nm, km/h, λ',
        group: 'Appearance',
        icon: <Scale className="h-4 w-4 text-sky-400" />,
        run: () => onSetUnitSystem?.('metric'),
      },
      {
        id: 'unit-imperial',
        label: 'Units: Imperial',
        subtitle: 'Convert to °F, psi, lb-ft, mph, AFR',
        group: 'Appearance',
        icon: <Scale className="h-4 w-4 text-amber-400" />,
        run: () => onSetUnitSystem?.('imperial'),
      },
    ];

    const mapActions: CommandAction[] = items.map((it) => ({
      id: `map-${it.id}`,
      label: it.title,
      subtitle: `0x${it.data.address.toString(16).toUpperCase().padStart(5, '0')} · ${it.data.rows}×${it.data.cols}`,
      group: 'Maps',
      icon: <Table2 className="h-4 w-4 text-sky-300" />,
      run: () => onSelectMap(it),
    }));

    const detActions: CommandAction[] = candidates.slice(0, 20).map((c) => ({
      id: `det-${c.id}`,
      label: `0x${c.address.toString(16).toUpperCase().padStart(5, '0')} (${c.rows}×${c.cols})`,
      subtitle: `${c.evidence} · ${c.shortBadge}`,
      group: 'Detected',
      icon: <Sparkles className="h-4 w-4 text-amber-400" />,
      run: () => onJumpAddress(c.address),
    }));

    const lower = q.toLowerCase();
    const filter = (a: CommandAction) =>
      !lower ||
      a.label.toLowerCase().includes(lower) ||
      (a.subtitle?.toLowerCase().includes(lower) ?? false) ||
      a.group.toLowerCase().includes(lower);

    return [
      ...out,
      ...baseActions.filter(filter),
      ...mapActions.filter(filter),
      ...detActions.filter(filter),
    ].slice(0, 60);
  }, [
    query,
    items,
    candidates,
    onSelectMap,
    onJumpAddress,
    onSelectHexRange,
    onSetHexColumns,
    onSwitchSection,
    onFixChecksums,
    onSwapBins,
    onSetLayoutMode,
    onToggleBottomDrawer,
    onToggleInspector,
    onToggleLock,
    onToggleFavorite,
    onNextChangedMap,
    onPrevChangedMap,
    onQuickSnapshot,
    onExportBin,
    onExportDefinition,
    onPrint,
    onSetHeatmapPalette,
    onSetUnitSystem,
  ]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[10vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-popover w-full max-w-xl overflow-hidden rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onClose();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIdx((i) => Math.min(actions.length - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIdx((i) => Math.max(0, i - 1));
          } else if (e.key === 'Enter' && actions[selectedIdx]) {
            e.preventDefault();
            actions[selectedIdx].run();
            onClose();
          }
        }}
      >
        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <Search className="h-4 w-4 text-slate-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Command, map, :80000, 20000..201FF, or cols=16…"
            className="w-full bg-transparent text-sm text-white placeholder-slate-400 outline-none"
          />
          <kbd className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
            ESC
          </kbd>
        </div>

        <div className="max-h-[420px] overflow-y-auto p-2">
          {actions.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">No matching maps or commands</div>
          ) : (
            actions.map((act, idx) => {
              const active = idx === selectedIdx;
              return (
                <button
                  key={act.id}
                  type="button"
                  onMouseEnter={() => setSelectedIdx(idx)}
                  onClick={() => {
                    act.run();
                    onClose();
                  }}
                  className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left transition cursor-pointer ${
                    active ? 'bg-[#2589ff]/20 text-white' : 'text-slate-300 hover:bg-white/5'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {act.icon}
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-white">{act.label}</div>
                      {act.subtitle && <div className="truncate text-[11px] text-slate-400">{act.subtitle}</div>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {act.shortcut && (
                      <kbd className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                        {act.shortcut}
                      </kbd>
                    )}
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-400">{act.group}</span>
                    {active && <CornerDownLeft className="h-3.5 w-3.5 text-sky-400" />}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
