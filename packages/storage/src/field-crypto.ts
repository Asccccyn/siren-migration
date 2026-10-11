/**
 * DB 正文字段静态加密（S1011-013）：AES-256-GCM，密文带 enc1: 前缀。
 * - 密钥：SIREN_DATA_KEY（hex/base64，优先）或从 SIREN_SIGNING_SECRET 派生
 *   （HMAC 域分隔，与资源签名密钥互不通用）
 * - 懒迁移：读取遇无前缀的旧行按明文返回（兼容历史数据）；写入一律加密；
 *   篡改/解密失败返回 null（调用方按字段缺失处理，绝不静默回吐伪造内容）
 * - 范围：SQLite 内的正文/转写/tts_script/音色ID/通话文本。音频对象本体不在
 *   此列（经签名 URL/R2 私桶保护，加密会破坏浏览器直接播放——边界已在
 *   README 数据策略中声明）。
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const PREFIX = 'enc1:';

export class FieldCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('field cipher key must be 32 bytes');
  }

  seal(plain: string): string {
    if (plain.startsWith(PREFIX)) return plain; // 已是密文（重写场景幂等）
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64url')}.${ct.toString('base64url')}.${tag.toString('base64url')}`;
  }

  /** 解密 enc1: 密文；无前缀的旧明文原样返回；篡改/错误返回 null */
  open(value: string | null): string | null {
    if (value === null) return null;
    if (!value.startsWith(PREFIX)) return value; // 历史明文（懒迁移）
    const parts = value.slice(PREFIX.length).split('.');
    if (parts.length !== 3) return null;
    try {
      const iv = Buffer.from(parts[0]!, 'base64url');
      const ct = Buffer.from(parts[1]!, 'base64url');
      const tag = Buffer.from(parts[2]!, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      return null;
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
    if (key.length !== 32) throw new Error('SIREN_DATA_KEY 必须是 32 字节（hex 64 位或 base64 44 位）');
    return new FieldCipher(key);
  }
  const derived = createHmac('sha256', options.signingSecret).update('siren:field-crypto:v1').digest();
  return new FieldCipher(derived);
}
