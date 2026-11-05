import { app, BrowserWindow, Menu, ipcMain, safeStorage, session, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callGemini, type GeminiRequest } from './gemini';
import { fakeGemini, runSmoke } from './smoke';

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

/* ---------- The Gemini key: kept encrypted by this process and never handed back to the page ---------- */

const keyFile = () => path.join(app.getPath('userData'), 'gemini.key');
let keyInMemory = '';

/** Linux without a keyring falls back to a hard-coded password, which isn't really encryption. */
function canEncrypt(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

function loadKey(): string {
  if (keyInMemory) return keyInMemory;
  try {
    if (canEncrypt()) keyInMemory = safeStorage.decryptString(fs.readFileSync(keyFile()));
  } catch { /* no saved key yet, or it can't be read on this machine */ }
  return keyInMemory;
}

function setKey(key: string): { saved: boolean } {
  keyInMemory = key.trim();
  try {
    if (!keyInMemory) fs.rmSync(keyFile(), { force: true });
    else if (canEncrypt()) {
      fs.writeFileSync(keyFile(), safeStorage.encryptString(keyInMemory), { mode: 0o600 });
      return { saved: true };
    }
  } catch { /* it still works until the game closes */ }
  return { saved: false };
}

function registerLlm(): void {
  ipcMain.handle('zm-llm-status', () => ({ hasKey: fakeLlm || !!loadKey(), canSave: canEncrypt() }));
  ipcMain.handle('zm-llm-set-key', (_e, key: unknown) => setKey(typeof key === 'string' ? key.slice(0, 200) : ''));
  ipcMain.handle('zm-llm-generate', async (_e, req: GeminiRequest) => {
    const clean: GeminiRequest = {
      model: String(req?.model ?? ''), system: String(req?.system ?? '').slice(0, 20000), prompt: String(req?.prompt ?? '').slice(0, 20000),
      json: !!req?.json, maxTokens: Math.max(16, Math.min(16000, Number(req?.maxTokens) || 500)),
    };
    return fakeLlm ? fakeGemini(clean) : callGemini(clean, loadKey());
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
