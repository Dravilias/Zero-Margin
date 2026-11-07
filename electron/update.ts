import { spawn } from 'node:child_process';
import fs from 'node:fs';

/* Compares this copy with the version in the GitHub repo, and updates a copy that was installed from a clone. */

const REMOTE_PACKAGE = 'https://raw.githubusercontent.com/Dravilias/Zero-Margin/main/package.json';
export const REPO_PAGE = 'https://github.com/Dravilias/Zero-Margin';
const CHECK_TIMEOUT_MS = 8000;
const UPDATE_TIMEOUT_MS = 30 * 60 * 1000;

const parts = (version: string): number[] | null => (/^\d+\.\d+\.\d+$/.test(version) ? version.split('.').map(Number) : null);

export function isNewer(candidate: string, current: string): boolean {
  const a = parts(candidate);
  const b = parts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The newest version in the repo, or null if it can't be found out. Being offline is no reason to bother anyone. */
export async function latestVersion(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(REMOTE_PACKAGE, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), redirect: 'error' });
    if (!res.ok) return null;
    const { version } = await res.json() as { version?: unknown };
    return typeof version === 'string' && parts(version) ? version : null;
  } catch {
    return null;
  }
}

/** A folder only counts as the game's source if it's a git clone with the install script in it. */
export function usableSource(dir: string): boolean {
  return dir.startsWith('/') && fs.existsSync(`${dir}/.git`) && fs.existsSync(`${dir}/install.sh`);
}

/** An AppImage's own library settings would break the system tools the update runs. */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const k of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'LD_LIBRARY_PATH', 'LD_PRELOAD', 'GSETTINGS_SCHEMA_DIR', 'ELECTRON_RUN_AS_NODE', 'CHROME_DESKTOP']) delete clean[k];
  if (clean.PATH) clean.PATH = clean.PATH.split(':').filter((p) => !p.includes('/.mount_')).join(':');
  return clean;
}

/** Runs the same two steps a player would type. A login shell finds Node however it was installed. */
export function runUpdate(dir: string, logPath: string, env: NodeJS.ProcessEnv, timeoutMs = UPDATE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const log = fs.openSync(logPath, 'w');
    const child = spawn('bash', ['-lc', 'git pull --ff-only && ./install.sh'], { cwd: dir, env: cleanEnv(env), stdio: ['ignore', log, log] });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      fs.closeSync(log);
      resolve(ok);
    };
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
  });
}
