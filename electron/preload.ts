import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('zmDesktop', {
  quit: () => ipcRenderer.send('zm-quit'),
  llmStatus: () => ipcRenderer.invoke('zm-llm-status'),
  llmConfigure: (cfg: { endpoint: string; key: string }) => ipcRenderer.invoke('zm-llm-configure', cfg),
  llmGenerate: (req: unknown) => ipcRenderer.invoke('zm-llm-generate', req),
});
