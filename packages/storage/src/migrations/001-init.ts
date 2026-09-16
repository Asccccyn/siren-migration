/**
 * 初始表结构（规范第 29 节：voice_assets / call_sessions / call_turns）。
 */
export const MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS voice_assets (
  id                 TEXT PRIMARY KEY,
  conversation_id    TEXT,
  message_id         TEXT,
  direction          TEXT NOT NULL CHECK (direction IN ('user', 'assistant')),
  voice_profile      TEXT NOT NULL,
  provider           TEXT NOT NULL,
  provider_voice_id  TEXT,
  audio_format       TEXT NOT NULL,
  sample_rate        INTEGER NOT NULL,
  duration_ms        INTEGER NOT NULL,
  language           TEXT,
  emotion            TEXT,
  text               TEXT,
  tts_script         TEXT,
  transcript         TEXT,
  object_key         TEXT NOT NULL,
  checksum           TEXT,
  created_at         INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_assets_message_id
  ON voice_assets (message_id) WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_voice_assets_conversation_time
  ON voice_assets (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS call_sessions (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT,
  voice_profile   TEXT NOT NULL,
  started_at      INTEGER,
  ended_at        INTEGER,
  status          TEXT NOT NULL CHECK (status IN ('active', 'ended', 'error')),
  asr_provider    TEXT,
  tts_provider    TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS call_turns (
  id                 TEXT PRIMARY KEY,
  call_id            TEXT NOT NULL REFERENCES call_sessions (id),
  turn_index         INTEGER NOT NULL,
  user_text          TEXT,
  assistant_text     TEXT,
  started_at         INTEGER,
  ended_at           INTEGER,
  interrupted        INTEGER NOT NULL DEFAULT 0,
  asr_latency_ms     INTEGER,
  llm_first_token_ms INTEGER,
  tts_first_audio_ms INTEGER,
  created_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_call_turns_call ON call_turns (call_id, turn_index);
`;
