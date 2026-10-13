/** 单进程 OAuth 状态提交：先同步临时文件，再原子替换；不返回未提交的成功。 */
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export class OAuthStateError extends Error {
  readonly code = 'oauth_storage_unavailable';
  constructor() {
    super('OAuth state could not be read or committed');
    this.name = 'OAuthStateError';
  }
}

export function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

export async function writeOAuthState(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch {
    throw new OAuthStateError();
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}
