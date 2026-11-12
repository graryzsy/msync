import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { z } from 'zod';
import { errorMessage, itemSchema, kindSchema, MSyncError, platformSchema } from '../core/models.js';
import type { AppController } from '../main/controller.js';
import { WebTasks } from './tasks.js';

const sessionCookie = 'msync_web_session';
const sessionLifetime = 8 * 60 * 60 * 1000;
class WebError extends MSyncError {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface WebServerOptions {
  controller: AppController; rendererDirectory: string; accessToken: string;
  host?: string; port?: number; devURL?: string;
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
}
async function body(request: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new WebError(415, '请求必须使用 JSON');
  if (Number(request.headers['content-length']) > limit) throw new WebError(413, '文件或请求内容过大');
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk); length += buffer.length;
    if (length > limit) throw new WebError(413, '文件或请求内容过大'); chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new WebError(400, '请求 JSON 无效'); }
}
function hash(value: string): Buffer { return createHash('sha256').update(value).digest(); }

export async function startWebServer(options: WebServerOptions) {
  const { controller } = options, host = options.host ?? '127.0.0.1';
  if (host !== 'localhost' && !isIP(host)) throw new MSyncError('MSYNC_WEB_HOST 必须是本机 IP 地址、127.0.0.1 或 0.0.0.0');
  if (options.accessToken.length < 24 || options.accessToken.length > 256) throw new MSyncError('网页访问口令需要 24 至 256 个字符');
  const secretHash = hash(options.accessToken), sessions = new Map<string, number>(), attempts = new Map<string, { count: number; until: number }>();
  const tasks = new WebTasks(), hosts = new Set<string>(), origins = new Set<string>();
  const none = z.tuple([]), uuid = z.tuple([z.string().uuid()]);
  const action = (label: string, schema: z.ZodTypeAny, work: (...args: any[]) => unknown) => ({ label, schema, work });
  const actions = new Map([
    ['saveSettings', action('保存设置', z.tuple([z.object({ spotifyClientID: z.string().trim().max(128), appleMode: z.enum(['native', 'web', 'disabled']) })]), value => controller.saveSettings(value))],
    ['connectSpotify', action('等待 Spotify 授权', none, () => controller.connectSpotify())],
    ['disconnect', action('断开账户', z.tuple([platformSchema]), platform => controller.disconnect(platform))],
    ['startNeteaseLogin', action('生成网易云登录二维码', none, () => controller.startNeteaseLogin())],
    ['checkNeteaseLogin', action('检查网易云登录', z.tuple([z.string().min(1).max(256)]), key => controller.checkNeteaseLogin(key))],
    ['scan', action('扫描收藏', none, () => controller.scan())],
    ['apply', action('执行同步', uuid, id => controller.apply(id))],
    ['inspectSpotifyIssues', action('检查 Spotify 异常条目', none, () => controller.inspectSpotifyIssues())],
    ['search', action('查找对应版本', z.tuple([itemSchema, platformSchema]), (item, platform) => controller.search(item, platform))],
    ['addMapping', action('确认对应关系', z.tuple([z.object({ id: z.string().uuid(), kind: kindSchema, items: z.array(itemSchema).min(2).max(3), verified: z.literal(true), evidence: z.string().trim().min(1).max(8000) })]), mapping => controller.addMapping(mapping))],
    ['removeMapping', action('移除对应关系', uuid, id => controller.removeMapping(id))],
    ['recordApple', action('记录网页确认状态', z.tuple([itemSchema, z.boolean()]), (item, saved) => controller.recordApple(item, saved))],
    ['importBackup', action('导入备份', z.tuple([z.unknown()]), async backup => {
      try { return await controller.importBackup(backup); }
      catch (error) { if (error instanceof MSyncError) throw error; throw new MSyncError('备份格式无效，当前记录保持原样'); }
    })],
    ['resetHistory', action('重新建立基线', none, () => controller.resetHistory())],
    ['demoMode', action('切换离线演示', z.tuple([z.boolean()]), enabled => controller.demoMode(enabled))],
    ['simulateDemoChange', action('模拟收藏变更', z.tuple([platformSchema, z.boolean(), kindSchema]), (platform, saved, kind) => controller.simulate(platform, saved, kind))]
  ]);
  const cookie = (request: IncomingMessage): string | undefined => {
    const values = request.headers.cookie?.split(';').map(part => part.trim()).filter(part => part.startsWith(`${sessionCookie}=`));
    if (values?.length !== 1) return undefined;
    const id = values[0]!.slice(sessionCookie.length + 1), expires = sessions.get(id);
    if (!expires || expires <= Date.now()) { sessions.delete(id); return undefined; } return id;
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    try {
      if (!hosts.has(request.headers.host ?? '')) throw new WebError(403, '网页访问地址不受信任');
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new WebError(400, '请求地址无效');
      const path = new URL(request.url, 'http://msync.invalid').pathname;
      if (path === '/health' && request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'text/plain' }).end('MSync'); return; }
      if (path.startsWith('/api/')) {
        if (request.headers['x-msync-request'] !== '1' || request.headers.origin && !origins.has(request.headers.origin)) throw new WebError(403, '拒绝其他网页发起的请求');
        if (path === '/api/session' && request.method === 'GET') { json(response, 200, { ok: true, value: { authenticated: !!cookie(request) } }); return; }
        if (path === '/api/session' && request.method === 'POST') {
          const address = request.socket.remoteAddress ?? 'unknown', now = Date.now(), previous = attempts.get(address);
          if (previous && previous.until > now && previous.count >= 5) { response.setHeader('Retry-After', Math.ceil((previous.until - now) / 1000)); throw new WebError(429, '口令尝试过于频繁，请稍后重试'); }
          const { token } = z.object({ token: z.string().max(256) }).parse(await body(request, 2048));
          if (!timingSafeEqual(hash(token), secretHash)) {
            if (attempts.size >= 1024) attempts.delete(attempts.keys().next().value!);
            attempts.set(address, { count: previous && previous.until > now ? previous.count + 1 : 1, until: previous && previous.until > now ? previous.until : now + 60_000 });
            throw new WebError(401, '网页访问口令不正确');
          }
          attempts.delete(address);
          for (const [id, expires] of sessions) if (expires <= now) sessions.delete(id);
          const old = cookie(request); if (old) sessions.delete(old);
          if (sessions.size >= 64) sessions.delete(sessions.keys().next().value!);
          const id = randomBytes(32).toString('base64url'); sessions.set(id, now + sessionLifetime);
          response.setHeader('Set-Cookie', `${sessionCookie}=${id}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${sessionLifetime / 1000}`);
          json(response, 200, { ok: true, value: null }); return;
        }
        const session = cookie(request); if (!session) throw new WebError(401, '网页会话已失效，请重新输入访问口令');
        if (path === '/api/session' && request.method === 'DELETE') {
          sessions.delete(session); response.setHeader('Set-Cookie', `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0`);
          json(response, 200, { ok: true, value: null }); return;
        }
        if (path === '/api/state' && request.method === 'GET') { json(response, 200, { ok: true, value: controller.view() }); return; }
        if (path === '/api/activity' && request.method === 'GET') { json(response, 200, { ok: true, value: tasks.activity() }); return; }
        if (path.startsWith('/api/tasks/') && request.method === 'GET') {
          const task = tasks.get(path.slice('/api/tasks/'.length)); if (!task) throw new WebError(404, '任务结果已过期，请刷新页面');
          json(response, 200, { ok: true, value: task }); return;
        }
        if (path === '/api/cancel-login' && request.method === 'POST') { await body(request); controller.cancelLogin(); json(response, 200, { ok: true, value: null }); return; }
        if (path.startsWith('/api/actions/') && request.method === 'POST') {
          const name = path.slice('/api/actions/'.length), selected = actions.get(name); if (!selected) throw new WebError(404, '未知操作');
          const { args } = z.object({ args: z.array(z.unknown()) }).parse(await body(request, name === 'importBackup' ? 64 * 1024 * 1024 : undefined));
          const parameters = selected.schema.parse(args);
          if (tasks.activity()?.state === 'running') throw new WebError(409, '已有任务正在进行，请等待完成');
          const id = tasks.start(selected.label, () => selected.work(...parameters));
          json(response, 202, { ok: true, value: { id } }); return;
        }
        if (request.method === 'GET' && (path === '/api/downloads/backup' || path === '/api/downloads/spotify-diagnostics')) {
          const diagnostic = path.endsWith('/spotify-diagnostics');
          const value = diagnostic ? controller.spotifyDiagnosticReport() : controller.store.load();
          response.setHeader('Content-Disposition', `attachment; filename="${diagnostic ? 'msync-spotify-diagnostics' : 'msync-backup'}.json"`);
          json(response, 200, value); return;
        }
        throw new WebError(404, '接口不存在');
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new WebError(405, '不支持此请求方式');
      // Serve only Vite's public output. Never expose the database, source files or credentials directory.
      const filename = path === '/' || path === '/index.html' ? 'index.html' : /^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?|png|svg|ico)$/u.test(path) ? path.slice(1) : undefined;
      if (!filename) throw new WebError(404, '页面不存在');
      let bytes: Buffer;
      try { bytes = await readFile(join(options.rendererDirectory, filename)); } catch { throw new WebError(404, '页面不存在，请先构建前端'); }
      const type = filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : filename.endsWith('.css') ? 'text/css; charset=utf-8' : filename.endsWith('.svg') ? 'image/svg+xml' : filename.endsWith('.png') ? 'image/png' : filename.endsWith('.ico') ? 'image/x-icon' : 'font/woff2';
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length }); response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) json(response, error instanceof WebError ? error.status : 400, { ok: false, error: error instanceof z.ZodError ? '输入内容无效，请检查后重试' : errorMessage(error) });
      else if (!response.destroyed) response.end();
    }
  });
  server.requestTimeout = 120_000; server.headersTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    const failed = () => reject(new MSyncError(`无法启动网页服务，请检查监听地址和端口 ${options.port ?? 19427} 是否可用`));
    server.once('error', failed); server.listen(options.port ?? 19427, host, () => { server.off('error', failed); resolve(); });
  });
  const address = server.address(); if (!address || typeof address === 'string') throw new MSyncError('网页服务未能启动');
  const addHost = (hostname: string) => {
    const authority = `${hostname.includes(':') ? `[${hostname}]` : hostname}:${address.port}`;
    hosts.add(authority); origins.add(`http://${authority}`);
  };
  addHost('127.0.0.1'); addHost('localhost'); addHost('::1');
  if (host === '0.0.0.0' || host === '::') {
    for (const values of Object.values(networkInterfaces())) for (const value of values ?? []) if (!value.address.includes('%')) addHost(value.address);
  } else addHost(host);
  if (options.devURL) origins.add(new URL(options.devURL).origin);
  const hostname = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${address.port}`;
  return { server, url, browserURL: `${options.devURL ?? url}/#msync-access=${encodeURIComponent(options.accessToken)}`,
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}
