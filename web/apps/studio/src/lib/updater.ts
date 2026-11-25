export const APP_VERSION = '4.1.2';
export const GITHUB_REPO = 'leonsuv/MacTuner';

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  notes: string;
  releaseUrl: string;
  isDesktop: boolean;
}

interface TauriUpdaterHandle {
  version: string;
  body?: string;
  downloadAndInstall: (
    onEvent?: (ev: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void,
  ) => Promise<void>;
}

interface TauriGlobal {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: {
    updater?: {
      check: () => Promise<TauriUpdaterHandle | null>;
    };
    process?: {
      relaunch: () => Promise<void>;
    };
  };
}

export function isTauriDesktop(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as TauriGlobal).__TAURI_INTERNALS__);
}

export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

let cachedTauriUpdate: TauriUpdaterHandle | null = null;

/**
 * Checks for updates automatically:
 * - On Tauri v2 Desktop (macOS / Windows / Linux): uses native signed `latest.json` updater.
 * - On Web: checks GitHub Releases API for newer versions.
 */
export async function checkForUpdates(): Promise<UpdateInfo | null> {
  const desktop = isTauriDesktop();
  const g = window as unknown as TauriGlobal;

  if (desktop && g.__TAURI__?.updater?.check) {
    try {
      const upd = await g.__TAURI__.updater.check();
      if (upd) {
        cachedTauriUpdate = upd;
        return {
          available: true,
          currentVersion: APP_VERSION,
          latestVersion: upd.version.replace(/^v/i, ''),
          notes: upd.body ?? '',
          releaseUrl: `https://github.com/${GITHUB_REPO}/releases/latest`,
          isDesktop: true,
        };
      }
      return {
        available: false,
        currentVersion: APP_VERSION,
        latestVersion: APP_VERSION,
        notes: '',
        releaseUrl: `https://github.com/${GITHUB_REPO}/releases/latest`,
        isDesktop: true,
      };
    } catch {
      // Fall through to GitHub Releases API check if updater pubkey isn't configured yet
    }
  }

  try {
    const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { tag_name?: string; body?: string; html_url?: string };
    const latest = (data.tag_name ?? APP_VERSION).replace(/^v/i, '');
    return {
      available: compareSemver(latest, APP_VERSION) > 0,
      currentVersion: APP_VERSION,
      latestVersion: latest,
      notes: data.body ?? '',
      releaseUrl: data.html_url ?? `https://github.com/${GITHUB_REPO}/releases/latest`,
      isDesktop: desktop,
    };
  } catch {
    return null;
  }
}

export async function installDesktopUpdate(onProgress?: (pct: number) => void): Promise<boolean> {
  if (!cachedTauriUpdate) return false;
  let total = 0;
  let downloaded = 0;
  await cachedTauriUpdate.downloadAndInstall((ev) => {
    if (ev.event === 'Started' && ev.data?.contentLength) {
      total = ev.data.contentLength;
    } else if (ev.event === 'Progress' && ev.data?.chunkLength) {
      downloaded += ev.data.chunkLength;
      if (total > 0 && onProgress) {
        onProgress(Math.min(100, Math.round((downloaded / total) * 100)));
      }
    } else if (ev.event === 'Finished' && onProgress) {
      onProgress(100);
    }
  });
  const g = window as unknown as TauriGlobal;
  if (g.__TAURI__?.process?.relaunch) {
    await g.__TAURI__.process.relaunch();
  }
  return true;
}
