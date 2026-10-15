import { getCounter, putCounter } from "../storage/kv";

export interface QuotaDecision {
  allowed: boolean;
  remaining: number;
}

export class EdgeRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit = 100, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  async checkQuota(key: string): Promise<QuotaDecision> {
    const bucket = Math.floor(Date.now() / this.windowMs);
    const count = (await getCounter(`${key}:${bucket}`)) ?? 0;
    if (count >= this.limit) {
      return { allowed: false, remaining: 0 };
    }
    await putCounter(`${key}:${bucket}`, count + 1);
    return { allowed: true, remaining: this.limit - count - 1 };
  }

  async flushWindow(key: string): Promise<void> {
    const bucket = Math.floor(Date.now() / this.windowMs);
    await putCounter(`${key}:${bucket}`, 0);
  }
}
