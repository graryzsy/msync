import type { AppAPI, AppView, SearchResult, Settings, WebTask, WebTaskSummary } from '../shared/api.js';
import type { ApplyReport, Kind, Mapping, MusicItem, Platform } from '../core/models.js';
import { allowedExternalURL } from '../shared/urls.js';

const sessionExpired = () => window.dispatchEvent(new Event('msync-session-expired'));
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try { response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', headers: { 'X-MSync-Request': '1', ...init.headers } }); }
  catch { throw new Error('无法连接 MSync 后台，请确认后台仍在运行'); }
  if (response.ok) return response;
  if (response.status === 401 && path !== '/api/session') sessionExpired();
  let message = '请求未完成，请稍后重试';
  try { const body = await response.json(); if (typeof body.error === 'string') message = body.error; } catch { /* Never display HTML proxy responses. */ }
  throw new Error(message);
}
async function json<T>(path: string, init?: RequestInit): Promise<T> { return (await (await request(path, init)).json()).value as T; }
const post = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
async function action<T>(name: string, ...args: unknown[]): Promise<T> {
  const { id } = await json<{ id: string }>(`/api/actions/${name}`, post({ args }));
  for (;;) {
    const task = await json<WebTask>(`/api/tasks/${id}`);
    if (task.state === 'succeeded') return task.value as T;
    if (task.state === 'failed') throw new Error(task.error ?? '操作未完成，请重试');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
async function download(path: string, filename: string): Promise<boolean> {
  const blob = await (await request(path)).blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000); return true;
}
async function pickBackup(): Promise<File | undefined> {
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'; input.style.display = 'none';
    const finish = (file?: File) => { input.remove(); resolve(file); };
    input.addEventListener('change', () => finish(input.files?.[0]), { once: true });
    input.addEventListener('cancel', () => finish(), { once: true }); document.body.append(input); input.click();
  });
}
class BrowserAPI implements AppAPI {
  getSession(): Promise<{ authenticated: boolean }> { return json('/api/session'); }
  loginWebSession(token: string): Promise<void> { return json('/api/session', post({ token })); }
  async logoutWebSession(): Promise<void> { await json('/api/session', { method: 'DELETE' }); sessionExpired(); }
  getActivity(): Promise<WebTaskSummary | null> { return json('/api/activity'); }
  getState(): Promise<AppView> { return json('/api/state'); }
  saveSettings(settings: Pick<Settings, 'spotifyClientID' | 'appleMode'>): Promise<AppView> { return action('saveSettings', settings); }
  connectSpotify(): Promise<AppView> { return action('connectSpotify'); }
  cancelLogin(): Promise<void> { return json('/api/cancel-login', post({})); }
  disconnect(platform: Platform): Promise<AppView> { return action('disconnect', platform); }
  startNeteaseLogin(): Promise<{ key: string; image: string }> { return action('startNeteaseLogin'); }
  checkNeteaseLogin(key: string): Promise<{ code: number; view: AppView }> { return action('checkNeteaseLogin', key); }
  scan(): Promise<AppView> { return action('scan'); }
  inspectSpotifyIssues(): Promise<AppView> { return action('inspectSpotifyIssues'); }
  exportSpotifyDiagnostics(): Promise<boolean> { return download('/api/downloads/spotify-diagnostics', 'msync-spotify-diagnostics.json'); }
  apply(id: string): Promise<{ report: ApplyReport; view: AppView }> { return action('apply', id); }
  search(item: MusicItem, platform: Platform): Promise<SearchResult[]> { return action('search', item, platform); }
  addMapping(mapping: Mapping): Promise<AppView> { return action('addMapping', mapping); }
  removeMapping(id: string): Promise<AppView> { return action('removeMapping', id); }
  recordApple(item: MusicItem, saved: boolean): Promise<AppView> { return action('recordApple', item, saved); }
  exportBackup(): Promise<boolean> { return download('/api/downloads/backup', 'msync-backup.json'); }
  async importBackup(): Promise<AppView> {
    const file = await pickBackup(); if (!file) return this.getState();
    if (file.size > 64 * 1024 * 1024) throw new Error('备份文件超过 64 MB');
    let backup: unknown;
    try { backup = JSON.parse(await file.text()); } catch { throw new Error('备份 JSON 格式无效，当前记录保持原样'); }
    if (!window.confirm('用备份中的对应关系和历史替换后台记录？平台收藏与登录凭据保持原样。建议先导出当前记录。')) return this.getState();
    return action('importBackup', backup);
  }
  resetHistory(): Promise<AppView> {
    return window.confirm('清除后台的对应关系与同步历史？平台收藏、网页确认记录和登录凭据保持原样。建议先导出备份。') ? action('resetHistory') : this.getState();
  }
  async openExternal(url: string): Promise<void> { window.open(allowedExternalURL(url).toString(), '_blank', 'noopener,noreferrer'); }
  demoMode(enabled: boolean): Promise<AppView> { return action('demoMode', enabled); }
  simulateDemoChange(platform: Platform, saved: boolean, kind: Kind): Promise<AppView> { return action('simulateDemoChange', platform, saved, kind); }
}
export const api = new BrowserAPI();
