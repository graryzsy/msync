export interface NeteaseContext {
  now(): number;
  pause(ms: number): Promise<void>;
  minIntervalMS: number;
  nextRequestAt: number;
  albums: Map<string, { value: Record<string, any>; expiresAt: number }>;
  albumDetailsBlockedUntil: number;
  albumDetailsProblem?: string;
}

export function createNeteaseContext(options: Partial<Pick<NeteaseContext, 'now' | 'pause' | 'minIntervalMS'>> = {}): NeteaseContext {
  return {
    now: options.now ?? Date.now,
    pause: options.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
    minIntervalMS: options.minIntervalMS ?? 0,
    nextRequestAt: 0, albums: new Map(), albumDetailsBlockedUntil: 0
  };
}

export async function paceNeteaseRequest(context: NeteaseContext): Promise<void> {
  const now = context.now(), next = Math.max(now, context.nextRequestAt);
  context.nextRequestAt = next + context.minIntervalMS;
  if (next > now) await context.pause(next - now);
}
