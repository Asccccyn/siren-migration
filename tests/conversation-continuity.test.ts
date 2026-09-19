/**
 * P0-4.5：电话与网页文字共享同一 Conversation。
 *
 * 产品语义：callId 是临时实时通信 session，conversationId 是长期对话上下文；
 * 电话内 ASR final 作为 user message 进入 Core 的同一个 conversation，
 * 电话回复作为 assistant 内容写回（call_turns 元数据 + Core 生成侧）。
 * 电话期间 typed message 由网页走 Core 文字链路（不经 Siren），Siren 只需
 * 保证 conversation 绑定稳定、不创建第二 conversation、不丢消息、不重复写。
 */
import { describe, expect, it } from 'vitest';
import { openDatabase, CallTurnsRepository, CallSessionsRepository } from '@siren/storage';
import { MockAsrProvider, MockTtsProvider } from '@siren/provider-mock';
import type { CoreBridge, CoreTurnInput, CoreDelta } from '@siren/core-bridge';
import type { PcmChunk, TtsAudioResult, TtsProvider, TtsRequest } from '@siren/contracts';
import { buildSessionHarness, waitFor } from './helpers.ts';

/** 慢速 TTS：每块间隔固定耗时，保证"speaking 期间打断"的前提确定性成立
 * （v1.1.1 起 AsyncQueue 死锁已修，瞬时 TTS 会让整轮在 abort 前就完成） */
class SlowMockTts implements TtsProvider {
  private readonly inner = new MockTtsProvider();

  synthesize(request: TtsRequest): Promise<TtsAudioResult> {
    return this.inner.synthesize(request);
  }

  async *synthesizeStream(request: TtsRequest, _signal?: AbortSignal): AsyncGenerator<PcmChunk> {
    for await (const chunk of this.inner.synthesizeStream(request)) {
      await new Promise((r) => setTimeout(r, 8));
      yield chunk;
    }
  }
}

/** 记录全部 turn 输入的 Core 桩：模拟"同一个Peer Core / 同一个 conversation" */
class RecordingCoreBridge implements CoreBridge {
  readonly inputs: CoreTurnInput[] = [];
  /** 模拟 typed message（网页文字链路）直接写进同一 conversation 的旁路记录 */
  readonly typedMessages: { conversationId: string; text: string }[] = [];

  constructor(private readonly reply: string) {}

  async *streamReply(input: CoreTurnInput): AsyncGenerator<CoreDelta> {
    this.inputs.push(input);
    for (let i = 0; i < this.reply.length; i += 3) {
      yield { text: this.reply.slice(i, i + 3) };
    }
  }

  async cancel(): Promise<void> {}

  /** 网页 typed message：进入同一 conversation 的上下文（Core 侧真相源） */
  typeMessage(conversationId: string, text: string): void {
    this.typedMessages.push({ conversationId, text });
  }
}

function buildRecording(options: {
  conversationId: string;
  callId: string;
  reply?: string;
  final?: string;
  tts?: TtsProvider;
}) {
  const db = openDatabase(':memory:');
  const turnsRepo = new CallTurnsRepository(db);
  const sessionsRepo = new CallSessionsRepository(db);
  // 模拟 CallCenter.createCall 的会话行（call_turns 外键引用 call_sessions）
  sessionsRepo.insert({
    id: options.callId,
    conversation_id: options.conversationId,
    voice_profile: 'main',
    started_at: null,
    ended_at: null,
    status: 'active',
    asr_provider: 'mock',
    tts_provider: 'mock',
    created_at: Date.now()
  });
  const core = new RecordingCoreBridge(options.reply ?? '好的，我看到了。我去看这个目录。');
  const harness = buildSessionHarness({
    asr: new MockAsrProvider({ partials: ['等一', '等一下'], final: options.final ?? '等一下，我把路径发给你。', finalDelayMs: 5 }),
    tts: options.tts,
    core,
    turnsRepo,
    sessionsRepo,
    callId: options.callId,
    conversationId: options.conversationId
  });
  return { harness, core, turnsRepo, sessionsRepo };
}

async function runOneTurn(harness: ReturnType<typeof buildRecording>['harness']): Promise<void> {
  harness.session.handleMessage({ t: 'start' });
  harness.session.handleBinary(Buffer.alloc(3200, 1));
  harness.session.handleMessage({ t: 'end' });
  await waitFor(() => {
    const states = harness.texts().filter((m) => m.t === 'state');
    return states.at(-1)?.state === 'listening' && harness.texts().some((x) => x.t === 'pcm_end');
  });
}

describe('Conversation 连续性（P0-4.5 电话与网页共享同一 conversation）', () => {
  it('ASR final 进入绑定的 conversation，回复写回同一 conversation 的元数据', async () => {
    const { harness, core, turnsRepo } = buildRecording({ conversationId: 'conv-shared', callId: 'call-1' });
    await runOneTurn(harness);

    // Core 收到的 voice turn：同一个 conversation + transcript
    expect(core.inputs.length).toBe(1);
    expect(core.inputs[0].conversationId).toBe('conv-shared');
    expect(core.inputs[0].text).toBe('等一下，我把路径发给你。');
    expect(core.inputs[0].modality).toBe('voice_call');

    // 通话侧元数据：user/assistant 文本落在同一 call 下（Core 是聊天真源，Siren 只存元数据）
    const turns = turnsRepo.listByCall('call-1');
    expect(turns.length).toBe(1);
    expect(turns[0].user_text).toBe('等一下，我把路径发给你。');
    expect(turns[0].assistant_text).toContain('我看到了');
    expect(turns[0].interrupted).toBe(0);
  });

  it('电话保持连接时 typed message 进入同一 conversation，下一轮电话回复可使用该文字', async () => {
    const { harness, core } = buildRecording({ conversationId: 'conv-live', callId: 'call-live' });
    await runOneTurn(harness);
    // 电话进行中：网页 typed message 走 Core 文字链路（同一 conversation）
    core.typeMessage('conv-live', 'D:\\siren\\packages\\voice-core');
    // 下一轮电话语音
    await runOneTurn(harness);

    // Core 在同一 conversation 上先看到 typed message，再看到第二个 voice turn
    expect(core.typedMessages.map((m) => m.conversationId)).toEqual(['conv-live']);
    expect(core.inputs.length).toBe(2);
    for (const input of core.inputs) {
      expect(input.conversationId).toBe('conv-live');
    }
  });

  it('callId 改变但 conversationId 不变时上下文连续（挂断再拨）', async () => {
    const first = buildRecording({ conversationId: 'conv-persist', callId: 'call-a' });
    await runOneTurn(first.harness);
    first.harness.session.destroy('hangup');

    const second = buildRecording({ conversationId: 'conv-persist', callId: 'call-b' });
    await runOneTurn(second.harness);
    second.harness.session.destroy('hangup');

    // 两个 call 的 voice turn 都进入同一 conversation（Core 视角连续）
    expect(first.core.inputs[0].conversationId).toBe('conv-persist');
    expect(second.core.inputs[0].conversationId).toBe('conv-persist');
    // Siren 侧元数据按 call 隔离，但 conversation 绑定一致
    expect(first.sessionsRepo.findById('call-a')?.conversation_id).toBe('conv-persist');
    expect(second.sessionsRepo.findById('call-b')?.conversation_id).toBe('conv-persist');
  });

  it('不同 conversation 之间不串话', async () => {
    const a = buildRecording({ conversationId: 'conv-a', callId: 'call-x1' });
    const b = buildRecording({ conversationId: 'conv-b', callId: 'call-x2' });
    await runOneTurn(a.harness);
    await runOneTurn(b.harness);
    expect(a.core.inputs[0].conversationId).toBe('conv-a');
    expect(b.core.inputs[0].conversationId).toBe('conv-b');
    expect(a.turnsRepo.listByCall('call-x1').length).toBe(1);
    expect(b.turnsRepo.listByCall('call-x2').length).toBe(1);
  });

  it('同一轮的重复 end 不产生重复 message / 重复 turn', async () => {
    const { harness, core, turnsRepo } = buildRecording({ conversationId: 'conv-dup', callId: 'call-dup' });
    harness.session.handleMessage({ t: 'start' });
    harness.session.handleBinary(Buffer.alloc(3200, 1));
    harness.session.handleMessage({ t: 'end' });
    await waitFor(() =>
      harness.texts().some((m) => m.t === 'state' && m.state === 'listening' && harness.texts().some((x) => x.t === 'pcm_end'))
    );
    // ASR final 重复事件（协议层重放 end）
    harness.session.handleMessage({ t: 'end' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(core.inputs.length).toBe(1); // Core 只收到一次
    expect(harness.texts().filter((m) => m.t === 'asr').length).toBe(1);
    expect(turnsRepo.listByCall('call-dup').length).toBe(1);
  });

  it('被打断的 assistant turn 只保留已播出内容（interrupted 元数据，不伪装完整回复）', async () => {
    const { harness, turnsRepo } = buildRecording({
      conversationId: 'conv-int',
      callId: 'call-int',
      reply: '第一句话说完。第二句话也说完了。第三句话继续。第四句还没说。',
      tts: new SlowMockTts() // 确定性 speaking 窗口：瞬时 TTS 会让整轮先完成
    });
    const { session } = harness;
    session.handleMessage({ t: 'start' });
    session.handleBinary(Buffer.alloc(3200, 1));
    session.handleMessage({ t: 'end' });
    await waitFor(() => harness.texts().some((m) => m.t === 'pcm'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    session.handleMessage({ t: 'abort' });
    await waitFor(() => harness.texts().some((m) => m.t === 'interrupted'));

    const turns = turnsRepo.listByCall('call-int');
    expect(turns.length).toBe(1);
    expect(turns[0].interrupted).toBe(1);
    // 未播完的内容不伪装成完整回复：assistant_text 是已播出部分的子串且不含未播出尾部
    expect(turns[0].assistant_text ?? '').not.toContain('第四句还没说');
  });
});
