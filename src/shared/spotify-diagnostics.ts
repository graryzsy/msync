import type { Kind } from '../core/models.js';

export type MetadataState = 'missing' | 'null' | 'empty' | 'present' | 'invalid_type';
export interface SpotifyReleaseSummary {
  id?: string; name?: string; nameState: MetadataState; artists: string[];
  releaseDate?: string; releaseDatePrecision?: 'year' | 'month' | 'day';
}
/** Selected catalog fields only; never an API response, account profile or credentials. */
export interface SpotifyEntitySummary extends SpotifyReleaseSummary {
  recordState: 'missing' | 'null' | 'object' | 'invalid_type';
  album?: SpotifyReleaseSummary;
  isLocal?: boolean; isPlayable?: boolean;
  restrictionReason?: 'market' | 'product' | 'explicit' | 'other';
  linkedFromID?: string; availableMarketCount?: number;
  isrc?: string; upc?: string; durationMS?: number;
}
export interface SpotifyIssueInspection {
  checkedAt: string;
  finding: 'local_file' | 'relinked' | 'release_changed' | 'region_restricted' | 'account_restricted'
    | 'empty_metadata' | 'library_response_incomplete' | 'metadata_incomplete' | 'request_failed' | 'not_checked';
  explanation: string; httpStatus?: number; detail?: SpotifyEntitySummary;
}
export interface SpotifyScanIssue {
  kind: Kind; position: number; problem: string; field?: string; url?: string;
  source: SpotifyEntitySummary; inspection?: SpotifyIssueInspection;
}
export interface SpotifyDiagnosticReport {
  format: 'msync-spotify-diagnostics'; version: 1; createdAt: string; scannedAt: string;
  collections: { kind: Kind; readableCount: number; issueCount: number; isComplete: boolean }[];
  issues: SpotifyScanIssue[];
}
