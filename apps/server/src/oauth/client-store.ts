/** OAuth 注册表：单进程串行事务；提交成功后才发布内存状态。 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isMissingFile, OAuthStateError, writeOAuthState } from './state-file.ts';

const MAX_CLIENTS = 200;
const PENDING_TTL_MS = 24 * 3600_000;

export interface OAuthClient {
  clientId: string;
  clientSecret: string | null;
  tokenEndpointAuthMethod: 'none' | 'client_secret_post';
  redirectUris: string[];
  clientName: string;
  createdAt: string;
  /** null=新注册待人类授权；缺省为旧版档案，保守保护，不自动删除。 */
  authorizedAt?: string | null;
}

export class RegistrationCapacityError extends Error {
  constructor() { super('registration_capacity_reached'); }
}

function validClient(value: unknown, id: string): value is OAuthClient {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<OAuthClient>;
  return c.clientId === id && typeof c.clientName === 'string' &&
    typeof c.createdAt === 'string' && Number.isFinite(Date.parse(c.createdAt)) &&
    (c.clientSecret === null || typeof c.clientSecret === 'string') &&
    (c.tokenEndpointAuthMethod === 'none' || c.tokenEndpointAuthMethod === 'client_secret_post') &&
    Array.isArray(c.redirectUris) && c.redirectUris.every((uri) => typeof uri === 'string') &&
    (c.authorizedAt === undefined || c.authorizedAt === null ||
      (typeof c.authorizedAt === 'string' && Number.isFinite(Date.parse(c.authorizedAt))));
}

function expiredPending(client: OAuthClient): boolean {
  return client.authorizedAt === null && Date.parse(client.createdAt) + PENDING_TTL_MS <= Date.now();
}

export class OAuthClientStore {
  private readonly file: string;
  private clients: Record<string, OAuthClient> = {};
  private writeChain: Promise<void> = Promise.resolve();
  private writeFailed = false;

  constructor(dataDir: string) { this.file = join(dataDir, 'oauth-clients.json'); }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { clients?: unknown };
      if (!raw || !raw.clients || typeof raw.clients !== 'object' || Array.isArray(raw.clients)) {
        throw new OAuthStateError();
      }
      const clients: Record<string, OAuthClient> = {};
      for (const [id, value] of Object.entries(raw.clients)) {
        if (!validClient(value, id)) throw new OAuthStateError();
        Object.defineProperty(clients, id, { value, enumerable: true, configurable: true, writable: true });
      }
      this.clients = clients;
    } catch (error) {
      if (!isMissingFile(error)) throw new OAuthStateError();
    }
  }

  private transact<T>(update: (next: Record<string, OAuthClient>) => T): Promise<T> {
    const job = this.writeChain.then(async () => {
      const next = { ...this.clients };
      const result = update(next);
      try {
        await writeOAuthState(this.file, { clients: next });
        this.writeFailed = false;
      } catch (error) {
        this.writeFailed = true;
        throw error;
      }
      this.clients = next;
      return result;
    });
    this.writeChain = job.then(() => undefined, () => undefined);
    return job;
  }

  async flush(): Promise<void> {
    await this.writeChain;
    if (this.writeFailed) throw new OAuthStateError();
  }

  get size(): number { return Object.keys(this.clients).length; }

  register(input: {
    clientName: string;
    redirectUris: string[];
    tokenEndpointAuthMethod: 'none' | 'client_secret_post';
  }): Promise<OAuthClient> {
    return this.transact((next) => {
      for (const client of Object.values(next)) {
        if (expiredPending(client)) delete next[client.clientId];
      }
      while (Object.keys(next).length >= MAX_CLIENTS) {
        const oldest = Object.values(next).filter((c) => c.authorizedAt === null)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!oldest) throw new RegistrationCapacityError();
        // 匿名注册不能永久占满容量；已授权和旧版客户端始终保留。
        delete next[oldest.clientId];
      }
      const client: OAuthClient = {
        clientId: `siren-${randomBytes(12).toString('base64url')}`,
        clientSecret: input.tokenEndpointAuthMethod === 'client_secret_post' ? randomBytes(24).toString('base64url') : null,
        tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
        redirectUris: [...input.redirectUris],
        clientName: input.clientName,
        createdAt: new Date().toISOString(),
        authorizedAt: null
      };
      next[client.clientId] = client;
      return client;
    });
  }

  /** 在发授权码前可靠标记：容量回收不得淘汰人类已授权的客户端。 */
  authorize(clientId: string): Promise<boolean> {
    return this.transact((next) => {
      const client = Object.hasOwn(next, clientId) ? next[clientId] : undefined;
      if (!client || expiredPending(client)) return false;
      next[clientId] = { ...client, authorizedAt: client.authorizedAt ?? new Date().toISOString() };
      return true;
    });
  }

  find(clientId: string): OAuthClient | null {
    const client = Object.hasOwn(this.clients, clientId) ? this.clients[clientId] : undefined;
    return client && !expiredPending(client) ? client : null;
  }

  list(): { client_id: string; client_name: string; created_at: string; pending: boolean }[] {
    return Object.values(this.clients).map((client) => ({
      client_id: client.clientId,
      client_name: client.clientName,
      created_at: client.createdAt,
      pending: client.authorizedAt === null
    }));
  }

  remove(clientId: string): Promise<boolean> {
    return this.transact((next) => {
      const found = Object.hasOwn(next, clientId);
      delete next[clientId];
      return found;
    });
  }

  verifySecret(client: OAuthClient, secret: string | undefined): boolean {
    if (client.tokenEndpointAuthMethod === 'none') return true;
    if (!client.clientSecret || !secret) return false;
    const a = Buffer.from(secret);
    const b = Buffer.from(client.clientSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
