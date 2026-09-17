/**
 * 一次讲话（utterance）的 ASR 采集与结果采纳（规范第 22/23/40 节）。
 * - createAsrSession：每次讲话新建 prebuffered ASR 会话（建连期间缓冲，不丢句首）
 * - adoptTranscript：final 优先；PARTIAL_GRACE_MS 内未返回采用最新 partial；
 *   真正失败返回 kind:'error'，禁止把失败当成空文本。
 */
import type { StreamAsrProvider, VoiceProfile } from '@siren/contracts';
import type { PrebufferedAsrSession } from './asr-prebuffer.ts';
import { PrebufferedAsrSession as Prebuffered } from './asr-prebuffer.ts';

export interface AsrIntakeDeps {
  /** 只需流式能力（RealtimeVoiceProvider 即可满足） */
  asr: StreamAsrProvider;
  profile: VoiceProfile;
  prebufferMaxBytes: number;
}

/** 新建（并立即建连）一次讲话的 ASR 会话 */
export function createAsrSession(
  deps: AsrIntakeDeps,
  onPartial: (text: string) => void,
  onError: (error: unknown) => void
): PrebufferedAsrSession {
  return new Prebuffered(
    deps.asr,
    { language: deps.profile.language, profile: deps.profile },
    { onPartial, onError },
    deps.prebufferMaxBytes
  );
}

export type TranscriptAdoption =
  | { kind: 'final'; text: string }
  | { kind: 'grace'; text: string }
  | { kind: 'error'; error: unknown };

/** 采纳识别结果：end() 与 grace 计时赛跑；失败显式上抛 */
export async function adoptTranscript(
  session: PrebufferedAsrSession,
  options: { graceMs: number; lastPartialText: string }
): Promise<TranscriptAdoption> {
  const endPromise = session.end().then(
    (result) => ({ kind: 'final' as const, result }),
    (error) => ({ kind: 'error' as const, error })
  );
  const gracePromise = new Promise<{ kind: 'grace' }>((resolve) => {
    setTimeout(() => resolve({ kind: 'grace' }), options.graceMs);
  });
  const outcome = await Promise.race([endPromise, gracePromise]);
  if (outcome.kind === 'error') return { kind: 'error', error: outcome.error };
  if (outcome.kind === 'final') return { kind: 'final', text: outcome.result.text.trim() };
  return { kind: 'grace', text: options.lastPartialText.trim() };
}
