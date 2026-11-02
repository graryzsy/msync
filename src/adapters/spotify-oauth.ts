import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import { MSyncError } from '../core/models.js';
import { http, type Fetcher } from './http.js';

export const redirectURI = 'http://127.0.0.1:19428/callback';
export interface SpotifyToken { accessToken: string; refreshToken: string; expiresAt: string; clientID: string }
export const tokenSchema = z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1), expiresAt: z.string().datetime(), clientID: z.string().min(1) });
export function pkceChallenge(verifier: string): string { return createHash('sha256').update(verifier).digest('base64url'); }
export function authorizationURL(clientID: string, verifier: string, state: string): URL {
  if (!/^[a-fA-F0-9]{32}$/u.test(clientID)) throw new MSyncError('请填写 Spotify Dashboard 中的 32 位 Client ID');
  const url = new URL('https://accounts.spotify.com/authorize');
  url.search = new URLSearchParams({ client_id: clientID, response_type: 'code', redirect_uri: redirectURI, state,
    code_challenge_method: 'S256', code_challenge: pkceChallenge(verifier), scope: 'user-library-read user-library-modify user-follow-read user-follow-modify' }).toString();
  return url;
}
export function authorizationCode(callback: URL, expectedState: string): string {
  if (callback.origin !== 'http://127.0.0.1:19428' || callback.pathname !== '/callback' || callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== expectedState) throw new MSyncError('Spotify 授权回调校验失败');
  const codes = callback.searchParams.getAll('code');
  if (callback.searchParams.has('error') || codes.length !== 1 || !codes[0]) throw new MSyncError('Spotify 授权已取消或未完成');
  return codes[0];
}
async function tokenRequest(fields: Record<string, string>, clientID: string, oldRefresh?: string, fetcher?: Fetcher): Promise<SpotifyToken> {
  const response = await http('https://accounts.spotify.com/api/token', { method: 'POST', body: new URLSearchParams(fields), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, fetcher);
  const body = z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(), expires_in: z.number().positive() }).parse(await response.json());
  const refreshToken = body.refresh_token ?? oldRefresh;
  if (!refreshToken) throw new MSyncError('未获得 Spotify 刷新令牌');
  return { accessToken: body.access_token, refreshToken, expiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString(), clientID };
}
export function refreshToken(token: SpotifyToken, fetcher?: Fetcher): Promise<SpotifyToken> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refreshToken, client_id: token.clientID }, token.clientID, token.refreshToken, fetcher);
}
export class SpotifyLogin {
  constructor(private fetcher: Fetcher = fetch) {}
  private server?: Server;
  private cancelPending?: () => void;
  cancel(): void { this.cancelPending?.(); }
  async connect(clientID: string, openURL: (url: string) => Promise<void>): Promise<SpotifyToken> {
    if (this.server) throw new MSyncError('已有授权正在等待完成');
    const verifier = randomBytes(48).toString('base64url'), state = randomBytes(32).toString('hex');
    const url = authorizationURL(clientID, verifier, state);
    const code = await new Promise<string>((resolve, reject) => {
      const finish = (error?: Error, result?: string): void => {
        clearTimeout(timer); this.cancelPending = undefined; this.server?.close(); this.server = undefined;
        if (error) reject(error); else resolve(result!);
      };
      const timer = setTimeout(() => finish(new MSyncError('授权等待超时，请重试')), 300_000);
      timer.unref(); this.cancelPending = () => finish(new MSyncError('已取消授权'));
      this.server = createServer((request, response) => {
        if (request.method !== 'GET' || !request.url?.startsWith('/callback?')) { response.writeHead(404).end(); return; }
        const callback = new URL(request.url, redirectURI);
        if (callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== state) { response.writeHead(400).end('Invalid state'); return; }
        try {
          const result = authorizationCode(callback, state);
          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('授权完成，可以返回 MSync。');
          finish(undefined, result);
        } catch (error) { response.writeHead(400).end('Authorization not completed'); finish(error instanceof Error ? error : new MSyncError('授权失败')); }
      });
      this.server.once('error', () => finish(new MSyncError('无法启动本地授权回调，请检查端口 19428')));
      this.server.listen(19428, '127.0.0.1', () => { openURL(url.toString()).catch(() => finish(new MSyncError('无法打开系统浏览器'))); });
    });
    return tokenRequest({ grant_type: 'authorization_code', client_id: clientID, code, redirect_uri: redirectURI, code_verifier: verifier }, clientID, undefined, this.fetcher);
  }
}
