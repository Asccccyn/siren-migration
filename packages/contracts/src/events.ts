/**
 * Siren 结构化事件名与延迟采集点（规范第 38/39 节）。
 */

export const LATENCY_MARKS = [
  'speech_end',
  'asr_final',
  'llm_first_token',
  'first_sentence_ready',
  'tts_first_chunk',
  'audio_play_request',
  'turn_end'
] as const;

export type LatencyMark = (typeof LATENCY_MARKS)[number];

export type SirenEventName =
  | 'server_started'
  | 'server_stopped'
  | 'config_warning'
  | 'tmp_cleaned'
  | 'voice_asset_created'
  | 'voice_asset_idempotent_hit'
  | 'user_voice_stored'
  | 'asr_batch_completed'
  | 'tts_batch_completed'
  | 'call_created'
  | 'call_started'
  | 'call_ended'
  | 'turn_started'
  | 'turn_completed'
  | 'turn_interrupted'
  | 'turn_failed'
  | 'llm_first_token'
  | 'tts_first_audio'
  | 'asr_partial'
  | 'asr_final'
  | 'filler_played'
  | 'tts_stream_fallback_batch'
  | 'core_bridge_error'
  | 'mcp_tool_called'
  | 'ws_client_connected'
  | 'ws_client_closed'
  | 'ws_backpressure_overflow'
  | 'object_store_put'
  | 'object_store_get';
