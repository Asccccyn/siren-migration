import { mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { cleanupTmpDir, removeTmpFile, savePartStreamToTmp } from '../apps/server/src/tmp-files.ts';

describe('临时文件管理（规范第 33 节）', () => {
  it('UUID 文件名流式保存 / 删除', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'siren-tmp-'));
    const { path } = await savePartStreamToTmp(
      dir,
      Readable.from([Buffer.from('hello')]),
      1024 * 1024,
      '.webm'
    );
    expect(path).toBeTruthy();
    expect(path).toContain(dir);
    expect(path).not.toContain('hello'); // 内容不进入文件名
    expect(path).toMatch(/[0-9a-f-]{36}\.webm$/); // UUID 命名
    await removeTmpFile(path as string);
    await expect(stat(path as string)).rejects.toThrow();
  });

  it('启动清理：只删除超龄文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'siren-tmp-2-'));
    const oldFile = join(dir, 'old.bin');
    const freshFile = join(dir, 'fresh.bin');
    await writeFile(oldFile, 'x');
    await writeFile(freshFile, 'x');
    const twoHoursAgo = new Date(Date.now() - 2.5 * 60 * 60 * 1000);
    await utimes(oldFile, twoHoursAgo, twoHoursAgo);

    const result = await cleanupTmpDir(dir, 2 * 60 * 60 * 1000);
    expect(result.removed).toBe(1);
    await expect(stat(oldFile)).rejects.toThrow();
    expect((await stat(freshFile)).isFile()).toBe(true);
  });

  it('清理不存在的目录不报错', async () => {
    const result = await cleanupTmpDir(join(tmpdir(), 'siren-no-such-dir-xyz'));
    expect(result.removed).toBe(0);
  });
});
