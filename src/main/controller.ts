import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { StateStore } from '../core/store.js';
import { SyncCoordinator } from '../core/coordinator.js';
import { assess } from '../core/matcher.js';
import { createDemo, type DemoService } from '../core/demo.js';
import { atomicWrite } from '../core/persistence.js';
import { MSyncError, type Kind, type Mapping, type MusicItem, type MusicService, type Platform, type Snapshot, type SyncPlan } from '../core/models.js';
import { AppleNativeService } from '../adapters/apple-native.js';
import { AppleWebService, ManualAppleLibrary } from '../adapters/apple-web.js';
import { NeteaseService } from '../adapters/netease.js';
import { SpotifyService } from '../adapters/spotify.js';
import { SpotifyLogin, tokenSchema } from '../adapters/spotify-oauth.js';
import type { AppView, Connection, SearchResult, Settings } from '../shared/api.js';
import { CredentialVault } from './credentials.js';

const settingsSchema = z.object({ spotifyClientID: z.string(), appleMode: z.enum(['native', 'web', 'disabled']), appleWebAccountID: z.string().min(1) });
export class AppController {
  private settings: Settings;
  private plan: SyncPlan | null = null;
  private snapshots: Snapshot[] = [];
  private services: MusicService[] = [];
  private coordinator: SyncCoordinator;
  private demoStore?: StateStore;
  private demoServices?: DemoService[];
  private busy = false;
  private qrKey?: string;
  private login = new SpotifyLogin();
  private message = '连接账户，核实发行版本，再查看同步预览。';
  readonly manualApple: ManualAppleLibrary;
  constructor(private directory: string, private liveStore: StateStore, private vault: CredentialVault, private scriptPath: string, private openURL: (url: string) => Promise<void>) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.settings = existsSync(join(directory, 'settings.json')) ? settingsSchema.parse(JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8'))) : { spotifyClientID: '', appleMode: process.platform === 'darwin' ? 'native' : 'web', appleWebAccountID: `apple-web:${randomUUID()}` };
    atomicWrite(join(directory, 'settings.json'), JSON.stringify(this.settings));
    this.manualApple = new ManualAppleLibrary(join(directory, 'apple-web.json'));
    this.coordinator = new SyncCoordinator(liveStore);
  }
  get store(): StateStore { return this.demoStore ?? this.liveStore; }
  private async job<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new MSyncError('已有任务正在进行，请等待完成'); this.busy = true;
    try { return await work(); } finally { this.busy = false; }
  }
  view(): AppView {
    const token = this.vault.get('spotify');
    const spotifyConnected = !!token && tokenSchema.parse(JSON.parse(token)).clientID === this.settings.spotifyClientID;
    const connections: Connection[] = [
      { platform: 'spotify', connected: !!this.demoStore || spotifyConnected, mode: '官方 API', detail: '浏览器授权 · 收藏与关注读写' },
      { platform: 'appleMusic', connected: !!this.demoStore || this.settings.appleMode !== 'disabled' && (this.settings.appleMode !== 'native' || process.platform === 'darwin'), mode: this.settings.appleMode === 'native' ? '本机音乐 App' : this.settings.appleMode === 'web' ? '网页确认' : '未启用', detail: this.settings.appleMode === 'native' ? 'macOS 专用 · 资料库内歌曲与专辑星标' : '三平台通用 · 需要在网页操作并手动确认状态' },
      { platform: 'netease', connected: !!this.demoStore || !!this.vault.get('netease'), mode: '社区接口', detail: '扫码登录 · 歌曲、专辑与艺人收藏' }
    ];
    return { settings: this.settings, state: this.store.load(), snapshots: this.snapshots, plan: this.plan, connections, demo: !!this.demoStore, os: process.platform, credentialStorage: this.vault.mode, message: this.message, manualApple: this.manualApple.list() };
  }
  private configuredServices(): MusicService[] {
    if (this.demoServices) return this.demoServices;
    const services: MusicService[] = [], token = this.vault.get('spotify');
    if (token) {
      const parsed = tokenSchema.parse(JSON.parse(token));
      if (parsed.clientID === this.settings.spotifyClientID) services.push(new SpotifyService(parsed, token => this.vault.set('spotify', JSON.stringify(token))));
    }
    if (this.settings.appleMode === 'native' && process.platform === 'darwin') services.push(new AppleNativeService(this.scriptPath));
    if (this.settings.appleMode === 'web') services.push(new AppleWebService(this.manualApple, this.settings.appleWebAccountID));
    const cookie = this.vault.get('netease'); if (cookie) services.push(new NeteaseService(cookie));
    if (!services.length) throw new MSyncError('请先连接至少一个平台'); return services;
  }
  saveSettings(input: Pick<Settings, 'spotifyClientID' | 'appleMode'>): Promise<AppView> {
    return this.job(async () => {
      if (this.demoStore) throw new MSyncError('请先退出离线演示再修改真实账户设置');
      this.settings = { ...this.settings, ...input }; atomicWrite(join(this.directory, 'settings.json'), JSON.stringify(this.settings));
      this.plan = null; this.services = []; this.message = '设置已保存，请重新扫描。'; return this.view();
    });
  }
  connectSpotify(): Promise<AppView> {
    return this.job(async () => {
      if (this.demoStore) throw new MSyncError('请先退出离线演示再连接账户');
      const token = await this.login.connect(this.settings.spotifyClientID, this.openURL);
      this.vault.set('spotify', JSON.stringify(token)); this.plan = null; this.message = 'Spotify 已连接。'; return this.view();
    });
  }
  cancelLogin(): void { this.login.cancel(); }
  disconnect(platform: Platform): Promise<AppView> {
    return this.job(async () => { if (this.demoStore) throw new MSyncError('离线演示不会断开真实账户，请先退出演示'); if (platform !== 'appleMusic') this.vault.set(platform, undefined); this.plan = null; this.services = []; this.message = '已移除本机登录凭据，平台收藏保持原样。'; return this.view(); });
  }
  startNeteaseLogin(): Promise<{ key: string; image: string }> {
    return this.job(async () => { if (this.demoStore) throw new MSyncError('请先退出演示'); const qr = await NeteaseService.startLogin(); this.qrKey = qr.key; return qr; });
  }
  checkNeteaseLogin(key: string): Promise<{ code: number; view: AppView }> {
    return this.job(async () => {
      if (this.demoStore) throw new MSyncError('请先退出演示再检查真实账户登录');
      if (!this.qrKey || key !== this.qrKey) throw new MSyncError('二维码已经失效，请重新生成');
      const result = await NeteaseService.checkLogin(key);
      if (result.code === 803) {
        if (!result.cookie) throw new MSyncError('登录凭据缺失'); this.vault.set('netease', result.cookie); this.qrKey = undefined; this.plan = null; this.message = '网易云已连接。';
      } else if (result.code === 800) { this.qrKey = undefined; this.message = '二维码过期，请重新生成。'; }
      return { code: result.code, view: this.view() };
    });
  }
  scan(): Promise<AppView> {
    return this.job(async () => {
      this.plan = null; this.services = this.configuredServices(); this.plan = await this.coordinator.preview(this.services); this.snapshots = this.plan.observations;
      const notes = this.plan.notes?.length ?? 0;
      this.message = `扫描完成：${this.plan.operations.length} 项待同步，${this.plan.issues.length} 项待处理${notes ? `，${notes} 条扫描说明` : ''}。`; return this.view();
    });
  }
  apply(id: string): Promise<{ report: Awaited<ReturnType<SyncCoordinator['apply']>>; view: AppView }> {
    return this.job(async () => {
      if (!this.plan || this.plan.id !== id) throw new MSyncError('同步预览已过期，请重新扫描');
      const plan = this.plan; this.plan = null;
      const report = await this.coordinator.apply(plan, this.services);
      this.message = `已完成 ${report.applied} 项操作，${report.pending.length} 项需要继续处理。`;
      return { report, view: this.view() };
    });
  }
  search(item: MusicItem, platform: Platform): Promise<SearchResult[]> {
    return this.job(async () => {
      const service = this.configuredServices().find(service => service.platform === platform);
      if (!service) throw new MSyncError('请先连接目标平台');
      return (await service.search(item)).map(candidate => ({ item: candidate, ...assess(item, candidate) }));
    });
  }
  addMapping(mapping: Mapping): Promise<AppView> { return this.job(async () => { this.store.addMapping(mapping); this.plan = null; this.message = '已确认对应关系，重新扫描后可以同步。'; return this.view(); }); }
  removeMapping(id: string): Promise<AppView> { return this.job(async () => { this.store.removeMapping(id); this.plan = null; return this.view(); }); }
  recordApple(item: MusicItem, saved: boolean): Promise<AppView> {
    return this.job(async () => {
      if (this.demoStore) throw new MSyncError('演示模式不会修改真实网页确认记录');
      if (this.settings.appleMode !== 'web') throw new MSyncError('请先在连接页选择 Apple Music 网页确认模式');
      this.manualApple.record(item, saved); this.plan = null; this.message = '已记录你确认的网页状态，请重新扫描以传播变更。'; return this.view();
    });
  }
  importBackup(input: unknown): Promise<AppView> { return this.job(async () => { this.store.importState(input); this.plan = null; this.snapshots = []; this.message = '已导入对应关系和历史，请检查账户后重新扫描。'; return this.view(); }); }
  resetHistory(): Promise<AppView> { return this.job(async () => { this.store.reset(); this.plan = null; this.snapshots = []; this.message = '本地基线已重置，平台收藏保持原样。'; return this.view(); }); }
  demoMode(enabled: boolean): Promise<AppView> {
    return this.job(async () => {
      this.plan = null; this.snapshots = []; this.services = [];
      if (enabled && !this.demoStore) { const demo = await createDemo(); this.demoStore = demo.store; this.demoServices = demo.services; }
      if (!enabled) { this.demoStore?.close(); this.demoStore = undefined; this.demoServices = undefined; }
      this.coordinator = new SyncCoordinator(this.store);
      if (this.demoServices) { this.services = this.demoServices; this.plan = await this.coordinator.preview(this.demoServices); this.snapshots = this.plan.observations; }
      this.message = enabled ? '离线演示已开启，所有操作只影响示例数据。' : '已回到个人收藏，真实账户与数据保持原样。'; return this.view();
    });
  }
  simulate(platform: Platform, saved: boolean, kind: Kind): Promise<AppView> {
    return this.job(async () => {
      const service = this.demoServices?.find(service => service.platform === platform); if (!service) throw new MSyncError('仅可在离线演示中模拟操作');
      await service.simulate(saved, kind); this.services = this.demoServices!; this.plan = await this.coordinator.preview(this.demoServices!); this.snapshots = this.plan.observations;
      this.message = '已模拟平台上的主动变更，可以查看同步预览。'; return this.view();
    });
  }
}
