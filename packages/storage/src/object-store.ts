/**
 * 音频对象存储抽象：R2（生产）与本地磁盘（开发/测试）共用同一接口。
 * Bucket 必须 private，客户端只拿 signed URL（规范第 30/31 节）。
 */

export interface ObjectStore {
  readonly kind: 'r2' | 'local';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** 生成有时效的只读 URL */
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
}

/** 校验 object key：只允许受控字符集，禁止路径穿越（规范第 33/47 节） */
export function isValidObjectKey(key: string): boolean {
  if (!key || key.length > 512) return false;
  if (key.includes('..')) return false;
  if (key.includes('\\')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9/\-_.*]*$/.test(key);
}

export function assertValidObjectKey(key: string): void {
  if (!isValidObjectKey(key)) {
    throw new Error(`invalid object key: ${JSON.stringify(key)}`);
  }
}
