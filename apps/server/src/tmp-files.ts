/**
 * 临时文件管理（规范第 33 节）。
 * - UUID 文件名，禁止拼接用户原始文件名（防 path traversal）
 * - 完成后删除；启动时清理超时文件
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const TMP_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 小时

export async function ensureTmpDir(tmpDir: string): Promise<void> {
  await mkdir(tmpDir, { recursive: true });
}

export async function saveBufferToTmp(tmpDir: string, data: Buffer, ext = '.bin'): Promise<string> {
  await ensureTmpDir(tmpDir);
  const name = `${randomUUID()}${ext.startsWith('.') ? ext : `.${ext}`}`;
  const path = join(tmpDir, name);
  await writeFile(path, data);
  return path;
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
