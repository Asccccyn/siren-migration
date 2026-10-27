// D-01（她裁定 2026-10-26"听完我的话再回复"）验证：grace 到期的 partial 只有
// 句子明显完整（句终标点收尾）才早采纳；半句话继续等最终稿；最终稿/超时语义不变。
import { describe, expect, it } from 'vitest';
import { adoptTranscript } from '../packages/voice-core/src/utterance-intake.ts';

type AsrSession = Parameters<typeof adoptTranscript>[0];
function fakeSession(final: { kind: 'final'; text: string } | { kind: 'hang' }, finalDelayMs: number): AsrSession {
  return {
    end: () => new Promise((resolve, reject) => {
      setTimeout(() => { if (final.kind === 'final') resolve({ text: final.text }); else reject(new Error('hang')); }, finalDelayMs);
    })
  } as unknown as AsrSession;
}

describe('D-01（执行包修正版）partial 不冒充完整原话', () => {
  it('grace 到期的半句 partial 不被采纳——等到完整最终稿', async () => {
    const out = await adoptTranscript(fakeSession({ kind: 'final', text: '我今天想说这件事。' }, 300), {
      graceMs: 50, getLatestPartial: () => '我今天想'
    });
    expect(out).toEqual({ kind: 'final', text: '我今天想说这件事。' });
  });
  it('B02：带句号的 partial 也不早采纳——不冒充完整原话，等 final', async () => {
    const out = await adoptTranscript(fakeSession({ kind: 'final', text: '就这样，先这样吧。回头说。' }, 300), {
      graceMs: 50, getLatestPartial: () => '就这样，先这样吧。'
    });
    expect(out).toEqual({ kind: 'final', text: '就这样，先这样吧。回头说。' });
  });
  it('partial 任意形态且最终稿始终不来——端到端期限兜底 timeout（不吞失败）', async () => {
    const out = await adoptTranscript(fakeSession({ kind: 'hang' }, 60_000), {
      graceMs: 50, getLatestPartial: () => '我说到一半。', endWaitMs: 120
    });
    expect(out).toEqual({ kind: 'timeout' });
  });
});
