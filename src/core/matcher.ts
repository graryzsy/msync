import type { MusicItem } from './models.js';

export type Assessment = { decision: 'compatible' | 'different' | 'needsReview'; evidence: string[] };
export const normalize = (value: string): string => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
export function exactDate(value: string | undefined): boolean {
  if (!value || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const sameArtists = (a: string[], b: string[]): boolean => {
  const x = [...new Set(a.map(normalize).filter(Boolean))].sort();
  const y = [...new Set(b.map(normalize).filter(Boolean))].sort();
  return x.length > 0 && JSON.stringify(x) === JSON.stringify(y);
};
export function assess(a: MusicItem, b: MusicItem): Assessment {
  const result = (decision: Assessment['decision'], message: string): Assessment => ({ decision, evidence: [message] });
  if (a.kind !== b.kind) return result('different', '收藏类型不同');
  if (a.kind === 'artist') return result('needsReview', '同名不能证明是同一艺人，请核对官方页面');
  const x = a.release, y = b.release;
  if (!x || !y || !normalize(x.title) || !normalize(y.title)) return result('needsReview', '缺少所属发行版本');
  if (normalize(x.title) !== normalize(y.title)) return result('different', '所属发行版本不同；不以精选集、单曲或豪华版替代原专辑');
  if (exactDate(x.date?.value) && exactDate(y.date?.value) && x.date!.value !== y.date!.value) return result('different', '完整发行日期不同');
  if (a.isrc && b.isrc && a.isrc.toUpperCase() !== b.isrc.toUpperCase()) return result('different', 'ISRC 不同');
  if (a.discNumber && b.discNumber && a.discNumber !== b.discNumber) return result('different', '碟号不同');
  if (a.trackNumber && b.trackNumber && a.trackNumber !== b.trackNumber) return result('different', '曲序不同');
  if (!exactDate(x.date?.value) || !exactDate(y.date?.value)) return result('needsReview', '需要核实完整发行年月日，不补全缺失日期');
  if (normalize(a.title) !== normalize(b.title)) return result('needsReview', '曲目名称不同，需要核实翻译或别名');
  if (!sameArtists(a.artists, b.artists) || !sameArtists(x.artists, y.artists)) return result('needsReview', '艺人信息存在差异，需要人工核实');
  if (x.barcode && y.barcode && x.barcode !== y.barcode) return result('needsReview', '发行条码不同，需要核实地区和版本');
  if (a.durationMS && b.durationMS && Math.abs(a.durationMS - b.durationMS) > 2000) return result('needsReview', '时长相差超过两秒');
  return result('compatible', '曲目、艺人、所属发行版本和完整日期一致，等待确认对应关系');
}
