import type { ApplyReport, Kind, Mapping, MusicItem, Platform, Snapshot, StoredState, SyncPlan } from '../core/models.js';
import type { SpotifyScanIssue } from './spotify-diagnostics.js';

export interface Settings { spotifyClientID: string; appleMode: 'native' | 'web' | 'disabled'; appleWebAccountID: string }
export interface Connection { platform: Platform; connected: boolean; mode: string; detail: string }
export interface AppView {
  settings: Settings; state: StoredState; snapshots: Snapshot[]; plan: SyncPlan | null; connections: Connection[];
  demo: boolean; os: string; credentialStorage: 'secure' | 'session'; message: string;
  manualApple: { item: MusicItem; saved: boolean; checkedAt: string }[];
  spotifyScanIssues: SpotifyScanIssue[];
}
export interface SearchResult { item: MusicItem; decision: 'compatible' | 'different' | 'needsReview'; evidence: string[] }
export interface DesktopAPI {
  getState(): Promise<AppView>;
  saveSettings(settings: Pick<Settings, 'spotifyClientID' | 'appleMode'>): Promise<AppView>;
  connectSpotify(): Promise<AppView>;
  cancelLogin(): Promise<void>;
  disconnect(platform: Platform): Promise<AppView>;
  startNeteaseLogin(): Promise<{ key: string; image: string }>;
  checkNeteaseLogin(key: string): Promise<{ code: number; view: AppView }>;
  scan(): Promise<AppView>;
  inspectSpotifyIssues(): Promise<AppView>;
  exportSpotifyDiagnostics(): Promise<boolean>;
  apply(planID: string): Promise<{ report: ApplyReport; view: AppView }>;
  search(item: MusicItem, platform: Platform): Promise<SearchResult[]>;
  addMapping(mapping: Mapping): Promise<AppView>;
  removeMapping(id: string): Promise<AppView>;
  recordApple(item: MusicItem, saved: boolean): Promise<AppView>;
  exportBackup(): Promise<boolean>;
  importBackup(): Promise<AppView>;
  resetHistory(): Promise<AppView>;
  openExternal(url: string): Promise<void>;
  demoMode(enabled: boolean): Promise<AppView>;
  simulateDemoChange(platform: Platform, saved: boolean, kind: Kind): Promise<AppView>;
}
declare global { interface Window { msync?: DesktopAPI } }
