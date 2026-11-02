import { contextBridge, ipcRenderer } from 'electron';

const invoke = (method: string, ...args: unknown[]): Promise<any> => ipcRenderer.invoke(`msync:${method}`, ...args).then((result: { ok: boolean; value?: unknown; error?: string }) => {
  if (!result.ok) throw new Error(result.error ?? '操作未完成');
  return result.value;
});
contextBridge.exposeInMainWorld('msync', Object.freeze({
  getState: () => invoke('getState'), saveSettings: (settings: unknown) => invoke('saveSettings', settings),
  connectSpotify: () => invoke('connectSpotify'), cancelLogin: () => invoke('cancelLogin'), disconnect: (platform: string) => invoke('disconnect', platform),
  startNeteaseLogin: () => invoke('startNeteaseLogin'), checkNeteaseLogin: (key: string) => invoke('checkNeteaseLogin', key),
  scan: () => invoke('scan'), apply: (id: string) => invoke('apply', id), search: (item: unknown, platform: string) => invoke('search', item, platform),
  addMapping: (mapping: unknown) => invoke('addMapping', mapping), removeMapping: (id: string) => invoke('removeMapping', id),
  recordApple: (item: unknown, saved: boolean) => invoke('recordApple', item, saved), exportBackup: () => invoke('exportBackup'), importBackup: () => invoke('importBackup'),
  resetHistory: () => invoke('resetHistory'), openExternal: (url: string) => invoke('openExternal', url), demoMode: (enabled: boolean) => invoke('demoMode', enabled),
  simulateDemoChange: (platform: string, saved: boolean, kind: string) => invoke('simulateDemoChange', platform, saved, kind)
}));
