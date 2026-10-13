/**
 * MCP 音频下载边界（审计 F03/F21）。
 * - F03：URL 出站校验——只允许 http/https 公网地址；解析 DNS 后拒绝回环/私网/
 *   链路本地/保留地址，且每一跳重定向都重新校验（防内网探测与云元数据读取）
 * - F21：大小限制在下载阶段流式生效——先查 Content-Length 提前拒绝，
 *   再按实际累计字节在中途取消，不允许先 arrayBuffer 全量入内存
 */
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
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

/** 出站目标：url + 已校验的 DNS 地址（字面 IP 时为 null——连接本身即绑定） */
interface OutboundTarget {
  url: URL;
  pinned: LookupAddress[] | null;
}

/**
 * 出站校验与解析钉住（S1011-003 修复）：协议限 http/https；主机名先做字面 IP 判定，
 * 否则 DNS 解析全部地址——任一解析结果落在禁止段即整体拒绝。
 * 校验通过的解析列表作为 pinned 随目标返回，实际连接用同一列表做自定义 lookup，
 * 消除"校验时解析一次、连接时再解析一次"的 DNS 重绑定窗口。
 */
async function resolveOutbound(rawUrl: string): Promise<OutboundTarget> {
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
    return { url, pinned: null };
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new AudioFetchError('blocked_url', `dns lookup failed: ${hostname}`);
  }
  if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new AudioFetchError('blocked_url', `host resolves to non-public address: ${hostname}`);
  }
  return { url, pinned: addresses };
}

/** 对外保持原签名：只做校验并返回 URL（pinned 语义由 downloadWithLimits 内部使用） */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  return (await resolveOutbound(rawUrl)).url;
}

/** 连接仍使用原 Host/TLS 名称，DNS 只返回已经校验的地址。 */
function pinnedLookup(addresses: LookupAddress[]): NonNullable<RequestOptions['lookup']> {
  return ((_hostname: string, options: { all?: boolean; family?: number }, callback: (...args: unknown[]) => void) => {
    const choices = options.family ? addresses.filter((entry) => entry.family === options.family) : addresses;
    if (choices.length === 0) { callback(new Error('no validated address for requested family')); return; }
    if (options.all) callback(null, choices);
    else callback(null, choices[0]!.address, choices[0]!.family);
  }) as unknown as NonNullable<RequestOptions['lookup']>;
}

/** DNS 没有可取消的底层句柄；晚到的解析只能被丢弃，绝不能继续建连。 */
function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** 同一 abort 信号负责响应头之前的 Promise 与响应头之后的 body。 */
function sendPinned(target: OutboundTarget, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const options: RequestOptions = { headers: { 'user-agent': 'siren-audio-fetch', accept: '*/*' } };
    if (target.pinned) options.lookup = pinnedLookup(target.pinned);
    const req = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(target.url, options);
    let response: IncomingMessage | undefined;
    let finished = false;
    const finish = () => {
      finished = true;
      signal.removeEventListener('abort', abort);
    };
    const fail = (error: Error) => {
      if (finished) return;
      finish();
      reject(error); // 头前结束等待；头后由 destroy(error) 解锁 body 读取。
      response?.destroy(error);
      req.destroy(error);
    };
    const abort = () => fail(signal.reason as Error);
    signal.addEventListener('abort', abort, { once: true });
    req.on('error', fail);
    req.on('response', (res) => {
      if (finished) { res.destroy(); return; }
      response = res;
      res.once('end', finish);
      res.once('close', finish);
      res.once('error', fail);
      resolve(res);
    });
    req.end();
  });
}

async function readAudio(response: IncomingMessage, maxBytes: number): Promise<AudioDownload> {
  const status = response.statusCode ?? 0;
  if (status < 200 || status >= 300) throw new AudioFetchError('download_failed', `audio download failed: ${status}`);
  const declaredLength = Number(response.headers['content-length'] ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AudioFetchError('too_large', `audio too large: declared ${declaredLength} bytes`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of response) {
      total += chunk.length;
      if (total > maxBytes) throw new AudioFetchError('too_large', `audio too large: exceeded ${maxBytes} bytes`);
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof AudioFetchError) throw error;
    throw new AudioFetchError('download_failed', 'audio download interrupted');
  }
  return { audio: Buffer.concat(chunks), contentType: response.headers['content-type'] ?? '', bytes: total };
}

/** 一个绝对期限覆盖 DNS、每次重定向、连接、响应头及 body。 */
export async function downloadWithLimits(rawUrl: string, options: AudioDownloadOptions): Promise<AudioDownload> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new AudioFetchError('download_failed', 'audio download timed out'));
  }, options.timeoutMs);
  const signal = controller.signal;
  try {
    let current = await withAbort(resolveOutbound(rawUrl), signal);
    for (let hop = 0; ; hop++) {
      const response = await sendPinned(current, signal);
      try {
        const status = response.statusCode ?? 0;
        if (status < 300 || status >= 400) return await readAudio(response, options.maxBytes);
        const location = response.headers.location;
        response.destroy();
        if (!location) throw new AudioFetchError('download_failed', `redirect without location: ${status}`);
        if (hop >= (options.maxRedirects ?? 3)) throw new AudioFetchError('download_failed', 'too many redirects');
        current = await withAbort(resolveOutbound(new URL(location, current.url).toString()), signal);
      } finally {
        response.destroy();
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
