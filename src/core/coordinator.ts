import { randomUUID } from 'node:crypto';
import { errorMessage, kinds, labels, MSyncError, observedState, snapshotKey, snapshotSchema, type MusicService, type SyncPlan, type ApplyReport, type Snapshot } from './models.js';
import { planSync } from './planner.js';
import { StateStore } from './store.js';

export class SyncCoordinator {
  private running = false;
  constructor(private store: StateStore) {}
  private async exclusively<T>(work: () => Promise<T>): Promise<T> {
    if (this.running) throw new MSyncError('已有同步任务正在执行');
    this.running = true; try { return await work(); } finally { this.running = false; }
  }
  private async read(service: MusicService, kind: typeof kinds[number]): Promise<Snapshot> {
    const value = snapshotSchema.parse(await service.snapshot(kind));
    if (value.platform !== service.platform || value.kind !== kind) throw new MSyncError('平台返回的收藏列表身份不一致');
    return value;
  }
  preview(services: MusicService[]): Promise<SyncPlan> {
    return this.exclusively(async () => {
      const state = this.store.load(), observations: Snapshot[] = [], failures: SyncPlan['issues'] = [];
      for (const service of services) for (const kind of kinds) {
        try { observations.push(await this.read(service, kind)); }
        catch (error) { failures.push({ id: randomUUID(), message: `${labels[service.platform]} · ${kind}：${errorMessage(error)}` }); }
      }
      const plan = planSync(state, observations); plan.issues.push(...failures); return plan;
    });
  }
  apply(plan: SyncPlan, services: MusicService[]): Promise<ApplyReport> {
    return this.exclusively(async () => {
      const state = this.store.load();
      if (state.revision !== plan.baseRevision) throw new MSyncError('预览已过期，请重新扫描');
      for (const observed of plan.observations) {
        const service = services.find(service => service.platform === observed.platform);
        if (!service) throw new MSyncError('连接配置已改变，请重新扫描');
        const fresh = await this.read(service, observed.kind);
        if (fresh.accountID !== observed.accountID) throw new MSyncError('账户已改变，请重新建立基线');
        const items = state.mappings.flatMap(mapping => mapping.items).filter(item => snapshotKey(item) === snapshotKey(fresh));
        if (items.some(item => observedState(fresh, item.id) !== observedState(observed, item.id))) throw new MSyncError('预览后收藏状态已变化，请重新扫描');
      }
      this.store.begin(plan);
      const report: ApplyReport = { applied: 0, pending: [] };
      for (const operation of plan.operations) {
        try {
          const service = services.find(service => service.platform === operation.item.platform);
          if (!service) throw new MSyncError('目标平台连接不可用');
          const fresh = await this.read(service, operation.item.kind);
          const original = plan.observations.find(snapshot => snapshotKey(snapshot) === snapshotKey(fresh));
          if (!original || original.accountID !== fresh.accountID) throw new MSyncError('执行期间账户改变');
          if (observedState(fresh, operation.item.id) !== operation.saved) {
            if (observedState(fresh, operation.item.id) !== observedState(original, operation.item.id)) throw new MSyncError('条目状态在执行期间变化，请重新预览');
            const outcome = await service.setSaved(operation.saved, operation.item);
            if (!outcome.applied) { report.pending.push({ operationID: operation.id, platform: operation.item.platform, title: operation.item.title, message: outcome.message, ...(outcome.url ? { url: outcome.url } : {}) }); continue; }
          }
          this.store.acknowledge(operation, plan.id, await this.read(service, operation.item.kind)); report.applied++;
        } catch (error) { report.pending.push({ operationID: operation.id, platform: operation.item.platform, title: operation.item.title, message: errorMessage(error) }); }
      }
      return report;
    });
  }
}
