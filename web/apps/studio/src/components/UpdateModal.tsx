import React, { useState } from 'react';
import { ArrowUpCircle, CheckCircle2, Download, ExternalLink, RefreshCw, X } from 'lucide-react';
import { APP_VERSION, installDesktopUpdate, type UpdateInfo } from '../lib/updater';

interface UpdateModalProps {
  open: boolean;
  info: UpdateInfo | null;
  checking: boolean;
  onCheckNow: () => void;
  onClose: () => void;
}

export const UpdateModal: React.FC<UpdateModalProps> = ({
  open,
  info,
  checking,
  onCheckNow,
  onClose,
}) => {
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleInstall = async () => {
    setInstalling(true);
    setError(null);
    try {
      const ok = await installDesktopUpdate((p) => setProgress(p));
      if (!ok && info?.releaseUrl) {
        window.open(info.releaseUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update installation failed');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="glass-popover w-full max-w-md rounded-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-3.5">
          <div className="flex items-center gap-2">
            <ArrowUpCircle className="h-4 w-4 text-[#0a84ff]" />
            <span className="text-sm font-semibold text-white">MacTuner Updates</span>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-white/[0.06] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between rounded-xl bg-[#101115] border border-white/[0.06] px-4 py-3">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-zinc-500">Installed Version</div>
              <div className="font-mono text-sm font-semibold text-zinc-100">v{APP_VERSION}</div>
            </div>
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-wider text-zinc-500">Latest Release</div>
              <div className="font-mono text-sm font-semibold text-sky-400">
                {checking ? 'Checking…' : info ? `v${info.latestVersion}` : '—'}
              </div>
            </div>
          </div>

          {info?.available ? (
            <div className="space-y-3">
              <div className="rounded-xl bg-[#0a84ff]/12 border border-[#0a84ff]/30 px-3.5 py-2.5 text-xs text-sky-200">
                <strong>MacTuner v{info.latestVersion}</strong> is available for{' '}
                {info.isDesktop ? 'automatic signed installation' : 'download on GitHub'}.
              </div>
              {info.notes && (
                <div className="max-h-36 overflow-y-auto rounded-xl bg-[#101115] border border-white/[0.06] p-3 text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed">
                  {info.notes}
                </div>
              )}
              {installing && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-[11px] font-mono text-zinc-400">
                    <span>Downloading signed package…</span>
                    <span>{progress}%</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full bg-[#0a84ff] transition-all duration-200"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              )}
              {error && <div className="text-xs text-rose-400">{error}</div>}
            </div>
          ) : (
            <div className="flex items-center gap-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 px-3.5 py-3 text-xs text-emerald-300">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>MacTuner is up to date (v{APP_VERSION}).</span>
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <button
              onClick={onCheckNow}
              disabled={checking || installing}
              className="flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-white/[0.1] disabled:opacity-40 transition"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
              Check Now
            </button>

            {info?.available && (
              info.isDesktop ? (
                <button
                  onClick={() => void handleInstall()}
                  disabled={installing}
                  className="flex items-center gap-1.5 rounded-lg bg-[#0a84ff] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#1f90ff] disabled:opacity-50 transition"
                >
                  <Download className="h-3.5 w-3.5" />
                  {installing ? `Installing (${progress}%)…` : 'Install & Relaunch'}
                </button>
              ) : (
                <a
                  href={info.releaseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 rounded-lg bg-[#0a84ff] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#1f90ff] transition"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  View Release
                </a>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
