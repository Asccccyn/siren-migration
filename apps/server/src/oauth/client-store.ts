/**
 * OAuth 客户端注册表（RFC 7591 动态注册的结果落盘）。
 * JSON 文件存 data/oauth-clients.json，原子写（tmp+rename）；注册必须跨重启存活，
 * 否则客户端 refresh_token 会因 client 丢失而失效，用户就得重新走一遍授权。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** 注册表总量上限（S1011-007：公开 DCR 的容量边界；超限拒绝新注册） */
const MAX_CLIENTS = 200;

export interface OAuthClient {
  clientId: string;
  clientSecret: string | null;
  tokenEndpointAuthMethod: 'none' | 'client_secret_post';
  redirectUris: string[];
  clientName: string;
  createdAt: string;
}

interface StoreFile {
  clients: Record<string, OAuthClient>;
}

export class OAuthClientStore {
  private readonly file: string;
  private clients: Record<string, OAuthClient> = {};
  /** S1011-006：persist 串行化——单写者链，杜绝并发 tmp/rename 互踩 */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = join(dataDir, 'oauth-clients.json');
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as StoreFile;
      this.clients = raw.clients ?? {};
    } catch {
      this.clients = {};
    }
    // S1011-007：容量边界——超出上限裁掉最旧的注册（按 createdAt）
    const entries = Object.values(this.clients).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (entries.length > MAX_CLIENTS) {
      for (const victim of entries.slice(0, entries.length - MAX_CLIENTS)) delete this.clients[victim.clientId];
      await this.persist();
    }
  }

  private persist(): Promise<void> {
    // S1011-006：串行提交 + 唯一临时文件；失败不吞（调用方上抛），链不断
    const job = this.writeChain.then(() => this.writeNow());
    this.writeChain = job.catch(() => undefined);
    return job;
  }

  private async writeNow(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify({ clients: this.clients }, null, 2), 'utf8');
    await rename(tmp, this.file);
  }

  get size(): number {
    return Object.keys(this.clients).length;
  }

  async register(input: {
    clientName: string;
    redirectUris: string[];
    tokenEndpointAuthMethod: 'none' | 'client_secret_post';
  }): Promise<OAuthClient> {
    if (Object.keys(this.clients).length >= MAX_CLIENTS) {
      throw new Error('registration_capacity_reached');
    }
    const clientId = `siren-${randomBytes(12).toString('base64url')}`;
    const client: OAuthClient = {
      clientId,
      clientSecret:
        input.tokenEndpointAuthMethod === 'client_secret_post'
          ? randomBytes(24).toString('base64url')
          : null,
      tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
      redirectUris: input.redirectUris,
      clientName: input.clientName,
      createdAt: new Date().toISOString()
    };
    this.clients[clientId] = client;
    await this.persist();
    return client;
  }

  find(clientId: string): OAuthClient | null {
    return this.clients[clientId] ?? null;
  }

  verifySecret(client: OAuthClient, secret: string | undefined): boolean {
    if (client.tokenEndpointAuthMethod === 'none') return true;
    if (!client.clientSecret || !secret) return false;
    const a = Buffer.from(secret);
    const b = Buffer.from(client.clientSecret);
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a[i]! ^ b[i]!;
    return diff === 0;
  }
}
