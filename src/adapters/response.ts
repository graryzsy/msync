import { z } from 'zod';
import { MSyncError } from '../core/models.js';

export class APIDataError extends MSyncError {
  constructor(message: string, readonly field?: string) { super(message); }
}

/** Report schema fields and types, never response values or complete payloads. */
export function parseResponse<S extends z.ZodTypeAny>(schema: S, input: unknown, context: string): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.path.map(part => typeof part === 'number' ? `[${part}]` : part).join('.') || '响应根节点';
  const detail = issue?.code === 'invalid_type' ? `预期 ${issue.expected}，收到 ${issue.received}`
    : issue?.code === 'too_small' && issue.type === 'string' && issue.minimum === 1 ? '文本为空，接口未提供可用名称或标识'
    : '字段校验未通过';
  throw new APIDataError(`${context} 数据格式不符（字段 ${path}；${detail}）`, path);
}

export async function readJSON(response: Response, context: string): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new APIDataError(`${context} 未返回有效 JSON 数据，请检查网络或代理的响应`); }
}
