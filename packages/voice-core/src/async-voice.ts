/**
 * 异步语音链路编排（规范第 10/11 节）。
 * 两条流水线都委托 VoiceService —— Siren 不决定对方怎么回答，
 * Core 的回复由 Agent 通过 Voice MCP / REST 调用 speak() 落成语音条。
 */
import type { TranscriptResult, VoiceAssetWithUrl } from '@siren/contracts';
import type { VoiceService } from './voice-service.ts';

export interface UserVoiceInput {
  audio: Buffer;
  format: string;
  language?: string;
  conversationId?: string;
  messageId?: string;
  voiceProfileId?: string;
  /** 是否把用户原始录音与 transcript 入库为 user 方向资产 */
  store?: boolean;
}

export interface UserVoiceOutput {
  transcript: TranscriptResult;
  asset?: VoiceAssetWithUrl;
}

export class AsyncVoicePipeline {
  constructor(private readonly voice: VoiceService) {}

  /** 用户语音消息：录音 -> Batch ASR -> transcript（-> 可选入库） */
  async handleUserVoice(input: UserVoiceInput): Promise<UserVoiceOutput> {
    if (input.store) {
      const { transcript, asset } = await this.voice.storeUserVoice(input);
      return { transcript, asset };
    }
    const transcript = await this.voice.transcribe({
      audio: input.audio,
      format: input.format,
      language: input.language
    });
    return { transcript };
  }

  /** 对方回复语音化：text / tts_script 分离，绑定 message_id（幂等） */
  async buildAssistantVoice(input: {
    text: string;
    ttsScript?: string;
    conversationId?: string;
    messageId?: string;
    voiceProfileId?: string;
    emotion?: Parameters<VoiceService['speak']>[0]['emotion'];
    speed?: number;
    language?: string;
  }): Promise<VoiceAssetWithUrl> {
    return this.voice.speak(input);
  }
}
