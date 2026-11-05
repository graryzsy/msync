import { z } from 'zod';

export const platforms = ['spotify', 'appleMusic', 'netease'] as const;
export const kinds = ['track', 'album', 'artist'] as const;
export const platformSchema = z.enum(platforms);
export const kindSchema = z.enum(kinds);
export type Platform = typeof platforms[number];
export type Kind = typeof kinds[number];
export const labels: Record<Platform, string> = { spotify: 'Spotify', appleMusic: 'Apple Music', netease: '网易云音乐' };
export const kindLabels: Record<Kind, string> = { track: '喜欢的歌曲', album: '收藏的专辑', artist: '收藏的艺人' };
export const releaseSchema = z.object({
  title: z.string(), artists: z.array(z.string()), date: z.object({ value: z.string() }).optional(), barcode: z.string().optional()
});
export const itemSchema = z.object({
  platform: platformSchema, kind: kindSchema, id: z.string().min(1), title: z.string().min(1), artists: z.array(z.string()),
  release: releaseSchema.optional(), isrc: z.string().optional(), discNumber: z.number().int().positive().optional(),
  trackNumber: z.number().int().positive().optional(), durationMS: z.number().nonnegative().optional(),
  url: z.string().optional(), nativeReference: z.string().optional()
});
export const snapshotSchema = z.object({
  platform: platformSchema, kind: kindSchema, accountID: z.string().min(1), capturedAt: z.string().datetime({ offset: true }),
  items: z.array(itemSchema), savedIDs: z.array(z.string()), isComplete: z.boolean(), notes: z.array(z.string()).default([])
}).superRefine((snapshot, context) => {
  const ids = new Set(snapshot.items.map(item => item.id));
  if (ids.size !== snapshot.items.length || snapshot.items.some(item => item.kind !== snapshot.kind || item.platform !== snapshot.platform)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '列表中存在重复或跨平台条目' });
  }
  if (new Set(snapshot.savedIDs).size !== snapshot.savedIDs.length || snapshot.savedIDs.some(id => !ids.has(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '收藏列表缺少完整条目信息' });
  }
});
export type MusicItem = z.infer<typeof itemSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export interface Mapping { id: string; kind: Kind; items: MusicItem[]; verified: boolean; evidence: string }
export interface Operation { id: string; mappingID: string; item: MusicItem; saved: boolean; reason: string }
export interface ReviewIssue { id: string; mappingID?: string; message: string }
export interface SyncPlan {
  id: string; baseRevision: number; createdAt: string; observations: Snapshot[];
  operations: Operation[]; issues: ReviewIssue[]; desired: Record<string, boolean>;
  notes?: string[];
}
export interface AuditEntry { id: string; time: string; message: string }
export interface StoredState {
  revision: number; mappings: Mapping[]; snapshots: Snapshot[]; desired: Record<string, boolean>;
  audit: AuditEntry[]; activePlanID?: string; outstanding: Operation[];
}
export interface PendingAction { operationID: string; platform: Platform; title: string; message: string; url?: string }
export interface ApplyReport { applied: number; pending: PendingAction[] }
export type WriteOutcome = { applied: true } | { applied: false; message: string; url?: string };
export interface MusicService {
  readonly platform: Platform;
  readonly unsupportedKinds?: Partial<Record<Kind, string>>;
  snapshot(kind: Kind): Promise<Snapshot>;
  search(item: MusicItem): Promise<MusicItem[]>;
  setSaved(saved: boolean, item: MusicItem): Promise<WriteOutcome>;
}
export const itemKey = (item: Pick<MusicItem, 'platform' | 'kind' | 'id'>): string => `${item.platform}:${item.kind}:${item.id}`;
export const snapshotKey = (snapshot: Pick<Snapshot, 'platform' | 'kind'>): string => `${snapshot.platform}:${snapshot.kind}`;
export function observedState(snapshot: Snapshot | undefined, id: string): boolean | undefined {
  if (!snapshot) return undefined;
  if (snapshot.savedIDs.includes(id)) return true;
  return snapshot.isComplete || snapshot.items.some(item => item.id === id) ? false : undefined;
}
export function emptyState(): StoredState { return { revision: 0, mappings: [], snapshots: [], desired: {}, audit: [], outstanding: [] }; }
export const mappingTitle = (mapping: Mapping): string => (mapping.items.find(item => item.platform === 'spotify') ?? mapping.items[0])?.title ?? '未命名';
export class MSyncError extends Error {}
export const errorMessage = (error: unknown): string => error instanceof MSyncError ? error.message : '操作未完成，请检查连接或重试。';
