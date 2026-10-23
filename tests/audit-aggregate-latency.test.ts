import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '@siren/storage';

describe('independent audit: latency aggregation denominator', () => {
  it('keeps missing and corrupt samples visible without making them fast successes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'siren-audit-latency-'));
    const path = join(dir, 'audit.db');
    const db = openDatabase(path);
    db.prepare(`INSERT INTO call_sessions (id, voice_profile, status, created_at) VALUES ('c','main','ended',0)`).run();
    const insert = db.prepare(`INSERT INTO call_turns (id,call_id,turn_index,created_at,first_audio_ms,first_content_audio_ms)
      VALUES (?, 'c', ?, ?, ?, ?)`);
    [0, 800, null, -20].forEach((value, index) => insert.run(String(index), index, index, value, value));
    db.close();
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [resolve('scripts/aggregate-turn-latency.mjs'), '--db', path]);
      const result = JSON.parse(stdout);
      expect(result.first_content_audio_ms).toEqual({ count: 2, p50: 0, p95: 800 });
      expect(result.quality.first_content_audio_ms).toEqual({ total: 4, missing: 1, invalid: 1, max: 800 });
      expect(result.measurement_basis).toBe('server_end_received_to_pcm_send_request');
      expect(result.notes.join(' ')).toContain('不稳定');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
