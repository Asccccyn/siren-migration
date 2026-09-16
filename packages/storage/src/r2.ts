/**
 * Cloudflare R2 对象存储（S3 兼容 API）。
 * - Bucket private，客户端只拿 presigned GET URL
 * - 所有请求带超时（规范第 47 节第 16 条）
 */
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertValidObjectKey, type ObjectStore } from './object-store.ts';

export interface R2StoreOptions {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  requestTimeoutMs?: number;
}

export class R2ObjectStore implements ObjectStore {
  readonly kind = 'r2' as const;
  private readonly client: S3Client;

  constructor(private readonly options: R2StoreOptions) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${options.accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey
      },
      requestHandler: {
        requestTimeout: options.requestTimeoutMs ?? 15000,
        connectionTimeout: 5000
      }
    });
  }

  private commandKey(key: string): string {
    assertValidObjectKey(key);
    return key;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: this.commandKey(key),
        Body: body,
        ContentType: contentType
      })
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: this.commandKey(key) })
    );
    if (!res.Body) throw new Error(`empty object body: ${key}`);
    const bytes = await res.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: this.commandKey(key) })
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: this.commandKey(key) })
      );
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.options.bucket, Key: this.commandKey(key) }),
      { expiresIn: ttlSeconds }
    );
  }
}

/** 内存对象存储：测试专用 Mock（规范 Phase 12 “R2 mock”） */
export class MemoryObjectStore implements ObjectStore {
  readonly kind = 'local' as const;
  private readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertValidObjectKey(key);
    this.objects.set(key, { body: Buffer.from(body), contentType });
  }

  async get(key: string): Promise<Buffer> {
    const obj = this.objects.get(key);
    if (!obj) throw new Error(`object not found: ${key}`);
    return obj.body;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    return `https://memory.siren.local/v1/assets/${key}?ttl=${ttlSeconds}&sig=mock`;
  }

  size(): number {
    return this.objects.size;
  }
}
