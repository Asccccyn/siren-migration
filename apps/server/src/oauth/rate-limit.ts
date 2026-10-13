/** 单进程固定窗口：全局上限同时约束 IP 表尺寸，避免匿名请求无限累积。 */
export class OAuthRateLimit {
  private start = 0;
  private total = 0;
  private readonly ips = new Map<string, number>();

  constructor(private readonly perIp: number, private readonly global: number, private readonly windowMs = 60_000) {}

  allow(ip: string, now = Date.now()): boolean {
    if (now >= this.start + this.windowMs) {
      this.start = now;
      this.total = 0;
      this.ips.clear();
    }
    const count = this.ips.get(ip) ?? 0;
    if (count >= this.perIp || this.total >= this.global) return false;
    this.ips.set(ip, count + 1);
    this.total += 1;
    return true;
  }

  retryAfter(now = Date.now()): number {
    return Math.max(1, Math.ceil((this.start + this.windowMs - now) / 1000));
  }
}
