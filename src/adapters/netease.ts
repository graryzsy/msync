import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { itemSchema, MSyncError, snapshotSchema, type Kind, type MusicItem, type MusicService, type Snapshot, type WriteOutcome } from '../core/models.js';
import { execute, type API, type Request } from './netease-api.js';
import { parseResponse } from './response.js';
import { createNeteaseContext, type NeteaseContext } from './netease-context.js';

export class NeteaseService implements MusicService {
  readonly platform = 'netease';
  constructor(private cookie: string, private api?: API, private context?: NeteaseContext) {}
  private static api?: API;
  private static contexts = new WeakMap<API, { cookieHash: string; context: NeteaseContext }>();
  static library(): API { return this.api ??= createRequire(import.meta.url)('@neteasecloudmusicapienhanced/api') as API; }
  static async invoke(request: Request, api?: API, context?: NeteaseContext): Promise<unknown> {
    try { return await execute(request, api ?? this.library(), context); }
    catch (error) {
      if (error instanceof MSyncError) throw error;
      throw new MSyncError('网易云连接或数据读取失败，请检查登录和网络后重试');
    }
  }
  private invoke(request: Request): Promise<unknown> {
    const api = this.api ?? NeteaseService.library();
    if (!this.context) {
      const cookieHash = createHash('sha256').update(this.cookie).digest('hex');
      let shared = NeteaseService.contexts.get(api);
      if (!shared || shared.cookieHash !== cookieHash) {
        shared = { cookieHash, context: createNeteaseContext({ minIntervalMS: 250 }) }; NeteaseService.contexts.set(api, shared);
      }
      this.context = shared.context;
    }
    return NeteaseService.invoke({ ...request, cookie: this.cookie }, api, this.context);
  }
  async snapshot(kind: Kind): Promise<Snapshot> { return parseResponse(snapshotSchema, await this.invoke({ action: 'snapshot', kind }), `网易云 ${kind} 收藏列表`); }
  async search(item: MusicItem): Promise<MusicItem[]> { return parseResponse(z.array(itemSchema), await this.invoke({ action: 'search', kind: item.kind, query: [item.title, ...item.artists].join(' ') }), '网易云搜索结果'); }
  async setSaved(saved: boolean, item: MusicItem): Promise<WriteOutcome> {
    if (item.platform !== 'netease') throw new MSyncError('条目平台不一致');
    await this.invoke({ action: 'write', kind: item.kind, id: item.id, saved }); return { applied: true };
  }
  static async startLogin(): Promise<{ key: string; image: string }> {
    return z.object({ key: z.string(), image: z.string().startsWith('data:image/png;base64,') }).parse(await this.invoke({ action: 'qrStart' }));
  }
  static async checkLogin(key: string): Promise<{ code: number; cookie?: string }> {
    return z.object({ code: z.number(), cookie: z.string().optional() }).parse(await this.invoke({ action: 'qrCheck', key }));
  }
}
