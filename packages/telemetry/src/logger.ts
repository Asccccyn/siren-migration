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

/** 递归脱敏（S1011-008）：嵌套对象/数组里的敏感键同样处理，深度上限防循环/超深 */
function redactValue(value: unknown, logTranscripts: boolean, depth: number): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value instanceof Error) return errorFields(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, logTranscripts, depth + 1));
  }
  if (value && typeof value === 'object' && !(value instanceof Error) && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactEntry(k, v, logTranscripts, depth + 1);
    }
    return out;
  }
  return value;
}

function redactEntry(key: string, value: unknown, logTranscripts: boolean, depth: number): unknown {
  if (key === 'text' || key === 'transcript' || key === 'tts_script' || key === 'user_text' || key === 'assistant_text') {
    return logTranscripts && typeof value === 'string' ? value : `[len:${typeof value === 'string' ? value.length : '?'}]`;
  }
  if (isSensitiveKey(key)) {
    return '[redacted]';
  }
  const errorKey = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  if (['error_message', 'error_description', 'stack'].includes(errorKey)) return '[redacted]';
  if (['error', 'err', 'cause'].includes(errorKey)) return errorFields(value);
  if (value instanceof Error) {
    return errorFields(value);
  }
  return redactValue(value, logTranscripts, depth);
}

function redact(fields: Record<string, unknown>, logTranscripts: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = redactEntry(key, value, logTranscripts, 0);
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
      // S1011-008：bindings 同样过脱敏（此前绕过）
      const payload: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level: lvl,
        event,
        ...redact(bindings, logTranscripts),
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

const ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError',
  'ProviderError', 'CoreBridgeError', 'AudioFetchError', 'FieldDecryptionError', 'OAuthStateError'
]);
const ERROR_CODES = new Set([
  'asr_failed', 'tts_failed', 'provider_unavailable', 'invalid_audio', 'invalid_input',
  'provider_timeout', 'unsupported_format',
  'core_http_error', 'core_stream_error', 'core_timeout', 'core_unreachable',
  'blocked_url', 'too_large', 'download_failed', 'data_unreadable', 'oauth_storage_unavailable',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EACCES', 'ENOSPC', 'EIO'
]);

/** 错误只记录受控分类；上游 message/stack/cause 可能含正文和凭据，永不默认输出。
 * LOG_TRANSCRIPTS 仅允许显式文本字段，不授权输出错误字符串中的秘密。 */
export function errorFields(error: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    error_name: error instanceof Error && ERROR_NAMES.has(error.name) ? error.name : 'Error'
  };
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && ERROR_CODES.has(error.code)) {
    fields.error_code = error.code;
  }
  return fields;
}
