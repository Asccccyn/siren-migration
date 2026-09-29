/**
 * 临时文件管理（规范第 33 节）。
 * - UUID 文件名，禁止拼接用户原始文件名（防 path traversal）
 * - 完成后删除；启动时清理超时文件
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';

export const TMP_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 小时

export async function ensureTmpDir(tmpDir: string): Promise<void> {
  await mkdir(tmpDir, { recursive: true });
}

export interface StreamSaveResult {
  path: string | null;
  bytes: number;
  /** 超过 maxBytes：文件已删除，调用方应按 413 处理 */
  overflowed: boolean;
}

/** 统计通过字节数；超过上限即抛错销毁流（终止上游 pipeline） */
function byteCounter(maxBytes: number, onOverflow: () => void): { transform: Transform; getBytes: () => number } {
  let total = 0;
  let overflowed = false;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (overflowed) return;
      total += chunk.length;
      if (total > maxBytes) {
        overflowed = true;
        onOverflow();
        callback(new Error('upload exceeds limit'));
        return;
      }
      callback(null, chunk);
    }
  });
  return { transform, getBytes: () => total };
}

/**
 * 流式保存上传 part（审计 F04）：必须在 parts 循环内边到达边消费/落盘，
 * 否则文件填满解析器内部缓冲后双方互等，常见大小（256 KiB+）即挂起。
 */
export async function savePartStreamToTmp(
  tmpDir: string,
  stream: Readable,
  maxBytes: number,
  ext = '.upload'
): Promise<StreamSaveResult> {
  await ensureTmpDir(tmpDir);
  const path = join(tmpDir, `${randomUUID()}${ext.startsWith('.') ? ext : `.${ext}`}`);
  let overflowed = false;
  const counter = byteCounter(maxBytes, () => {
    overflowed = true;
  });
  try {
    await pipeline(stream, counter.transform, createWriteStream(path));
  } catch {
    if (!overflowed) {
      await rm(path, { force: true }).catch(() => undefined);
      throw new Error('audio stream interrupted');
    }
  }
  if (overflowed) {
    await rm(path, { force: true }).catch(() => undefined);
    return { path: null, bytes: counter.getBytes(), overflowed: true };
  }
  return { path, bytes: counter.getBytes(), overflowed: false };
}

export async function removeTmpFile(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

/** 启动清理：删除超过 maxAge 的残留文件 */
export async function cleanupTmpDir(
  tmpDir: string,
  maxAgeMs = TMP_MAX_AGE_MS
): Promise<{ removed: number }> {
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = await readdir(tmpDir);
  } catch {
    return { removed: 0 };
  }
  const now = Date.now();
  for (const entry of entries) {
    const path = join(tmpDir, entry);
    try {
      const info = await stat(path);
      if (info.isFile() && now - info.mtimeMs > maxAgeMs) {
        await rm(path, { force: true });
        removed++;
      }
    } catch {
      // 并发删除等异常忽略
    }
  }
  return { removed };
}
