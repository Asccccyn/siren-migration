/**
 * DB 正文字段静态加密（S1011-013）：AES-256-GCM，密文带 enc1: 前缀。
 * - 密钥：SIREN_DATA_KEY（hex/base64，优先）或从 SIREN_SIGNING_SECRET 派生
 *   （HMAC 域分隔，与资源签名密钥互不通用）
 * - 兼容读取：无前缀的旧明文原样返回，不自动迁移；新业务正文一律加密。
 *   密文认证失败明确抛错，不能与合法 null 混淆。旧数据/密钥轮换由独立维护处理。
 * - 范围：SQLite 内的正文/转写/tts_script/音色ID/通话文本。音频对象本体不在
 *   此列（经签名 URL/R2 私桶保护），此工具不处理历史备份或对象正文。
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const PREFIX = 'enc1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Safe at transport/log boundaries: never include the stored value or key. */
export class FieldDecryptionError extends Error {
  readonly code = 'data_unreadable';

  constructor() {
    super('stored data could not be decrypted; verify the data key or restore the original key');
    this.name = 'FieldDecryptionError';
  }
}

function decodePart(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new FieldDecryptionError();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new FieldDecryptionError();
  return decoded;
}

export class FieldCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('field cipher key must be 32 bytes');
  }

  seal(plain: string): string {
    // This argument is always business plaintext, including strings beginning with enc1:.
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_BYTES });
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64url')}.${ct.toString('base64url')}.${tag.toString('base64url')}`;
  }

  /** 解密存储值；旧明文只兼容读取，认证失败抛错，绝不改写原值。 */
  open(value: string | null): string | null {
    if (value === null) return null;
    if (!value.startsWith(PREFIX)) return value; // 历史明文（不执行迁移）
    const parts = value.slice(PREFIX.length).split('.');
    if (parts.length !== 3) throw new FieldDecryptionError();
    try {
      const iv = decodePart(parts[0]!);
      const ct = decodePart(parts[1]!);
      const tag = decodePart(parts[2]!);
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new FieldDecryptionError();
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_BYTES });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      throw new FieldDecryptionError();
    }
  }
}

/** SIREN_DATA_KEY（hex 64 / base64 44）优先；否则从签名密钥派生（域分隔） */
export function deriveFieldCipher(options: { dataKey?: string | null; signingSecret: string }): FieldCipher {
  const raw = options.dataKey?.trim();
  if (raw) {
    const key = /^(0x)?[0-9a-fA-F]{64}$/.test(raw)
      ? Buffer.from(raw.replace(/^0x/, ''), 'hex')
      : Buffer.from(raw, 'base64');
    if (key.length !== 32 || (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw) && key.toString('base64') !== raw)) {
      throw new Error('SIREN_DATA_KEY 必须是 32 字节（hex 64 位或规范 base64 44 位）');
    }
    return new FieldCipher(key);
  }
  const derived = createHmac('sha256', options.signingSecret).update('siren:field-crypto:v1').digest();
  return new FieldCipher(derived);
}
