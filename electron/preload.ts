import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('zmDesktop', {
  quit: () => ipcRenderer.send('zm-quit'),
  updateCheck: () => ipcRenderer.invoke('zm-update-check'),
  updateInstall: () => ipcRenderer.invoke('zm-update-install'),
  llmStatus: () => ipcRenderer.invoke('zm-llm-status'),
  llmConfigure: (servers: unknown) => ipcRenderer.invoke('zm-llm-configure', servers),
  llmTest: () => ipcRenderer.invoke('zm-llm-test'),
  llmGenerate: (req: unknown) => ipcRenderer.invoke('zm-llm-generate', req),
});
