/**
 * 一次讲话（utterance）的 ASR 采集与结果采纳（规范第 22/23/40 节）。
 * - createAsrSession：每次讲话新建 prebuffered ASR 会话（建连期间缓冲，不丢句首）
 * - adoptTranscript：final 优先；grace 到期不再采纳 partial（B02：句号不是结束凭据，
 *   一律等 end() 的最终稿）；真正失败返回 kind:'error'，端到端期限兜底 timeout。
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
  | { kind: 'timeout' }
  | { kind: 'error'; error: unknown };

/**
 * 端到端 ASR 完成期限（S1011-014）：必须 ≥ Provider 终包窗口（volc 5s）+ 余量。
 * 此前 450ms 宽限 + 3000ms 二段等待 < 5000ms，会在 Provider 仍在等 final 时
 * 提前宣判空文本。
 */
const ADOPTION_END_TO_END_MS = 5500;

/** 采纳识别结果：end() 与 grace 计时赛跑；失败显式上抛 */
export async function adoptTranscript(
  session: PrebufferedAsrSession,
  options: {
    graceMs: number;
    /** grace 到期后继续等 end() 落定的上限——默认为端到端期限（S1011-014） */
    endWaitMs?: number;
  }
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
  // B02（2026-10-26）边界：grace 到期一律等 end() 的最终稿，不采纳 partial——
  // 有句号的 partial 也不冒充完整原话；端到端期限兜底（供应商真失败走可见
  // error/timeout，不伪装完整听取）。话轮结束由 end/续说/打断路径判定。
  const settled = await Promise.race([
    endPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), options.endWaitMs ?? ADOPTION_END_TO_END_MS))
  ]);
  // S1011-014：端到端超时是独立结果（typed），不再伪装成"成功但空文本"——
  // 只有 Provider 明确给出的空 final 才走 empty（由调用方提示"没听清"）
  if (settled === null) return { kind: 'timeout' };
  if (settled.kind === 'error') return { kind: 'error', error: settled.error };
  return { kind: 'final', text: settled.result.text.trim() };
}
