import initSqlJs, { type Database } from 'sql.js';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { atomicWrite } from './persistence.js';
import { assess, exactDate } from './matcher.js';
import { emptyState, itemKey, itemSchema, kindSchema, labels, mappingTitle, MSyncError, observedState, snapshotKey, snapshotSchema, type StoredState, type Mapping, type SyncPlan, type Operation, type Snapshot } from './models.js';

const mappingSchema = z.object({ id: z.string().uuid(), kind: kindSchema, items: z.array(itemSchema), verified: z.boolean(), evidence: z.string() });
const operationSchema = z.object({ id: z.string().uuid(), mappingID: z.string().uuid(), item: itemSchema, saved: z.boolean(), reason: z.string() });
export const stateSchema = z.object({
  revision: z.number().int().nonnegative(), mappings: z.array(mappingSchema), snapshots: z.array(snapshotSchema),
  desired: z.record(z.boolean()), audit: z.array(z.object({ id: z.string().uuid(), time: z.string(), message: z.string() })),
  activePlanID: z.string().uuid().optional(), outstanding: z.array(operationSchema)
});
const fingerprint = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
let sqlite: ReturnType<typeof initSqlJs> | undefined;
function validateMapping(mapping: Mapping): void {
  if (!mapping.verified || mapping.items.length < 2 || !mapping.evidence.trim() || new Set(mapping.items.map(item => item.platform)).size !== mapping.items.length || mapping.items.some(item => item.kind !== mapping.kind)) throw new MSyncError('请确认至少两个平台的对应条目，并填写核实依据');
  if (mapping.kind !== 'artist' && mapping.items.some(item => !exactDate(item.release?.date?.value))) throw new MSyncError('必须核实完整发行年月日后才能建立对应关系');
  if (mapping.items.slice(1).some(item => assess(mapping.items[0]!, item).decision === 'different')) throw new MSyncError('发行版本、日期或曲目存在硬冲突');
}

export class StateStore {
  private expectedFileHash?: string;
  private constructor(private db: Database, private path: string | undefined, private createDatabase: (bytes?: Uint8Array) => Database) {}
  static async open(path?: string): Promise<StateStore> {
    sqlite ??= initSqlJs({ wasmBinary: Uint8Array.from(readFileSync(createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm'))).buffer });
    const SQL = await sqlite;
    if (path) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (path && existsSync(`${path}-wal`) && readFileSync(`${path}-wal`).length) throw new MSyncError('该数据库仍有未合并的 WAL，请先关闭旧程序并导出备份');
    const bytes = path && existsSync(path) ? readFileSync(path) : undefined;
    const createDatabase = (bytes?: Uint8Array): Database => new SQL.Database(bytes);
    const store = new StateStore(createDatabase(bytes), path, createDatabase);
    if (bytes) store.expectedFileHash = fingerprint(bytes);
    store.db.run('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL)');
    store.load();
    return store;
  }
  load(): StoredState {
    const statement = this.db.prepare('SELECT payload FROM state WHERE id=1');
    try {
      if (!statement.step()) return emptyState();
      const payload = statement.get()[0];
      if (!(payload instanceof Uint8Array) && typeof payload !== 'string') throw new MSyncError('本地状态内容无效');
      return stateSchema.parse(JSON.parse(typeof payload === 'string' ? payload : new TextDecoder().decode(payload)));
    } catch (error) {
      if (error instanceof MSyncError) throw error;
      throw new MSyncError('本地状态库无法读取，已保留原文件；请恢复备份或使用新的数据目录');
    } finally { statement.free(); }
  }
  private mutate(body: (state: StoredState) => void): void {
    const state = this.load();
    body(state); state.revision++; state.audit = state.audit.slice(-500);
    const validated = stateSchema.parse(state);
    const prior = this.db.export();
    try {
      if (this.path) {
        const currentHash = existsSync(this.path) ? fingerprint(readFileSync(this.path)) : undefined;
        if (currentHash !== this.expectedFileHash) throw new MSyncError('数据库被另一个进程修改，请关闭其他实例并重新打开');
      }
      this.db.run('BEGIN IMMEDIATE');
      this.db.run('INSERT INTO state(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', [new TextEncoder().encode(JSON.stringify(validated))]);
      this.db.run('COMMIT');
      if (this.path) {
        const bytes = this.db.export(); atomicWrite(this.path, bytes); this.expectedFileHash = fingerprint(bytes);
      }
    } catch (error) {
      this.db.close();
      this.db = this.createDatabase(prior);
      throw error;
    }
  }
  private audit(state: StoredState, message: string): void { state.audit.push({ id: randomUUID(), time: new Date().toISOString(), message }); }
  addMapping(value: Mapping): void {
    const mapping = mappingSchema.parse(value);
    validateMapping(mapping);
    this.mutate(state => {
      if (state.outstanding.length) throw new MSyncError('请先重新预览并处理未完成的同步');
      const incoming = new Set(mapping.items.map(itemKey));
      const overlaps = state.mappings.filter(existing => existing.items.some(item => incoming.has(itemKey(item))));
      if (overlaps.length > 1) throw new MSyncError('条目属于不同对应关系，不能自动合并');
      const existing = overlaps[0];
      if (!existing) state.mappings.push(mapping);
      else {
        const additions = mapping.items.filter(item => !existing.items.some(prior => itemKey(prior) === itemKey(item)));
        if (!additions.length || new Set([...existing.items, ...additions].map(item => item.platform)).size !== existing.items.length + additions.length) throw new MSyncError('同一平台已经存在对应版本');
        for (const item of mapping.items) {
          const prior = existing.items.find(prior => itemKey(prior) === itemKey(item));
          if (prior && prior.release?.date?.value !== item.release?.date?.value) throw new MSyncError('已确认条目的日期发生变化，请先核查原对应关系');
        }
        if (additions.some(item => assess(existing.items[0]!, item).decision === 'different')) throw new MSyncError('与原有对应版本存在冲突');
        existing.items.push(...additions); existing.evidence += `\n${mapping.evidence}`;
      }
      this.audit(state, `确认对应关系：${mappingTitle(mapping)}`);
    });
  }
  removeMapping(id: string): void {
    this.mutate(state => {
      if (state.outstanding.length) throw new MSyncError('请先处理未完成的同步');
      state.mappings = state.mappings.filter(mapping => mapping.id !== id); delete state.desired[id];
      this.audit(state, '移除本地对应关系；平台收藏保持原样');
    });
  }
  begin(plan: SyncPlan): void {
    this.mutate(state => {
      if (state.revision !== plan.baseRevision) throw new MSyncError('预览已过期，请重新扫描');
      if (new Set(plan.observations.map(snapshotKey)).size !== plan.observations.length) throw new MSyncError('扫描包含重复列表');
      for (const snapshot of plan.observations) {
        const previous = state.snapshots.find(prior => snapshotKey(prior) === snapshotKey(snapshot));
        if (previous && previous.accountID !== snapshot.accountID) throw new MSyncError(`${labels[snapshot.platform]} 账户或资料库已改变，请导出备份后重新建立基线`);
      }
      for (const snapshot of plan.observations) {
        const index = state.snapshots.findIndex(previous => snapshotKey(previous) === snapshotKey(snapshot));
        const previous = state.snapshots[index];
        let merged = structuredClone(snapshot);
        if (previous && !snapshot.isComplete) {
          const explicit = new Set([...snapshot.items.map(item => item.id), ...snapshot.savedIDs]);
          merged.items.push(...previous.items.filter(item => !explicit.has(item.id)));
          merged.savedIDs.push(...previous.savedIDs.filter(id => !explicit.has(id)));
        }
        if (index < 0) state.snapshots.push(merged); else state.snapshots[index] = merged;
      }
      state.desired = { ...plan.desired }; state.activePlanID = plan.id; state.outstanding = structuredClone(plan.operations);
      this.audit(state, `记录同步计划：${plan.operations.length} 项操作`);
    });
  }
  acknowledge(operation: Operation, planID: string, confirmation: Snapshot): void {
    if (confirmation.platform !== operation.item.platform || confirmation.kind !== operation.item.kind || observedState(confirmation, operation.item.id) !== operation.saved) throw new MSyncError('尚未回读到目标收藏状态，保留待处理');
    this.mutate(state => {
      if (state.activePlanID !== planID || !state.outstanding.some(pending => pending.id === operation.id)) throw new MSyncError('同步操作已过期');
      const baseline = state.snapshots.find(snapshot => snapshotKey(snapshot) === snapshotKey(confirmation));
      if (!baseline || baseline.accountID !== confirmation.accountID) throw new MSyncError('写入期间账户改变，停止确认');
      if (!baseline.items.some(item => item.id === operation.item.id)) baseline.items.push(operation.item);
      baseline.savedIDs = baseline.savedIDs.filter(id => id !== operation.item.id);
      if (operation.saved) baseline.savedIDs.push(operation.item.id);
      state.outstanding = state.outstanding.filter(pending => pending.id !== operation.id);
      this.audit(state, `${operation.saved ? '添加' : '取消'}收藏 · ${labels[operation.item.platform]} · ${operation.item.title}`);
    });
  }
  reset(): void {
    this.mutate(state => { state.mappings = []; state.snapshots = []; state.desired = {}; state.outstanding = []; delete state.activePlanID; this.audit(state, '重新建立本地基线，平台收藏保持原样'); });
  }
  importState(input: unknown): void {
    const imported = stateSchema.parse(input);
    imported.mappings.filter(mapping => mapping.verified).forEach(validateMapping);
    const keys = imported.mappings.flatMap(mapping => mapping.items.map(itemKey));
    if (new Set(keys).size !== keys.length) throw new MSyncError('备份中存在多重对应关系，当前记录保持原样');
    this.mutate(state => {
      state.mappings = imported.mappings; state.snapshots = imported.snapshots; state.desired = imported.desired;
      state.outstanding = []; delete state.activePlanID; this.audit(state, '导入收藏对应关系与历史；平台账户需要在此电脑单独连接');
    });
  }
  log(message: string): void { this.mutate(state => this.audit(state, message)); }
  close(): void { this.db.close(); }
}
