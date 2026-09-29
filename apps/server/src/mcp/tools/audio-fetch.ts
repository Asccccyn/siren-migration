/**
 * MCP 音频下载边界（审计 F03/F21）。
 * - F03：URL 出站校验——只允许 http/https 公网地址；解析 DNS 后拒绝回环/私网/
 *   链路本地/保留地址，且每一跳重定向都重新校验（防内网探测与云元数据读取）
 * - F21：大小限制在下载阶段流式生效——先查 Content-Length 提前拒绝，
 *   再按实际累计字节在中途取消，不允许先 arrayBuffer 全量入内存
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type AudioFetchErrorCode = 'blocked_url' | 'too_large' | 'download_failed';

export class AudioFetchError extends Error {
  readonly code: AudioFetchErrorCode;
  constructor(code: AudioFetchErrorCode, message: string) {
    super(message);
    this.name = 'AudioFetchError';
    this.code = code;
  }
}

export interface AudioDownloadOptions {
  maxBytes: number;
  timeoutMs: number;
  /** 重定向上限（默认 3；每一跳都重新做出站校验） */
  maxRedirects?: number;
}

export interface AudioDownload {
  audio: Buffer;
  contentType: string;
  bytes: number;
}

// ---------------------------------------------------------------------------
// 地址判定
// ---------------------------------------------------------------------------

/** IPv4 CIDR（不含默认路由语义，仅做数值区间） */
const BLOCKED_V4_CIDRS = [
  '0.0.0.0/8', // "this network"
  '10.0.0.0/8', // RFC1918
  '100.64.0.0/10', // CGNAT
  '127.0.0.0/8', // 回环
  '169.254.0.0/16', // 链路本地（含云元数据 169.254.169.254）
  '172.16.0.0/12', // RFC1918
  '192.168.0.0/16', // RFC1918
  '198.18.0.0/15', // 基准测试
  '224.0.0.0/3' // 组播 + 保留 + 广播
];

function parseIPv4ToBigInt(host: string): bigint | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseCidr4(cidr: string): { start: bigint; end: bigint } {
  const [base, bitsRaw] = cidr.split('/');
  const bits = BigInt(bitsRaw);
  const baseValue = parseIPv4ToBigInt(base as string) ?? 0n;
  const size = 1n << (32n - bits);
  const mask = size - 1n;
  return { start: baseValue & ~mask, end: (baseValue & ~mask) + size - 1n };
}

const BLOCKED_V4 = BLOCKED_V4_CIDRS.map(parseCidr4);

/** 展开 IPv6（支持 :: 与内嵌 IPv4 尾段，去 zone id），失败返回 null */
function parseIPv6ToBigInt(input: string): bigint | null {
  let host = input;
  const zoneIndex = host.indexOf('%');
  if (zoneIndex >= 0) host = host.slice(0, zoneIndex);
  host = host.replace(/^\[|\]$/g, '');

  let v4Tail: bigint | null = null;
  const lastColon = host.lastIndexOf(':');
  if (host.slice(lastColon + 1).includes('.')) {
    v4Tail = parseIPv4ToBigInt(host.slice(lastColon + 1));
    if (v4Tail === null) return null;
    host = `${host.slice(0, lastColon + 1)}0:0`;
  }

  let groups: number[];
  if (!host.includes('::')) {
    const parts = host.split(':');
    if (parts.length !== 8) return null;
    groups = parts.map(parseHexGroup);
  } else {
    const [head, tail] = host.split('::');
    const headGroups = head ? head.split(':').filter(Boolean) : [];
    const tailGroups = tail ? tail.split(':').filter(Boolean) : [];
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 1) return null;
    groups = [
      ...headGroups.map(parseHexGroup),
      ...Array.from({ length: missing }, () => 0),
      ...tailGroups.map(parseHexGroup)
    ];
  }
  if (groups.length !== 8 || groups.some((g) => g < 0 || g > 0xffff)) return null;
  let value = 0n;
  for (const g of groups) value = (value << 16n) | BigInt(g);
  if (v4Tail !== null) value = (value & 0xffff_ffff_ffff_ffff_0000_0000n) | v4Tail;
  return value;
}

function parseHexGroup(part: string): number {
  if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return -1;
  return Number.parseInt(part, 16);
}

/** 判断字面 IP 是否为禁止出站的地址（回环/私网/链路本地/保留段） */
export function isBlockedAddress(host: string): boolean {
  const family = isIP(host);
  if (family === 4) {
    const value = parseIPv4ToBigInt(host);
    if (value === null) return true;
    return BLOCKED_V4.some((range) => value >= range.start && value <= range.end);
  }
  if (family === 6) {
    const value = parseIPv6ToBigInt(host);
    if (value === null) return true;
    // :: 与 ::1
    if (value <= 1n) return true;
    // IPv4-mapped ::ffff:0:0/96：按内嵌 v4 判定
    if (value >= 0xffff_0000_0000n && value <= 0xffff_ffff_ffffn) {
      return isBlockedAddress(intToDottedQuad(value & 0xffff_ffffn));
    }
    // NAT64 64:ff9b::/96：内嵌 v4 同样判定
    if (value >= 0x0064_ff9b_0000_0000_0000_0000_0000_0000n && value <= 0x0064_ff9b_0000_0000_ffff_ffff_ffff_ffffn) {
      return isBlockedAddress(intToDottedQuad(value & 0xffff_ffffn));
    }
    // fc00::/7 ULA / fe80::/10 链路本地 / ff00::/8 组播 / 2001:db8::/32 文档段
    if (value >= 0xfc00n << 112n && value < 0xfe00n << 112n) return true;
    if (value >= 0xfe80n << 112n && value < 0xfec0n << 112n) return true;
    if (value >= 0xff00n << 112n) return true;
    if (value >= 0x2001_0db8n << 96n && value < 0x2001_0db9n << 96n) return true;
    return false;
  }
  return false;
}

function intToDottedQuad(value: bigint): string {
  const a = (value >> 24n) & 0xffn;
  const b = (value >> 16n) & 0xffn;
  const c = (value >> 8n) & 0xffn;
  const d = value & 0xffn;
  return `${a}.${b}.${c}.${d}`;
}

/**
 * 出站校验：协议限 http/https；主机名先做字面 IP 判定，
 * 否则 DNS 解析全部地址——任一解析结果落在禁止段即整体拒绝
 * （避免 happy-eyeballs 落到私网地址的窗口）。
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AudioFetchError('blocked_url', `invalid url: ${rawUrl.slice(0, 100)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AudioFetchError('blocked_url', `url scheme not allowed: ${url.protocol}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new AudioFetchError('blocked_url', `non-public address blocked: ${hostname}`);
    }
    return url;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new AudioFetchError('blocked_url', `dns lookup failed: ${hostname}`);
  }
  if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new AudioFetchError('blocked_url', `host resolves to non-public address: ${hostname}`);
  }
  return url;
}

// ---------------------------------------------------------------------------
// 受限下载
// ---------------------------------------------------------------------------

export async function downloadWithLimits(rawUrl: string, options: AudioDownloadOptions): Promise<AudioDownload> {
  const maxRedirects = options.maxRedirects ?? 3;
  let current = await assertPublicHttpUrl(rawUrl);
  let response: Response;
  for (let hop = 0; ; hop++) {
    response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs)
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new AudioFetchError('download_failed', `redirect without location: ${response.status}`);
      }
      if (hop >= maxRedirects) {
        throw new AudioFetchError('download_failed', 'too many redirects');
      }
      // 每一跳重定向都重新做出站校验（F03：不校验重定向目标等于没有校验）
      current = await assertPublicHttpUrl(new URL(location, current).toString());
      continue;
    }
    break;
  }
  if (!response.ok) {
    throw new AudioFetchError('download_failed', `audio download failed: ${response.status}`);
  }

  // F21：Content-Length 提前拒绝（声明即拒绝，不等分配）
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new AudioFetchError('too_large', `audio too large: declared ${declaredLength} bytes`);
  }
  if (!response.body) {
    throw new AudioFetchError('download_failed', 'download body missing');
  }

  // F21：流式累计，越界立即取消读——没有"先全量 arrayBuffer 再检查"的窗口
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > options.maxBytes) {
        throw new AudioFetchError('too_large', `audio too large: exceeded ${options.maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof AudioFetchError) throw error;
    throw new AudioFetchError('download_failed', `audio download interrupted: ${(error as Error).message}`);
  }
  return {
    audio: Buffer.concat(chunks),
    contentType: response.headers.get('content-type') ?? '',
    bytes: total
  };
}
