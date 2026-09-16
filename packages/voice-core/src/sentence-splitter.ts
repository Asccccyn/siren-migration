/**
 * 流式句子切分器（规范第 25 节）。
 * 遇到稳定句末（。！？…；换行）立即切句；超长无标点时按软停顿/硬截断兜底。
 */
const TERMINATORS = new Set(['。', '！', '？', '；', '…', '!', '?', ';', '\n']);
const SOFT_BREAKS = new Set(['，', ',', '、', '：', ':', ' ', '）', ')', '”', '"', '」', '》']);

export interface SentenceSplitterOptions {
  /** 无句末标点时的最大缓冲长度（字符） */
  maxChars?: number;
}

export class SentenceSplitter {
  private buffer = '';
  private readonly maxChars: number;

  constructor(options: SentenceSplitterOptions = {}) {
    this.maxChars = options.maxChars ?? 60;
  }

  push(delta: string): string[] {
    if (!delta) return [];
    this.buffer += delta;
    return this.drain();
  }

  /** 流结束时取出剩余内容 */
  flush(): string {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest;
  }

  private drain(): string[] {
    const out: string[] = [];
    // 1) 句末切分
    while (true) {
      let cutIndex = -1;
      let cutLength = 0;
      for (let i = 0; i < this.buffer.length; i++) {
        if (TERMINATORS.has(this.buffer[i])) {
          cutIndex = i;
          cutLength = 1;
          // 连续同类终止符（如 "……"、"！！"）合并
          while (
            cutIndex + cutLength < this.buffer.length &&
            this.buffer[cutIndex + cutLength] === this.buffer[cutIndex]
          ) {
            cutLength++;
          }
          break;
        }
      }
      if (cutIndex < 0) break;
      const sentence = this.buffer.slice(0, cutIndex + cutLength).trim();
      this.buffer = this.buffer.slice(cutIndex + cutLength);
      if (sentence) out.push(sentence);
    }
    // 2) 超长兜底：优先软停顿，其次硬截断
    while (this.buffer.length > this.maxChars) {
      const window = this.buffer.slice(0, this.maxChars);
      let cutAt = -1;
      for (let i = window.length - 1; i >= Math.floor(this.maxChars / 2); i--) {
        if (SOFT_BREAKS.has(window[i])) {
          cutAt = i;
          break;
        }
      }
      if (cutAt < 0) cutAt = this.maxChars - 1;
      const sentence = this.buffer.slice(0, cutAt + 1).trim();
      this.buffer = this.buffer.slice(cutAt + 1);
      if (sentence) out.push(sentence);
    }
    return out;
  }
}

/** 把 delta 流转换成句子流的辅助函数 */
export async function* streamSentences(
  deltas: AsyncIterable<string>,
  splitter: SentenceSplitter
): AsyncGenerator<string> {
  for await (const delta of deltas) {
    for (const sentence of splitter.push(delta)) {
      yield sentence;
    }
  }
  const rest = splitter.flush();
  if (rest) yield rest;
}
