import { MSyncError } from '../core/models.js';

type ObjectValue = Record<string, any>;
export type API = Record<string, (params: ObjectValue) => Promise<{ body: ObjectValue }>>;
export type Kind = "track" | "album" | "artist";
export interface Request { action: string; cookie?: string; kind?: Kind; id?: string; saved?: boolean; query?: string; key?: string }

export function releaseDay(timestamp: unknown): string | undefined {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return undefined;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find(p => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function artists(object: ObjectValue): string[] {
  const values = object.artists ?? (object.artist ? [object.artist] : []);
  return values.map((a: ObjectValue) => a.name).filter((name: unknown) => typeof name === "string" && name.length > 0);
}

export function albumItem(album: ObjectValue): ObjectValue {
  if (!album.id || typeof album.name !== "string") throw new MSyncError("网易云专辑元数据缺失");
  const date = releaseDay(album.publishTime);
  return {
    platform: "netease", kind: "album", id: String(album.id), title: album.name, artists: artists(album),
    release: { title: album.name, artists: artists(album), ...(date ? { date: { value: date } } : {}) },
    url: `https://music.163.com/#/album?id=${album.id}`
  };
}

export function trackItem(song: ObjectValue, album: ObjectValue): ObjectValue {
  if (!song.id || typeof song.name !== "string") throw new MSyncError("网易云歌曲元数据缺失");
  return {
    platform: "netease", kind: "track", id: String(song.id), title: song.name,
    artists: (song.ar ?? song.artists ?? []).map((a: ObjectValue) => a.name),
    release: albumItem(album).release,
    durationMS: song.dt ?? song.duration,
    trackNumber: song.no > 0 ? song.no : undefined,
    discNumber: /^\d+$/.test(String(song.cd)) && Number(song.cd) > 0 ? Number(song.cd) : undefined,
    url: `https://music.163.com/#/song?id=${song.id}`
  };
}

function artistItem(artist: ObjectValue): ObjectValue {
  if (!artist.id || typeof artist.name !== "string") throw new MSyncError("网易云艺人元数据缺失");
  return { platform: "netease", kind: "artist", id: String(artist.id), title: artist.name, artists: [artist.name], url: `https://music.163.com/#/artist?id=${artist.id}` };
}

function requestFailure(name: string, code: unknown, login: boolean): MSyncError {
  const detail = typeof code === 'number' && Number.isSafeInteger(code) ? `（代码 ${code}）` : '';
  if (login) return new MSyncError(`网易云未接受本次登录请求${detail}（接口 ${name}）。若手机提示“设备环境异常”，请暂停扫码，先检查官方 App 和日常网络，并按页面提示稍后再试；反复生成二维码不能解除限制。`);
  if (code === 301) return new MSyncError(`网易云登录已过期（接口 ${name}），请重新连接账户`);
  return new MSyncError(`网易云接口 ${name} 请求失败${detail || '（响应缺少成功状态码）'}，请检查账户和网络后重试`);
}

export async function execute(request: Request, api: API): Promise<unknown> {
  const login = request.action === 'qrStart' || request.action === 'qrCheck';
  const call = async (name: string, params: ObjectValue = {}, qr = false): Promise<ObjectValue> => {
    const method = api[name];
    if (!method) throw new MSyncError(`网易云接口模块 ${name} 缺失，请检查辅助模块版本`);
    let response;
    try { response = await method({ ...params, cookie: request.cookie ?? "", timestamp: Date.now() }); }
    catch (error) {
      const body = error && typeof error === 'object' && 'body' in error ? error.body : undefined;
      if (body && typeof body === 'object' && 'code' in body) throw requestFailure(name, body.code, login);
      throw new MSyncError(`网易云接口 ${name} 连接失败，请检查网络连接后重试`);
    }
    // The component wraps successful login_status replies as { body: { data:
    // { code: 200, profile, account } } }, unlike its collection endpoints.
    const body = name === 'login_status' && response?.body?.data ? response.body.data : response?.body;
    if (!body || (!qr && body.code !== 200)) throw requestFailure(name, body?.code, login);
    return body;
  };
  if (request.action === "qrStart") {
    const keyResult = await call("login_qr_key", { ua: 'pc' });
    if (keyResult.data?.code !== undefined && keyResult.data.code !== 200) throw requestFailure('login_qr_key', keyResult.data.code, true);
    const key = keyResult.data?.unikey;
    if (typeof key !== "string" || !key) throw new MSyncError("网易云未返回有效登录二维码，请稍后再试");
    // Follow the bundled component's web login example: it adds the chainId
    // carried by web QR codes. The default 'pc' format omits that parameter.
    const result = await call("login_qr_create", { key, platform: 'web', qrimg: true, ua: 'pc' });
    if (typeof result.data?.qrimg !== "string") throw new MSyncError("二维码生成失败");
    return { key, image: result.data.qrimg };
  }
  if (request.action === "qrCheck") {
    const result = await call("login_qr_check", { key: request.key, ua: 'pc' }, true);
    if (![800, 801, 802, 803].includes(result.code)) throw requestFailure('login_qr_check', result.code, true);
    return { code: result.code, ...(result.code === 803 ? { cookie: result.cookie } : {}) };
  }
  const kind = request.kind;
  if (!kind || !["track", "album", "artist"].includes(kind)) throw new MSyncError("收藏类型无效");
  if (!request.cookie) throw new MSyncError("请先连接网易云账户");
  const userID = async (): Promise<string> => {
    const result = await call("login_status");
    const id = result.profile?.userId ?? result.account?.id;
    if (!id) throw new MSyncError("网易云 login_status 未返回已登录账户，请重新连接账户");
    return String(id);
  };
  const accountID = await userID();
  const albumCache = new Map<string, ObjectValue>();
  const album = async (id: string): Promise<ObjectValue> => {
    if (!albumCache.has(id)) {
      const result = await call("album", { id });
      if (!result.album || String(result.album.id) !== id) throw new MSyncError("网易云发行版本读取失败");
      albumCache.set(id, result.album);
    }
    return albumCache.get(id)!;
  };
  const tracks = async (ids: string[]): Promise<ObjectValue[]> => {
    const items: ObjectValue[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      const result = await call("song_detail", { ids: batch.join(",") });
      if (!Array.isArray(result.songs) || result.songs.length !== batch.length) throw new MSyncError("部分网易云收藏无法读取，保留历史状态");
      const byID = new Map<string, ObjectValue>(result.songs.map((song: ObjectValue) => [String(song.id), song]));
      for (const id of batch) {
        const song = byID.get(id);
        if (!song || !(song.al?.id ?? song.album?.id)) throw new MSyncError("网易云歌曲缺少所属发行版本");
        const release = await album(String(song.al?.id ?? song.album.id));
        items.push(trackItem(song, release));
      }
    }
    return items;
  };
  if (request.action === "write") {
    if (!request.id || !/^\d+$/.test(request.id) || typeof request.saved !== "boolean") throw new MSyncError("收藏操作无效");
    if (kind === "track") await call("like", { id: request.id, like: request.saved });
    else await call(kind === "album" ? "album_sub" : "artist_sub", { id: request.id, t: request.saved ? 1 : 0 });
    return { applied: true };
  }
  if (request.action === "search") {
    if (!request.query?.trim()) return [];
    const result = await call("cloudsearch", { keywords: request.query, type: kind === "track" ? 1 : kind === "album" ? 10 : 100, limit: 10 });
    const values = result.result?.[kind === "track" ? "songs" : kind === "album" ? "albums" : "artists"];
    const count = result.result?.[kind === "track" ? "songCount" : kind === "album" ? "albumCount" : "artistCount"];
    if (!Array.isArray(values)) {
      if (count === 0) return [];
      throw new MSyncError("网易云搜索响应不完整");
    }
    if (kind === "track") return tracks(values.map((song: ObjectValue) => String(song.id)));
    if (kind === "artist") return values.map(artistItem);
    const items = [];
    for (const value of values) items.push(albumItem(await album(String(value.id))));
    return items;
  }
  if (request.action !== "snapshot") throw new MSyncError("未知操作");
  let items: ObjectValue[] = [];
  if (kind === "track") {
    const result = await call("likelist", { uid: accountID });
    if (!Array.isArray(result.ids)) throw new MSyncError("网易云喜欢列表未完整返回");
    items = await tracks(result.ids.map(String));
  } else {
    for (let offset = 0; ; offset += 100) {
      if (offset >= 100_000) throw new MSyncError("网易云分页超出限制");
      const result = await call(kind === "album" ? "album_sublist" : "artist_sublist", { offset, limit: 100 });
      if (!Array.isArray(result.data)) throw new MSyncError("网易云收藏分页无效");
      for (const row of result.data) items.push(kind === "album" ? albumItem(await album(String(row.id))) : artistItem(row));
      if (result.data.length < 100 || result.hasMore === false || result.more === false) {
        if (typeof result.count === "number" && result.count !== items.length) throw new MSyncError("网易云收藏数量变化，请重新扫描");
        break;
      }
    }
  }
  if (new Set(items.map(item => item.id)).size !== items.length) throw new MSyncError("网易云收藏分页重复，请重新扫描");
  if (await userID() !== accountID) throw new MSyncError("扫描期间网易云账户发生变化");
  return { platform: "netease", kind, accountID, capturedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), items, savedIDs: items.map(item => item.id), isComplete: true, notes: [] };
}
