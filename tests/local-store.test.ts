import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalObjectStore, MemoryObjectStore } from '@siren/storage';

describe('对象存储（R2 mock / 本地存储）', () => {
  it('MemoryObjectStore put/get/exists/delete', async () => {
    const store = new MemoryObjectStore();
    await store.put('voice/2026/09/c/m/audio.mp3', Buffer.from('abc'), 'audio/mpeg');
    expect(await store.exists('voice/2026/09/c/m/audio.mp3')).toBe(true);
    expect((await store.get('voice/2026/09/c/m/audio.mp3')).toString()).toBe('abc');
    await store.delete('voice/2026/09/c/m/audio.mp3');
    expect(await store.exists('voice/2026/09/c/m/audio.mp3')).toBe(false);
  });

  it('LocalObjectStore 签名 URL 可验证且过期失效', async () => {
    const root = await mkdtemp(join(tmpdir(), 'siren-store-'));
    const store = new LocalObjectStore({
      rootDir: root,
      publicBaseUrl: 'https://siren.example.com',
      signingSecret: 'test-secret'
    });
    await store.put('voice/a/b/audio.mp3', Buffer.from('data'), 'audio/mpeg');
    const url = await store.signedUrl('voice/a/b/audio.mp3', 60);
    expect(url).toContain('https://siren.example.com/v1/assets/voice/a/b/audio.mp3?expires=');
    expect(url).toContain('sig=');

    // 解析并验证签名
    const parsed = new URL(url);
    const expires = Number(parsed.searchParams.get('expires'));
    const sig = parsed.searchParams.get('sig') ?? '';
    const { verifyObjectSignature } = await import('@siren/storage');
    expect(verifyObjectSignature('voice/a/b/audio.mp3', expires, sig, 'test-secret')).toBe(true);
    expect(verifyObjectSignature('voice/a/b/audio.mp3', expires, sig, 'wrong-secret')).toBe(false);
    expect(verifyObjectSignature('voice/a/b/audio.mp3', expires - 120, sig, 'test-secret')).toBe(false);
  });

  it('路径穿越与非法 key 被拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'siren-store-'));
    const store = new LocalObjectStore({
      rootDir: root,
      publicBaseUrl: 'https://siren.example.com',
      signingSecret: 's'
    });
    await expect(store.put('../escape.mp3', Buffer.from('x'), 'audio/mpeg')).rejects.toThrow(/invalid object key/);
    await expect(store.put('a/../../escape.mp3', Buffer.from('x'), 'audio/mpeg')).rejects.toThrow();
    await expect(store.put('bad key with spaces', Buffer.from('x'), 'audio/mpeg')).rejects.toThrow();
    await expect(store.get('..\\windows-path')).rejects.toThrow();
  });

  it('LocalObjectStore 正常读写嵌套 key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'siren-store-'));
    const store = new LocalObjectStore({
      rootDir: root,
      publicBaseUrl: 'http://127.0.0.1:8790',
      signingSecret: 's'
    });
    const key = 'voice/2026/09/conv-1/msg-1/audio.mp3';
    await store.put(key, Buffer.from('hello'), 'audio/mpeg');
    expect((await store.get(key)).toString()).toBe('hello');
    expect(await store.exists(key)).toBe(true);
    await store.delete(key);
    expect(await store.exists(key)).toBe(false);
  });
});
