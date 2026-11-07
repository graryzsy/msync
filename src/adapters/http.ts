import { MSyncError } from '../core/models.js';

export type Fetcher = typeof fetch;
export class HTTPError extends MSyncError {
  constructor(readonly status: number, message: string) { super(message); }
}
export async function http(url: URL | string, init: RequestInit = {}, fetcher: Fetcher = fetch): Promise<Response> {
  let response: Response;
  try { response = await fetcher(url, { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(45_000) }); }
  catch { throw new MSyncError('网络连接未完成，请检查网络后重试；当前列表不会当作空收藏'); }
  if (response.status === 401) throw new HTTPError(401, '登录已过期，请重新连接账户');
  if (response.status === 429) throw new HTTPError(429, '平台请求限流，请稍后重新扫描');
  if (!response.ok) throw new HTTPError(response.status, `平台请求失败（HTTP ${response.status}）`);
  return response;
}
