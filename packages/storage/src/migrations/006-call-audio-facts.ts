// 关联与播放事实只记录真实新数据；旧记录的 NULL 保持未知，不回填历史。
export const CALL_AUDIO_FACTS_SQL = `
ALTER TABLE voice_assets ADD COLUMN call_id TEXT;
ALTER TABLE voice_assets ADD COLUMN turn_id TEXT;
CREATE INDEX idx_voice_assets_call_turn ON voice_assets(call_id, turn_id, direction);
ALTER TABLE call_turns ADD COLUMN output_stream_id TEXT;
ALTER TABLE call_turns ADD COLUMN sent_audio_ms REAL;
ALTER TABLE call_turns ADD COLUMN filler_audio_ms REAL;
ALTER TABLE call_turns ADD COLUMN playback_json TEXT;
`;
