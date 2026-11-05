import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('zmDesktop', {
  quit: () => ipcRenderer.send('zm-quit'),
  llmStatus: () => ipcRenderer.invoke('zm-llm-status'),
  llmSetKey: (key: string) => ipcRenderer.invoke('zm-llm-set-key', key),
  llmGenerate: (req: unknown) => ipcRenderer.invoke('zm-llm-generate', req),
});
