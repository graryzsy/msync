import { randomUUID } from 'node:crypto';
import { platforms, kinds, type Kind, type MusicItem, type MusicService, type Platform, type Snapshot, type WriteOutcome } from './models.js';
import { normalize } from './matcher.js';
import { StateStore } from './store.js';
import { planSync } from './planner.js';

export class DemoService implements MusicService {
  private snapshots = new Map<Kind, Snapshot>();
  constructor(readonly platform: Platform) {
    const releases = ['Northbound', 'A Quiet Place', 'After the Rain', 'Slow Motion'];
    const titles = ['Late Summer', 'Home Again', 'Soft Landing', 'Little Things', 'Open Water', 'Moonlight'];
    for (const kind of kinds) {
      const items: MusicItem[] = (kind === 'track' ? titles : kind === 'album' ? releases : ['Paper Planes', 'June Atlas', 'The Coast']).map((title, index) => {
        const artist = ['Paper Planes', 'June Atlas', 'The Coast'][index % 3]!;
        const release = { title: kind === 'album' ? title : releases[index % releases.length]!, artists: [artist], date: { value: `2024-0${index % 4 + 1}-12` } };
        return { platform, kind, id: `demo-${platform}-${kind}-${index}`, title, artists: kind === 'artist' ? [title] : [artist], ...(kind === 'artist' ? {} : { release }), ...(kind === 'track' ? { isrc: `DEMO${index}`, trackNumber: index + 1, discNumber: 1, durationMS: 180000 + index * 4000 } : {}) };
      });
      this.snapshots.set(kind, { platform, kind, accountID: `demo-${platform}`, capturedAt: new Date().toISOString(), items, savedIDs: items.map(item => item.id), isComplete: true, notes: ['离线示例数据，不会连接或修改真实账户'] });
    }
  }
  async snapshot(kind: Kind): Promise<Snapshot> { return structuredClone(this.snapshots.get(kind)!); }
  async search(item: MusicItem): Promise<MusicItem[]> {
    const matches = this.snapshots.get(item.kind)!.items.filter(candidate => normalize(candidate.title) === normalize(item.title));
    if (item.kind === 'track' && matches[0]) {
      const compilation = structuredClone(matches[0]); compilation.id += '-compilation'; compilation.release!.title = 'Greatest Hits'; matches.push(compilation);
    }
    return structuredClone(matches);
  }
  async setSaved(saved: boolean, item: MusicItem): Promise<WriteOutcome> {
    const snapshot = this.snapshots.get(item.kind)!;
    snapshot.savedIDs = snapshot.savedIDs.filter(id => id !== item.id); if (saved) snapshot.savedIDs.push(item.id);
    snapshot.capturedAt = new Date().toISOString(); return { applied: true };
  }
  async simulate(saved: boolean, kind: Kind): Promise<void> { const item = this.snapshots.get(kind)!.items[0]!; await this.setSaved(saved, item); }
}
export async function createDemo(): Promise<{ store: StateStore; services: DemoService[] }> {
  const store = await StateStore.open(), services = platforms.map(platform => new DemoService(platform));
  const snapshots: Snapshot[] = [];
  for (const service of services) for (const kind of kinds) snapshots.push(await service.snapshot(kind));
  for (const kind of kinds) {
    const anchor = snapshots.find(snapshot => snapshot.platform === 'spotify' && snapshot.kind === kind)!;
    for (const [index] of anchor.items.entries()) {
      store.addMapping({ id: randomUUID(), kind, verified: true, evidence: '离线示例：已核实相同艺人、发行版本和完整日期', items: platforms.map(platform => snapshots.find(snapshot => snapshot.platform === platform && snapshot.kind === kind)!.items[index]!) });
    }
  }
  store.begin(planSync(store.load(), snapshots));
  return { store, services };
}
