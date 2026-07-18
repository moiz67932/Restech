export interface RateLimitInput {
  key: string;
  limit: number;
  windowSeconds: number;
}
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}
export interface RateLimiter {
  consume(input: RateLimitInput): Promise<RateLimitResult>;
}
export class MemoryRateLimiter implements RateLimiter {
  private values = new Map<string, { count: number; reset: number }>();
  async consume(input: RateLimitInput) {
    const now = Date.now();
    let value = this.values.get(input.key);
    if (!value || value.reset <= now) value = { count: 0, reset: now + input.windowSeconds * 1000 };
    value.count++;
    this.values.set(input.key, value);
    return {
      allowed: value.count <= input.limit,
      remaining: Math.max(0, input.limit - value.count),
      retryAfterSeconds: Math.max(1, Math.ceil((value.reset - now) / 1000)),
    };
  }
}
export class SharedRateLimiterRequired implements RateLimiter {
  async consume(input: RateLimitInput): Promise<RateLimitResult> {
    void input;
    throw new Error('A shared production rate-limiter adapter is required.');
  }
}

export class HttpSharedRateLimiter implements RateLimiter {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async consume(input: RateLimitInput): Promise<RateLimitResult> {
    const response = await this.fetcher(this.url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error('Shared rate limiter unavailable');
    const value = (await response.json()) as Partial<RateLimitResult>;
    if (
      typeof value.allowed !== 'boolean' ||
      !Number.isInteger(value.remaining) ||
      !Number.isInteger(value.retryAfterSeconds)
    )
      throw new Error('Shared rate limiter returned an invalid response');
    return value as RateLimitResult;
  }
}
