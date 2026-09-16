import { describe, expect, it } from 'vitest';
import { createLogger } from '@siren/telemetry';

function capture(): { lines: Record<string, unknown>[]; logger: ReturnType<typeof createLogger> } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    sink: (line) => lines.push(JSON.parse(line)),
    logTranscripts: false
  });
  return { lines, logger };
}

describe('Logger 脱敏（规范第 38 节）', () => {
  it('token/secret/key/authorization/cookie 全部脱敏', () => {
    const { lines, logger } = capture();
    logger.info('test_event', {
      access_token: 'abc',
      refreshToken: 'def',
      api_key: 'k',
      Authorization: 'Bearer x',
      cookie: 'sid=1',
      password: 'pw',
      normal_field: 42
    });
    const entry = lines[0];
    expect(entry.access_token).toBe('[redacted]');
    expect(entry.refreshToken).toBe('[redacted]');
    expect(entry.api_key).toBe('[redacted]');
    expect(entry.Authorization).toBe('[redacted]');
    expect(entry.cookie).toBe('[redacted]');
    expect(entry.password).toBe('[redacted]');
    expect(entry.normal_field).toBe(42);
  });

  it('文本内容默认不落日志，开启 LOG_TRANSCRIPTS 后可见', () => {
    const closed = capture();
    closed.logger.info('e', { text: '你好世界' });
    expect(closed.lines[0].text).toBe('[len:4]');

    const lines: Record<string, unknown>[] = [];
    const open = createLogger({
      level: 'debug',
      logTranscripts: true,
      sink: (line) => lines.push(JSON.parse(line))
    });
    open.info('e', { text: '你好世界' });
    expect(lines[0].text).toBe('你好世界');
  });

  it('child logger 继承绑定字段', () => {
    const { lines, logger } = capture();
    const child = logger.child({ call_id: 'c1' });
    child.info('child_event', { turn_index: 3 });
    expect(lines[0].call_id).toBe('c1');
    expect(lines[0].turn_index).toBe(3);
  });

  it('Error 对象压缩为 name/message', () => {
    const { lines, logger } = capture();
    logger.error('e', { err: new Error('boom') });
    expect(lines[0].err).toEqual({ name: 'Error', message: 'boom' });
  });
});
