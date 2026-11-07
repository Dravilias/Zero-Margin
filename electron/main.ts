import { app, BrowserWindow, Menu, ipcMain, safeStorage, session, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callChat, callWithFallbacks, normalizeEndpoint, type LlmServer, type LlmTierCall } from './llm';
import { fakeLlmReply, runSmoke } from './smoke';
import { REPO_PAGE, cleanEnv, isNewer, latestVersion, runUpdate, usableSource } from './update';

const smokeTest = process.env.ZM_SMOKE_TEST === '1';
const fakeLlm = smokeTest && process.env.ZM_SMOKE_CAMPAIGN === '1';
// A test run gets a throwaway profile, so it can't touch real settings, saves or a real key.
if (process.env.ZM_SMOKE_LEAK === '1') app.commandLine.appendSwitch('js-flags', '--expose-gc');
if (smokeTest) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'zm-smoke-')));

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0f1014',
    title: 'Zero Margin',
    show: !smokeTest || process.env.ZM_SMOKE_SHOW === '1',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A host who alt-tabs away must not slow the game down for everyone else.
      backgroundThrottling: false,
    },
  });
  Menu.setApplicationMenu(null);
  void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // The game has no external links; anything that tries to open one goes to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
  });

  if (smokeTest) runSmoke(win);
  return win;
}

/* ---------- Model servers: keys are encrypted here, each tied to one address, and never handed back to the page ---------- */

const keyFile = () => path.join(app.getPath('userData'), 'llm.key');
const configFile = () => path.join(app.getPath('userData'), 'llm.json');
const MAX_SERVERS = 4;
let servers: LlmServer[] | null = null;

/** Linux without a keyring falls back to a hard-coded password, which isn't really encryption. */
function canEncrypt(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

function loadServers(): LlmServer[] {
  if (servers) return servers;
  servers = [];
  try {
    const saved = JSON.parse(fs.readFileSync(configFile(), 'utf8')) as Omit<LlmServer, 'key'>[];
    let keys: string[] = [];
    try {
      if (canEncrypt()) keys = JSON.parse(safeStorage.decryptString(fs.readFileSync(keyFile()))) as string[];
    } catch { /* no saved keys, or they can't be read on this machine */ }
    servers = saved.slice(0, MAX_SERVERS).map((c, i) => ({ endpoint: normalizeEndpoint(c.endpoint) ?? '', writer: String(c.writer ?? ''), runner: String(c.runner ?? ''), key: String(keys[i] ?? '') }));
  } catch { /* nothing configured yet */ }
  return servers;
}

type ServerInput = { endpoint?: unknown; key?: unknown; writer?: unknown; runner?: unknown };

/** Changing a server's address without giving a new key forgets the old one, so a key can't go to a server it wasn't entered for. */
function configure(input: ServerInput[]): { ok: boolean; badServer?: number; saved: boolean } {
  const old = loadServers();
  const next: LlmServer[] = [];
  for (const [i, c] of input.slice(0, MAX_SERVERS).entries()) {
    const raw = String(c?.endpoint ?? '').slice(0, 300).trim();
    const endpoint = raw ? normalizeEndpoint(raw) : '';
    if (endpoint === null) return { ok: false, badServer: i, saved: false };
    const typed = String(c?.key ?? '').slice(0, 500).trim();
    const kept = old[i]?.endpoint === endpoint ? old[i].key : '';
    next.push({ endpoint, key: endpoint ? typed || kept : '', writer: String(c?.writer ?? '').slice(0, 200).trim(), runner: String(c?.runner ?? '').slice(0, 200).trim() });
  }
  servers = next;
  const anyKey = next.some((s) => s.key);
  let saved = !anyKey;
  try {
    fs.writeFileSync(configFile(), JSON.stringify(next.map(({ endpoint, writer, runner }) => ({ endpoint, writer, runner }))));
    if (anyKey && canEncrypt()) {
      fs.writeFileSync(keyFile(), safeStorage.encryptString(JSON.stringify(next.map((s) => s.key))), { mode: 0o600 });
      saved = true;
    } else fs.rmSync(keyFile(), { force: true });
  } catch { /* it still works until the game closes */ }
  return { ok: true, saved };
}

function registerLlm(): void {
  ipcMain.handle('zm-llm-status', () => ({
    servers: loadServers().map(({ endpoint, writer, runner, key }) => ({ endpoint, writer, runner, hasKey: !!key })), canSave: canEncrypt(),
  }));
  ipcMain.handle('zm-llm-configure', (_e, input: unknown) => configure(Array.isArray(input) ? input as ServerInput[] : []));
  ipcMain.handle('zm-llm-generate', async (_e, req: LlmTierCall) => {
    const clean: LlmTierCall = {
      tier: req?.tier === 'writer' ? 'writer' : 'runner', system: String(req?.system ?? '').slice(0, 20000), prompt: String(req?.prompt ?? '').slice(0, 20000),
      json: !!req?.json, maxTokens: Math.max(16, Math.min(16000, Number(req?.maxTokens) || 500)),
    };
    return fakeLlm ? fakeLlmReply(clean) : callWithFallbacks(clean, loadServers());
  });
  // Tries every configured server on its own, so a bad fallback doesn't hide behind a good main server.
  ipcMain.handle('zm-llm-test', () => Promise.all(loadServers().map(async (s) => {
    if (!s.endpoint) return null;
    const model = s.runner || s.writer;
    if (!model) return { ok: false, reason: 'nokey' };
    return callChat({ model, system: 'Reply with one short word.', prompt: 'Say ready.', json: false, maxTokens: 50 }, s.endpoint, s.key);
  })));
}

// Two copies sharing one profile can't both save, so a second launch just brings the first one forward.
// The menu music should start with the menu, not wait for the first click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const firstCopy = app.requestSingleInstanceLock();
if (!firstCopy) app.quit();
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

/* ---------- Updates ---------- */

const installDir = () => path.join(process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share'), 'zero-margin');

/** install.sh records where the clone is. Only an installed copy updates itself, never a developer's own run. */
function updateSource(): string | null {
  if (!app.isPackaged || process.platform !== 'linux') return null;
  try {
    const dir = fs.readFileSync(path.join(installDir(), 'source-dir'), 'utf8').trim();
    return usableSource(dir) ? dir : null;
  } catch {
    return null;
  }
}

function registerUpdates(): void {
  ipcMain.handle('zm-update-check', async () => {
    const current = app.getVersion();
    // A test run has no business on the network, and can ask to pretend there's an update.
    const latest = smokeTest ? (process.env.ZM_SMOKE_UPDATE ?? null) : await latestVersion();
    return { current, latest, available: !!latest && isNewer(latest, current), canInstall: !!updateSource(), page: REPO_PAGE };
  });
  ipcMain.handle('zm-update-install', async () => {
    const dir = updateSource();
    if (!dir) return { ok: false, log: '' };
    const log = path.join(app.getPath('userData'), 'update.log');
    if (!await runUpdate(dir, log, process.env)) return { ok: false, log };
    // Wait a moment so this copy has let go of the single-copy lock when the new one starts.
    const installed = path.join(installDir(), 'ZeroMargin.AppImage');
    spawn('bash', ['-c', 'sleep 1; exec "$0"', installed], { detached: true, stdio: 'ignore', env: cleanEnv(process.env) }).unref();
    app.quit();
    return { ok: true, log };
  });
}

app.whenReady().then(() => {
  if (!firstCopy) return;
  // The game needs no camera, microphone or location; copying the join code is the only permission it uses.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'clipboard-sanitized-write'));
  ipcMain.on('zm-quit', () => app.quit());
  registerLlm();
  registerUpdates();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
