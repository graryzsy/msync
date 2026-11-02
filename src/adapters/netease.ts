import { createRequire } from 'node:module';
import { z } from 'zod';
import { itemSchema, MSyncError, snapshotSchema, type Kind, type MusicItem, type MusicService, type Snapshot, type WriteOutcome } from '../core/models.js';
import { execute, type API, type Request } from './netease-api.js';

export class NeteaseService implements MusicService {
  readonly platform = 'netease';
  constructor(private cookie: string, private api?: API) {}
  private static api?: API;
  static library(): API { return this.api ??= createRequire(import.meta.url)('@neteasecloudmusicapienhanced/api') as API; }
  static async invoke(request: Request, api?: API): Promise<unknown> {
    try { return await execute(request, api ?? this.library()); }
    catch { throw new MSyncError('网易云连接或数据读取失败，请检查登录和网络后重试'); }
  }
  async snapshot(kind: Kind): Promise<Snapshot> { return snapshotSchema.parse(await NeteaseService.invoke({ action: 'snapshot', kind, cookie: this.cookie }, this.api)); }
  async search(item: MusicItem): Promise<MusicItem[]> { return z.array(itemSchema).parse(await NeteaseService.invoke({ action: 'search', kind: item.kind, cookie: this.cookie, query: [item.title, ...item.artists].join(' ') }, this.api)); }
  async setSaved(saved: boolean, item: MusicItem): Promise<WriteOutcome> {
    if (item.platform !== 'netease') throw new MSyncError('条目平台不一致');
    await NeteaseService.invoke({ action: 'write', kind: item.kind, id: item.id, saved, cookie: this.cookie }, this.api); return { applied: true };
  }
  static async startLogin(): Promise<{ key: string; image: string }> {
    return z.object({ key: z.string(), image: z.string().startsWith('data:image/png;base64,') }).parse(await this.invoke({ action: 'qrStart' }));
  }
  static async checkLogin(key: string): Promise<{ code: number; cookie?: string }> {
    return z.object({ code: z.number(), cookie: z.string().optional() }).parse(await this.invoke({ action: 'qrCheck', key }));
  }
}
