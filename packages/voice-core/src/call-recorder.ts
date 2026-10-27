import { randomUUID } from 'node:crypto';
import { buildWav } from '@siren/audio';
import type { VoiceProfile, VoiceDirection } from '@siren/contracts';
import type { CallTurnsRepository, VoiceAssetsRepository } from '@siren/storage';
import { errorFields, type Logger } from '@siren/telemetry';
import type { ActiveTurn } from './reply-pipeline.ts';

export type TurnOutcome = 'completed' | 'interrupted' | 'asr_failed' | 'asr_timeout' | 'core_failed' | 'tts_failed' | 'asr_empty';
type AudioArchive = {
  callId: string; conversationId: string | null; profile: VoiceProfile;
  assetsRepo: VoiceAssetsRepository;
  store: { put(key: string, bytes: Buffer, contentType: string): Promise<unknown>; delete?(key: string): Promise<void> };
};

/** 通话文字、音频和客户端播放证据各有独立事实；引用只在资产实际写入后交付。 */
export class CallTurnRecorder {
  constructor(
    private readonly turnsRepo: CallTurnsRepository | undefined,
    private readonly logger: Logger,
    private readonly audio?: AudioArchive,
  ) {}

  write(callId: string, turn: ActiveTurn, outcome: TurnOutcome): void {
    if (!this.turnsRepo || turn.written) return;
    const metrics = turn.metrics.toDbColumns();
    try {
      this.turnsRepo.insert({
        id: turn.turnId, call_id: callId, turn_index: turn.index,
        user_text: outcome === 'asr_failed' || outcome === 'asr_empty' ? null : turn.userText,
        assistant_text: outcome === 'asr_failed' || outcome === 'asr_empty' ? null : turn.fullText,
        started_at: turn.startedAt, ended_at: Date.now(), interrupted: outcome === 'interrupted' ? 1 : 0,
        asr_latency_ms: metrics.asr_latency_ms, llm_first_token_ms: metrics.llm_first_token_ms,
        tts_first_audio_ms: metrics.tts_first_audio_ms, first_audio_ms: metrics.first_audio_ms,
        first_content_audio_ms: metrics.first_content_audio_ms, outcome, created_at: Date.now(),
        output_stream_id: turn.outputStreamId, sent_audio_ms: turn.sentAudioMs,
        filler_audio_ms: turn.fillerAudioMs, playback_json: JSON.stringify(turn.playback),
      });
      turn.written = true;
    } catch (error) { this.logger.warn('call_turn_write_failed', errorFields(error)); }
  }

  archiveUser(turn: ActiveTurn, sampleRate: number): Promise<string | null> {
    return this.saveAudio(turn, 'user', turn.pcmChunks, sampleRate, null, turn.transcriptAdopted ? turn.userText : null);
  }

  archiveReply(turn: ActiveTurn): Promise<string | null> {
    const chunks = turn.replyAudio.flatMap(segment => segment.chunks);
    if (chunks.length === 0) return Promise.resolve(null);
    const completeSegments = turn.replyAudio.every(segment => segment.complete && segment.chunks.length > 0);
    return this.saveAudio(turn, 'assistant', chunks.map(chunk => chunk.audio), chunks[0]!.sampleRate,
      turn.receivedText || null,
      completeSegments ? turn.replyAudio.map(segment => segment.text).join('') : null,
      turn.replyTextComplete && completeSegments ? 'complete' : 'partial');
  }

  private async saveAudio(turn: ActiveTurn, direction: VoiceDirection, chunks: Buffer[], sampleRate: number, text: string | null, transcript: string | null, completeness?: 'complete' | 'partial'): Promise<string | null> {
    const audio = this.audio;
    if (!audio || chunks.length === 0) return null;
    const messageId = 'call-' + audio.callId + '-t' + turn.index + (direction === 'user' ? '-u' : '-r');
    const previous = audio.assetsRepo.findByMessageId(messageId);
    if (previous) return previous.id;
    const assetId = randomUUID();
    const objectKey = 'voice/calls/' + audio.callId + '/' + messageId + '/' + assetId + (direction === 'user' ? '/audio.wav' : '/reply.wav');
    const wav = buildWav(Buffer.concat(chunks), sampleRate);
    try {
      await audio.store.put(objectKey, wav, 'audio/wav');
      const result = audio.assetsRepo.insert({
        id: assetId, conversationId: audio.conversationId, messageId,
        callId: audio.callId, turnId: turn.turnId, direction,
        voiceProfile: audio.profile.id, provider: 'call', providerVoiceId: null,
        audioFormat: 'wav', sampleRate, durationMs: Math.round((wav.length - 44) / 2 / sampleRate * 1000),
        language: audio.profile.language, emotion: null, text, ttsScript: null, transcript,
        objectKey, checksum: null, completeness, createdAt: Date.now(),
      });
      if (!result.inserted) {
        await audio.store.delete?.(objectKey).catch(error => this.logger.warn('duplicate_call_audio_cleanup_failed', errorFields(error)));
        return result.existing.id;
      }
      this.logger.info(direction === 'assistant' ? 'reply_audio_archived' : 'user_audio_archived', { turn_id: turn.turnId, asset_id: assetId, completeness });
      return assetId;
    } catch (error) {
      this.logger.warn(direction === 'assistant' ? 'reply_audio_archive_failed' : 'user_audio_asset_failed', { ...errorFields(error), turn_index: turn.index });
      return null;
    }
  }
}
