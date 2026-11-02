import { randomUUID } from 'node:crypto';
import { itemKey, labels, observedState, snapshotKey, type StoredState, type Snapshot, type SyncPlan, type ReviewIssue, type Operation, type Platform, type MusicItem } from './models.js';
import { assess } from './matcher.js';

export function planSync(state: StoredState, current: Snapshot[]): SyncPlan {
  const operations: Operation[] = [], issues: ReviewIssue[] = [], desired = { ...state.desired };
  const counts = new Map<string, number>();
  for (const mapping of state.mappings) for (const item of mapping.items) counts.set(itemKey(item), (counts.get(itemKey(item)) ?? 0) + 1);
  for (const mapping of state.mappings) {
    if (!mapping.verified || mapping.items.length < 2) continue;
    const issue = (message: string): void => { issues.push({ id: randomUUID(), mappingID: mapping.id, message }); };
    if (new Set(mapping.items.map(item => item.platform)).size !== mapping.items.length || mapping.items.some(item => item.kind !== mapping.kind || counts.get(itemKey(item)) !== 1)) {
      issue('条目存在重复或多重对应关系'); continue;
    }
    const observations: { item: MusicItem; saved: boolean }[] = [], changes: { platform: Platform; saved: boolean }[] = [];
    let blocked = false;
    for (const item of mapping.items) {
      const now = current.find(snapshot => snapshotKey(snapshot) === snapshotKey(item));
      if (!now) continue;
      const previous = state.snapshots.find(snapshot => snapshotKey(snapshot) === snapshotKey(item));
      if (previous && previous.accountID !== now.accountID) { blocked = true; issue(`${labels[item.platform]} 账户或资料库已改变，需重新建立基线`); continue; }
      const currentItem = now.items.find(candidate => candidate.id === item.id);
      if (currentItem && assess(item, currentItem).decision === 'different') { blocked = true; issue(`${labels[item.platform]} 发行元数据与已确认版本不同，请重新核查对应关系`); continue; }
      const saved = observedState(now, item.id);
      if (saved === undefined) { issue(`${labels[item.platform]} 未读到可靠状态，保留历史记录`); continue; }
      observations.push({ item, saved });
      const before = observedState(previous, item.id);
      if (before !== undefined && before !== saved) changes.push({ platform: item.platform, saved });
    }
    if (blocked) continue;
    let target: boolean | undefined;
    if (changes.length) {
      if (new Set(changes.map(change => change.saved)).size === 1) target = changes[0]!.saved;
      else {
        const spotify = changes.find(change => change.platform === 'spotify');
        if (spotify) { target = spotify.saved; issue('检测到相反操作，采用 Spotify 的主动变更'); }
        else { issue('Apple Music 和网易云存在相反变更，请人工处理'); continue; }
      }
    } else if (Object.hasOwn(state.desired, mapping.id)) target = state.desired[mapping.id];
    else target = observations.find(observation => observation.item.platform === 'spotify')?.saved;
    if (target === undefined) { issue('首次基线需要 Spotify 的可靠状态；其他平台独有收藏保留'); continue; }
    desired[mapping.id] = target;
    for (const observation of observations) if (observation.saved !== target) {
      operations.push({ id: randomUUID(), mappingID: mapping.id, item: observation.item, saved: target, reason: changes.length ? '传播平台主动变更' : '按已记录目标对齐' });
    }
  }
  return { id: randomUUID(), baseRevision: state.revision, createdAt: new Date().toISOString(), observations: current, operations, issues, desired };
}
