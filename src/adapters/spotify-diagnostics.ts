import type { Kind } from '../core/models.js';
import type { MetadataState, SpotifyEntitySummary, SpotifyIssueInspection, SpotifyReleaseSummary, SpotifyScanIssue } from '../shared/spotify-diagnostics.js';

function object(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
}
function identifier(input: unknown): string | undefined {
  return typeof input === 'string' && /^[A-Za-z0-9]{1,64}$/u.test(input) ? input : undefined;
}
function text(input: unknown): string | undefined { return typeof input === 'string' && input.trim() ? input.trim() : undefined; }
function nameState(input: unknown): MetadataState {
  return input === undefined ? 'missing' : input === null ? 'null' : typeof input !== 'string' ? 'invalid_type' : input.trim() ? 'present' : 'empty';
}
function releaseSummary(value: Record<string, unknown>): SpotifyReleaseSummary {
  const precision = value.release_date_precision;
  return {
    id: identifier(value.id), name: text(value.name), nameState: nameState(value.name),
    artists: Array.isArray(value.artists) ? value.artists.flatMap(artist => { const name = text(object(artist)?.name); return name ? [name] : []; }) : [],
    releaseDate: typeof value.release_date === 'string' && /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/u.test(value.release_date) ? value.release_date : undefined,
    releaseDatePrecision: precision === 'year' || precision === 'month' || precision === 'day' ? precision : undefined
  };
}
export function summarizeSpotifyEntity(input: unknown): SpotifyEntitySummary {
  const value = object(input), album = object(value?.album), external = object(value?.external_ids), restriction = object(value?.restrictions)?.reason;
  return {
    ...releaseSummary(value ?? {}), recordState: value ? 'object' : input === undefined ? 'missing' : input === null ? 'null' : 'invalid_type',
    ...(album ? { album: releaseSummary(album) } : {}),
    isLocal: typeof value?.is_local === 'boolean' ? value.is_local : undefined,
    isPlayable: typeof value?.is_playable === 'boolean' ? value.is_playable : undefined,
    restrictionReason: restriction === undefined ? undefined : restriction === 'market' || restriction === 'product' || restriction === 'explicit' ? restriction : 'other',
    linkedFromID: identifier(object(value?.linked_from)?.id),
    availableMarketCount: Array.isArray(value?.available_markets) ? value.available_markets.filter(market => typeof market === 'string' && /^[A-Z]{2}$/u.test(market)).length : undefined,
    isrc: typeof external?.isrc === 'string' && /^[A-Za-z0-9]{5,20}$/u.test(external.isrc) ? external.isrc : undefined,
    upc: typeof external?.upc === 'string' && /^\d{8,20}$/u.test(external.upc) ? external.upc : undefined,
    durationMS: typeof value?.duration_ms === 'number' && Number.isFinite(value.duration_ms) && value.duration_ms >= 0 ? value.duration_ms : undefined
  };
}
export function spotifyIssueURL(kind: Kind, id?: string): string | undefined {
  return identifier(id) ? `https://open.spotify.com/${kind}/${id}` : undefined;
}
export function diagnoseSpotifyDetail(issue: SpotifyScanIssue, detail: SpotifyEntitySummary, validationProblem?: string): SpotifyIssueInspection {
  const result = (finding: SpotifyIssueInspection['finding'], explanation: string): SpotifyIssueInspection => ({ checkedAt: new Date().toISOString(), httpStatus: 200, finding, explanation, detail });
  if (issue.source.isLocal || detail.isLocal) return result('local_file', 'Spotify 标记此项为本地文件，无法确认可跨平台对应的发行版本。');
  if (detail.id && issue.source.id && detail.id !== issue.source.id || detail.linkedFromID && detail.linkedFromID !== detail.id || issue.source.linkedFromID && issue.source.linkedFromID !== issue.source.id)
    return result('relinked', 'Spotify 返回了替代曲目或重定向标记，不能将它视为原收藏的同一发行版本。');
  const sourceRelease = issue.kind === 'track' ? issue.source.album : issue.kind === 'album' ? issue.source : undefined;
  const detailRelease = issue.kind === 'track' ? detail.album : issue.kind === 'album' ? detail : undefined;
  if (sourceRelease && detailRelease && (sourceRelease.id && detailRelease.id && sourceRelease.id !== detailRelease.id
    || sourceRelease.releaseDate && detailRelease.releaseDate && sourceRelease.releaseDate !== detailRelease.releaseDate))
    return result('release_changed', '收藏列表与单项详情的所属发行 ID 或发行日期不同，需要核实具体版本。');
  if (detail.restrictionReason === 'market') return result('region_restricted', '单项详情明确返回地区限制（market）；这不代表全球下架。');
  if (detail.restrictionReason === 'product' || detail.restrictionReason === 'explicit') return result('account_restricted', '单项详情明确返回账户产品或显式内容限制；具体标记见返回字段。');
  if (detail.nameState !== 'present') return result('empty_metadata', '单项详情也未提供可用名称，无法恢复曲名或确认发行版本；接口没有说明具体缺失原因。');
  if (!detail.id || validationProblem) return result('metadata_incomplete', `单项详情仍缺少可用元数据。${validationProblem ?? '未提供有效条目 ID。'}`);
  return result('library_response_incomplete', '单项详情可读，但本次收藏列表中的记录不完整。诊断结果保留供核实，收藏状态保持未知。');
}
