import { app, BrowserWindow, Menu, ipcMain, safeStorage, session, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callChat, normalizeEndpoint, type LlmCall } from './llm';
import { fakeLlmReply, runSmoke } from './smoke';

const smokeTest = process.env.ZM_SMOKE_TEST === '1';
const fakeLlm = smokeTest && process.env.ZM_SMOKE_CAMPAIGN === '1';
// A test run gets a throwaway profile, so it can't touch real settings, saves or a real key.
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

/* ---------- The model server: the key is encrypted here, tied to one address, and never handed back to the page ---------- */

const keyFile = () => path.join(app.getPath('userData'), 'llm.key');
const endpointFile = () => path.join(app.getPath('userData'), 'llm-endpoint.txt');
let keyInMemory = '';
let endpointInMemory = '';

/** Linux without a keyring falls back to a hard-coded password, which isn't really encryption. */
function canEncrypt(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

function loadEndpoint(): string {
  if (endpointInMemory) return endpointInMemory;
  try {
    endpointInMemory = normalizeEndpoint(fs.readFileSync(endpointFile(), 'utf8')) ?? '';
  } catch { /* nothing configured yet */ }
  return endpointInMemory;
}

function loadKey(): string {
  if (keyInMemory) return keyInMemory;
  try {
    if (canEncrypt()) keyInMemory = safeStorage.decryptString(fs.readFileSync(keyFile()));
  } catch { /* no saved key yet, or it can't be read on this machine */ }
  return keyInMemory;
}

/** Changing the address without giving a new key forgets the old one, so a key can't be sent to a server it wasn't entered for. */
function configure(rawEndpoint: string, newKey: string): { ok: boolean; saved: boolean } {
  const endpoint = rawEndpoint.trim() ? normalizeEndpoint(rawEndpoint) : '';
  if (endpoint === null) return { ok: false, saved: false };
  const moved = endpoint !== loadEndpoint();
  const key = newKey.trim() || (moved ? '' : loadKey());
  endpointInMemory = endpoint;
  keyInMemory = key;
  let saved = false;
  try {
    if (endpoint) fs.writeFileSync(endpointFile(), endpoint);
    else fs.rmSync(endpointFile(), { force: true });
    if (key && canEncrypt()) {
      fs.writeFileSync(keyFile(), safeStorage.encryptString(key), { mode: 0o600 });
      saved = true;
    } else fs.rmSync(keyFile(), { force: true });
  } catch { /* it still works until the game closes */ }
  return { ok: true, saved: saved || !key };
}

function registerLlm(): void {
  ipcMain.handle('zm-llm-status', () => ({
    endpoint: fakeLlm ? 'http://localhost:9/v1' : loadEndpoint(), hasKey: !!loadKey(), canSave: canEncrypt(),
  }));
  ipcMain.handle('zm-llm-configure', (_e, cfg: { endpoint?: unknown; key?: unknown }) =>
    configure(String(cfg?.endpoint ?? '').slice(0, 300), String(cfg?.key ?? '').slice(0, 500)));
  ipcMain.handle('zm-llm-generate', async (_e, req: LlmCall) => {
    const clean: LlmCall = {
      model: String(req?.model ?? '').slice(0, 200), system: String(req?.system ?? '').slice(0, 20000), prompt: String(req?.prompt ?? '').slice(0, 20000),
      json: !!req?.json, maxTokens: Math.max(16, Math.min(16000, Number(req?.maxTokens) || 500)),
    };
    return fakeLlm ? fakeLlmReply(clean) : callChat(clean, loadEndpoint(), loadKey());
  });
}

app.whenReady().then(() => {
  // The game needs no camera, microphone or location; copying the join code is the only permission it uses.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'clipboard-sanitized-write'));
  ipcMain.on('zm-quit', () => app.quit());
  registerLlm();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
