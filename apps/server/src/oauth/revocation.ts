/**
 * OAuth 吊销名单（S1011-007/011）：hash -> 到期时间。
 * 只登记验签通过且未过期的令牌（过期令牌本就进不来，无需占位）；
 * 落盘 data/oauth-revoked.json，重启后已吊销令牌保持吊销（访问令牌 1h 短命 +
 * 刷新令牌轮换一次性，构成完整的重启语义）；串行写、唯一临时文件（与 client-store 同规）。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissingFile, OAuthStateError, writeOAuthState } from './state-file.ts';

export class RevocationList {
  private entries = new Map<string, number>();
  private readonly file: string;
  private writeChain: Promise<void> = Promise.resolve();
  private writeFailed = false;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'oauth-revoked.json');
  }

  async load(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OAuthStateError();
      const now = Date.now();
      for (const [hash, until] of Object.entries(raw)) {
        if (!/^[a-f0-9]{64}$/.test(hash) || typeof until !== 'number' || !Number.isSafeInteger(until)) {
          throw new OAuthStateError();
        }
        if (until > now) this.entries.set(hash, until);
      }
    } catch (error) {
      // 只有首次缺文件可从空名单开始；损坏/权限错误不得让旧凭证重新有效。
      if (!isMissingFile(error)) throw new OAuthStateError();
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

  add(hash: string, untilMs: number): Promise<void> {
    if (untilMs <= Date.now()) return Promise.resolve();
    // 立即在本进程阻止并发刷新；失败时保持拒绝，不回滚成有效凭证。
    if (this.entries.get(hash) === untilMs && !this.writeFailed) return this.flush();
    this.entries.set(hash, untilMs);
    this.sweep();
    const job = this.writeChain.then(() => writeOAuthState(this.file, Object.fromEntries(this.entries)));
    this.writeChain = job.then(
      () => { this.writeFailed = false; },
      () => { this.writeFailed = true; }
    );
    return job;
  }

  async flush(): Promise<void> {
    await this.writeChain;
    if (this.writeFailed) throw new OAuthStateError();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [hash, until] of this.entries) {
      if (until <= now) this.entries.delete(hash);
    }
  }

}
