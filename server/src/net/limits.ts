/**
 * 公网滥用防护的限流原语（纯逻辑，便于单测）：
 * - SlidingWindow：滑动窗口计数（连接频率 / 加入尝试频率）
 * - TokenBucket：令牌桶（每连接消息速率，持续速率 + 突发容量）
 * - IpTable：按 IP 的限流表（带闲置自动清理，防 Map 无限膨胀）
 */

export class SlidingWindow {
  private hits: number[] = [];
  private lastHit = 0;

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  allow(now = Date.now()): boolean {
    this.lastHit = now;
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }

  /** 距最近一次记录是否超过 idleMs（用于清理闲置条目） */
  idle(now = Date.now()): boolean {
    return now - this.lastHit > this.windowMs * 4;
  }
}

export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private dropped = 0;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
    this.last = now;
    if (this.tokens < 1) {
      this.dropped += 1;
      return false;
    }
    this.tokens -= 1;
    return true;
  }

  /** 连续丢弃过多 → 连接可能为恶意洪泛 */
  flooded(threshold = 30): boolean {
    return this.dropped >= threshold;
  }
}

/** 按 IP 的限流表：命中即建条目，闲置自动清理 */
export class IpTable<T> {
  private table = new Map<string, T>();

  constructor(
    private readonly make: () => T,
    private readonly isIdle: (entry: T, now: number) => boolean,
  ) {}

  get(ip: string): T {
    let entry = this.table.get(ip);
    if (!entry) {
      entry = this.make();
      this.table.set(ip, entry);
    }
    return entry;
  }

  prune(now = Date.now()): void {
    for (const [ip, entry] of this.table) {
      if (this.isIdle(entry, now)) this.table.delete(ip);
    }
  }

  get size(): number {
    return this.table.size;
  }
}
