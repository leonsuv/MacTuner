import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeftRight,
  Binary,
  CornerDownLeft,
  HardDrive,
  Search,
  ShieldCheck,
  Sparkles,
  Table2,
  Wand2,
} from 'lucide-react';
import type { MapCandidate, XDFItem } from '@mactuner/core';

export interface CommandAction {
  id: string;
  label: string;
  subtitle?: string;
  group: 'Actions' | 'Maps' | 'Detected' | 'Jump';
  icon: React.ReactNode;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  items: XDFItem[];
  candidates: MapCandidate[];
  onSelectMap: (item: XDFItem) => void;
  onJumpAddress: (addr: number) => void;
  onSwitchSection: (sec: 'workspace' | 'discovery' | 'memory' | 'datalog' | 'flash') => void;
  onFixChecksums: () => void;
  onSwapBins: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  items,
  candidates,
  onSelectMap,
  onJumpAddress,
  onSwitchSection,
  onFixChecksums,
  onSwapBins,
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

    // Direct hex jump if user typed 0x... or 4-6 hex chars
    const hexMatch = q.match(/^(?:0x)?([0-9a-fA-F]{4,6})$/);
    if (hexMatch) {
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
        label: 'Swap Active & Comparison BIN',
        subtitle: 'Flip Left (Active) and Right (Comparison) files',
        group: 'Actions',
        icon: <ArrowLeftRight className="h-4 w-4 text-amber-400" />,
        run: onSwapBins,
      },
      {
        id: 'nav-discovery',
        label: 'Open Discovery & DTCs',
        subtitle: 'Map Finder, DTC Tables & Tune Porting',
        group: 'Actions',
        icon: <Search className="h-4 w-4 text-sky-400" />,
        run: () => onSwitchSection('discovery'),
      },
      {
        id: 'nav-memory',
        label: 'Open Memory Map',
        subtitle: 'Visual Flash Partitions & Sector Breakdown',
        group: 'Actions',
        icon: <HardDrive className="h-4 w-4 text-purple-400" />,
        run: () => onSwitchSection('memory'),
      },
      {
        id: 'nav-datalog',
        label: 'Open Datalogger',
        subtitle: '20 Hz WOT Dyno Pull & CSV Telemetry',
        group: 'Actions',
        icon: <Activity className="h-4 w-4 text-emerald-400" />,
        run: () => onSwitchSection('datalog'),
      },
      {
        id: 'nav-flash',
        label: 'Open Flash Preflight & Export',
        subtitle: 'Checksum triage, TPROT check & Flash-Tool export',
        group: 'Actions',
        icon: <ShieldCheck className="h-4 w-4 text-sky-400" />,
        run: () => onSwitchSection('flash'),
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

    const detActions: CommandAction[] = candidates.slice(0, 12).map((c) => ({
      id: `det-${c.id}`,
      label: `0x${c.address.toString(16).toUpperCase().padStart(5, '0')} (${c.rows}×${c.cols})`,
      subtitle: `${c.evidence} · ${c.shortBadge}`,
      group: 'Detected',
      icon: <Sparkles className="h-4 w-4 text-amber-400" />,
      run: () => onJumpAddress(c.address),
    }));

    const lower = q.toLowerCase();
    const filter = (a: CommandAction) =>
      !lower || a.label.toLowerCase().includes(lower) || (a.subtitle?.toLowerCase().includes(lower) ?? false);

    return [...out, ...mapActions.filter(filter), ...baseActions.filter(filter), ...detActions.filter(filter)].slice(0, 16);
  }, [query, items, candidates, onSelectMap, onJumpAddress, onSwitchSection, onFixChecksums, onSwapBins]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh] backdrop-blur-sm"
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
            placeholder="Jump to map, hex address (0x24024), or command…"
            className="w-full bg-transparent text-sm text-white placeholder-slate-400 outline-none"
          />
          <kbd className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
            ESC
          </kbd>
        </div>

        <div className="max-h-80 overflow-y-auto p-2">
          {actions.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">No matching maps or commands</div>
          ) : (
            actions.map((act, idx) => {
              const active = idx === selectedIdx;
              return (
                <button
                  key={act.id}
                  onMouseEnter={() => setSelectedIdx(idx)}
                  onClick={() => {
                    act.run();
                    onClose();
                  }}
                  className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left transition ${
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
