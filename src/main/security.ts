import { MSyncError } from '../core/models.js';

const allowedHosts = new Set(['open.spotify.com', 'accounts.spotify.com', 'developer.spotify.com', 'music.apple.com', 'music.163.com']);
export function allowedExternalURL(address: string): URL {
  let url: URL;
  try { url = new URL(address); } catch { throw new MSyncError('页面链接无效'); }
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || url.port || url.username || url.password) throw new MSyncError('仅允许打开受支持音乐平台的 HTTPS 页面');
  return url;
}
export function trustedRenderer(address: string, expectedFile: string, devURL?: string): boolean {
  try {
    const url = new URL(address);
    if (devURL) return url.origin === new URL(devURL).origin && url.pathname === '/';
    return url.href === new URL(expectedFile).href;
  } catch { return false; }
}
