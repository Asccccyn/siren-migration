/**
 * 结构化 JSON 日志（规范第 38 节 / v1.1 P1-5）。
 * - 敏感字段精确匹配 credential 词段（token/secret/key/...）脱敏；
 *   延迟指标（llm_first_token_ms 等）不再被 /token/i 误伤
 * - 文本内容默认不落日志（LOG_TRANSCRIPTS=false）
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** credential 词段：key 归一化（小写、-/_ 统一）后按词段命中即脱敏 */
const SENSITIVE_SEGMENTS = new Set([
  'token',
  'tokens',
  'secret',
  'secrets',
  'key',
  'keys',
  'apikey',
  'password',
  'passwd',
  'authorization',
  'auth',
  'bearer',
  'cookie',
  'session',
  'credential',
  'credentials',
  'accesskey'
]);

/** 明确放行的指标/计数字段（含 token 字样但不是 credential，P1-5） */
const METRIC_ALLOWLIST = new Set([
  'llm_first_token_ms',
  'token_count',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'prompt_tokens',
  'completion_tokens',
  'max_tokens',
  'first_token_ms',
  'last_token_ms'
]);

function isSensitiveKey(rawKey: string): boolean {
  // camelCase 边界展开（refreshToken -> refresh_token），统一小写下划线分词
  const key = rawKey
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[-\s.]+/g, '_');
  if (METRIC_ALLOWLIST.has(key)) return false;
  if (SENSITIVE_SEGMENTS.has(key)) return true;
  const segments = key.split('_').filter(Boolean);
  // apikey / accesskey 等复合词段
  return segments.some((segment) => SENSITIVE_SEGMENTS.has(segment));
}

export interface LoggerOptions {
  level?: LogLevel;
  logFile?: string;
  /** 是否允许输出用户文本（transcript / tts 文本） */
  logTranscripts?: boolean;
  /** 附加的固定字段 */
  bindings?: Record<string, unknown>;
  /** 测试用：捕获输出而不写 stdout */
  sink?: (line: string) => void;
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function redact(fields: Record<string, unknown>, logTranscripts: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'text' || key === 'transcript' || key === 'tts_script' || key === 'user_text' || key === 'assistant_text') {
      out[key] = logTranscripts && typeof value === 'string' ? value : `[len:${typeof value === 'string' ? value.length : '?'}]`;
      continue;
    }
    if (isSensitiveKey(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (value instanceof Error) {
      out[key] = { name: value.name, message: value.message };
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const logTranscripts = options.logTranscripts ?? false;
  const file = options.logFile;
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {
      // 日志目录创建失败时退回 stdout
    }
  }

  const write = (line: string): void => {
    if (options.sink) {
      options.sink(line);
      return;
    }
    console.log(line);
    if (file) {
      try {
        appendFileSync(file, line + '\n');
      } catch {
        // 文件写入失败不影响服务
      }
    }
  };

  const makeLogger = (bindings: Record<string, unknown>): Logger => {
    const emit = (lvl: LogLevel, event: string, fields?: Record<string, unknown>): void => {
      if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
      const payload: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level: lvl,
        event,
        ...bindings,
        ...redact(fields ?? {}, logTranscripts)
      };
      write(JSON.stringify(payload));
    };
    return {
      debug: (event, fields) => emit('debug', event, fields),
      info: (event, fields) => emit('info', event, fields),
      warn: (event, fields) => emit('warn', event, fields),
      error: (event, fields) => emit('error', event, fields),
      child: (more) => makeLogger({ ...bindings, ...more })
    };
  };

  return makeLogger(options.bindings ?? {});
}

/** 把任意 unknown 错误压缩成可安全记录的形状 */
export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { error_name: error.name, error_message: error.message };
  }
  return { error: String(error) };
}
