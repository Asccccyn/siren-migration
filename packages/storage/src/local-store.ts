/**
 * 本地磁盘对象存储（未配置 R2 时的开发/自托管回退）。
 * 通过 Siren 的 /v1/assets/* + HMAC 签名代理对外，保持与 R2 相同的访问模型。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assertValidObjectKey, type ObjectStore } from './object-store.ts';

export function signObjectKey(key: string, expires: number, secret: string): string {
  return createHmac('sha256', secret).update(`${key}:${expires}`).digest('hex');
}

export function verifyObjectSignature(
  key: string,
  expires: number,
  signature: string,
  secret: string
): boolean {
  if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false;
  const expected = signObjectKey(key, expires, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface LocalObjectStoreOptions {
  rootDir: string;
  /** 公网访问基础 URL，如 https://siren.example.com */
  publicBaseUrl: string;
  signingSecret: string;
}

export class LocalObjectStore implements ObjectStore {
  readonly kind = 'local' as const;
  private readonly root: string;

  constructor(private readonly options: LocalObjectStoreOptions) {
    this.root = resolve(options.rootDir);
  }

  private pathFor(key: string): string {
    assertValidObjectKey(key);
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root)) {
      throw new Error(`object key escapes store root: ${JSON.stringify(key)}`);
    }
    return full;
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      const s = await stat(this.pathFor(key));
      return s.isFile();
    } catch {
      return false;
    }
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    assertValidObjectKey(key);
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const signature = signObjectKey(key, expires, this.options.signingSecret);
    const base = this.options.publicBaseUrl.replace(/\/$/, '');
    return `${base}/v1/assets/${key}?expires=${expires}&sig=${signature}`;
  }

  /** 供 REST 代理路由安全读取文件流 */
  openStream(key: string): ReturnType<typeof createReadStream> {
    return createReadStream(this.pathFor(key));
  }
}
