import { randomUUID } from 'node:crypto';
import { emptyState, platforms, type Kind, type Mapping, type MusicItem, type MusicService, type Platform, type Snapshot, type WriteOutcome } from '../src/core/models.js';

export function item(platform: Platform, kind: Kind = 'track', id: string = platform, album = 'Original Album', date = '2024-02-29'): MusicItem {
  return { platform, kind, id, title: kind === 'album' ? album : kind === 'artist' ? 'Artist' : 'Song', artists: ['Artist'],
    ...(kind === 'artist' ? {} : { release: { title: album, artists: ['Artist'], date: { value: date } } }),
    ...(kind === 'track' ? { isrc: 'USABC0000001', discNumber: 1, trackNumber: 2, durationMS: 180000 } : {}) };
}
export function snap(value: MusicItem, saved: boolean | undefined, complete = true, accountID = 'account'): Snapshot {
  return { platform: value.platform, kind: value.kind, accountID, capturedAt: '2026-11-02T00:00:00Z', items: saved === undefined ? [] : [structuredClone(value)], savedIDs: saved ? [value.id] : [], isComplete: saved === undefined ? false : complete, notes: [] };
}
export const items = (): MusicItem[] => platforms.map(platform => item(platform));
export function mapping(values = items()): Mapping { return { id: randomUUID(), kind: values[0]!.kind, items: values, verified: true, evidence: 'Verified complete release date and edition' }; }
export function stateFor(value: Mapping, snapshots: Snapshot[] = []) { return { ...emptyState(), mappings: [value], snapshots }; }
export class MemoryService implements MusicService {
  writes = 0; fail = false; private snapshots = new Map<Kind, Snapshot>();
  constructor(readonly platform: Platform, value: MusicItem, saved: boolean) { this.snapshots.set(value.kind, snap(value, saved)); }
  async snapshot(kind: Kind): Promise<Snapshot> { return structuredClone(this.snapshots.get(kind) ?? { platform: this.platform, kind, accountID: 'account', capturedAt: new Date().toISOString(), items: [], savedIDs: [], isComplete: true, notes: [] }); }
  async search(value: MusicItem): Promise<MusicItem[]> { return (await this.snapshot(value.kind)).items; }
  async setSaved(saved: boolean, value: MusicItem): Promise<WriteOutcome> {
    this.writes++; if (this.fail) throw new Error('simulated failure'); this.snapshots.set(value.kind, snap(value, saved)); return { applied: true };
  }
  change(value: MusicItem, saved: boolean): void { this.snapshots.set(value.kind, snap(value, saved)); }
}
