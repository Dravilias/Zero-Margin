import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

/*
 * Compares this copy with the version on GitHub. A copy installed from a clone updates itself from the repo;
 * the Windows build downloads the installer from the newest release, checks it and runs it.
 */

const REMOTE_PACKAGE = 'https://raw.githubusercontent.com/Dravilias/Zero-Margin/main/package.json';
export const REPO_PAGE = 'https://github.com/Dravilias/Zero-Margin';
export const RELEASE_FEED = 'https://api.github.com/repos/Dravilias/Zero-Margin/releases/latest';
const RELEASE_FILES = 'https://github.com/Dravilias/Zero-Margin/releases/download/';
const CHECK_TIMEOUT_MS = 8000;
const UPDATE_TIMEOUT_MS = 30 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

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

export interface ReleaseFile { name: string; url: string; size: number; sha256: string }
export interface Release { version: string; page: string; windows: ReleaseFile | null }

/**
 * The newest published release, or null if it can't be found out. Only a file from this repo's own releases,
 * with the exact expected name and a checksum, counts as the Windows installer. A test feed may point elsewhere.
 */
export async function latestRelease(fetchImpl: typeof fetch = fetch, feed = RELEASE_FEED): Promise<Release | null> {
  try {
    const res = await fetchImpl(feed, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ZeroMargin-updater' },
    });
    if (!res.ok) return null;
    const j = await res.json() as Record<string, unknown>;
    if (j.draft || j.prerelease) return null;
    const version = String(j.tag_name ?? '').replace(/^v/, '');
    if (!parts(version)) return null;
    const page = typeof j.html_url === 'string' && j.html_url.startsWith('https://github.com/') ? j.html_url : REPO_PAGE;
    const name = `ZeroMargin-${version}-win-x64-setup.exe`;
    const asset = (Array.isArray(j.assets) ? j.assets : []).find((a: Record<string, unknown>) => a?.name === name) as Record<string, unknown> | undefined;
    const url = String(asset?.browser_download_url ?? '');
    const size = Number(asset?.size);
    const digest = /^sha256:([0-9a-f]{64})$/.exec(String(asset?.digest ?? ''));
    const trusted = feed === RELEASE_FEED ? url.startsWith(RELEASE_FILES) : /^https?:\/\//.test(url);
    const windows = asset && trusted && Number.isFinite(size) && size > 0 && digest ? { name, url, size, sha256: digest[1] } : null;
    return { version, page, windows };
  } catch {
    return null;
  }
}

/** Downloads a release file and keeps it only if its size and checksum match what GitHub says they are. */
export async function downloadChecked(
  file: ReleaseFile, dest: string, onProgress: (done: number) => void = () => {},
  fetchImpl: typeof fetch = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS,
): Promise<{ ok: boolean; reason?: string }> {
  const part = `${dest}.part`;
  let fd: number | null = null;
  try {
    const res = await fetchImpl(file.url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'ZeroMargin-updater' } });
    if (!res.ok || !res.body) return { ok: false, reason: `download failed with status ${res.status}` };
    const hash = createHash('sha256');
    let done = 0;
    fd = fs.openSync(part, 'w');
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      done += chunk.length;
      if (done > file.size) return { ok: false, reason: 'the file is bigger than the release says' };
      hash.update(chunk);
      fs.writeSync(fd, chunk);
      onProgress(done);
    }
    fs.closeSync(fd);
    fd = null;
    if (done !== file.size) return { ok: false, reason: `got ${done} bytes, expected ${file.size}` };
    if (hash.digest('hex') !== file.sha256) return { ok: false, reason: 'the checksum does not match the release' };
    fs.renameSync(part, dest);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e) };
  } finally {
    if (fd !== null) fs.closeSync(fd);
    if (fs.existsSync(part)) fs.rmSync(part, { force: true });
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
