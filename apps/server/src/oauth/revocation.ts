/**
 * OAuth 吊销名单（S1011-007/011）：hash -> 到期时间。
 * 只登记验签通过且未过期的令牌（过期令牌本就进不来，无需占位）；
 * 落盘 data/oauth-revoked.json，重启后已吊销令牌保持吊销（访问令牌 1h 短命 +
 * 刷新令牌轮换一次性，构成完整的重启语义）；串行写、唯一临时文件（与 client-store 同规）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export class RevocationList {
  private entries = new Map<string, number>();
  private readonly file: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = join(dataDir, 'oauth-revoked.json');
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, number>;
      const now = Date.now();
      for (const [hash, until] of Object.entries(raw)) {
        if (typeof until === 'number' && until > now) this.entries.set(hash, until);
      }
    } catch {
      // 无文件/损坏：从空名单开始（等价于"全部未吊销"，令牌自身签名与过期仍有效）
    }
  }

  has(hash: string): boolean {
    const until = this.entries.get(hash);
    if (until === undefined) return false;
    if (until <= Date.now()) {
      this.entries.delete(hash);
      return false;
    }
    return true;
  }

  add(hash: string, untilMs: number): void {
    if (untilMs <= Date.now()) return;
    this.entries.set(hash, untilMs);
    this.sweep();
    const job = this.writeChain.then(() => this.writeNow());
    this.writeChain = job.catch(() => undefined);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [hash, until] of this.entries) {
      if (until <= now) this.entries.delete(hash);
    }
  }

  private async writeNow(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this.entries)), 'utf8');
    await rename(tmp, this.file);
  }
}
