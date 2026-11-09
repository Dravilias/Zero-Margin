import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('zmDesktop', {
  quit: () => ipcRenderer.send('zm-quit'),
  updateCheck: () => ipcRenderer.invoke('zm-update-check'),
  updateInstall: () => ipcRenderer.invoke('zm-update-install'),
  onUpdateProgress: (listener: (percent: number) => void) => {
    ipcRenderer.removeAllListeners('zm-update-progress');
    ipcRenderer.on('zm-update-progress', (_e, percent: number) => listener(percent));
  },
  llmStatus: () => ipcRenderer.invoke('zm-llm-status'),
  llmConfigure: (servers: unknown) => ipcRenderer.invoke('zm-llm-configure', servers),
  llmTest: () => ipcRenderer.invoke('zm-llm-test'),
  llmGenerate: (req: unknown) => ipcRenderer.invoke('zm-llm-generate', req),
});
