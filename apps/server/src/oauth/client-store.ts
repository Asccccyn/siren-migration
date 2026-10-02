/**
 * OAuth 客户端注册表（RFC 7591 动态注册的结果落盘）。
 * JSON 文件存 data/oauth-clients.json，原子写（tmp+rename）；注册必须跨重启存活，
 * 否则客户端 refresh_token 会因 client 丢失而失效，用户就得重新走一遍授权。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

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
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ clients: this.clients }, null, 2), 'utf8');
    await rename(tmp, this.file);
  }

  async register(input: {
    clientName: string;
    redirectUris: string[];
    tokenEndpointAuthMethod: 'none' | 'client_secret_post';
  }): Promise<OAuthClient> {
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
