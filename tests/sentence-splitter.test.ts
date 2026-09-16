import { describe, expect, it } from 'vitest';
import { SentenceSplitter } from '@siren/voice-core';

describe('SentenceSplitter', () => {
  it('遇句末标点立即切句', () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push('我觉得你今天可以先休息一下。')).toEqual(['我觉得你今天可以先休息一下。']);
    expect(splitter.push('剩下的事情明天再说')).toEqual([]);
    expect(splitter.push('！')).toEqual(['剩下的事情明天再说！']);
  });

  it('支持多种句末标点与连续标点', () => {
    const splitter = new SentenceSplitter();
    const out = splitter.push('真的吗？太好了……走吧！');
    expect(out).toEqual(['真的吗？', '太好了……', '走吧！']);
  });

  it('无标点超长时按软停顿/硬截断兜底', () => {
    const splitter = new SentenceSplitter({ maxChars: 20 });
    const out = splitter.push('我们今天聊一聊关于明天的安排以及后面的计划细节问题');
    expect(out.length).toBeGreaterThanOrEqual(1);
    for (const sentence of out) {
      expect(sentence.length).toBeLessThanOrEqual(20);
    }
    // 内容无损（push + flush）
    expect([...out, splitter.flush()].filter(Boolean).join('')).toBe(
      '我们今天聊一聊关于明天的安排以及后面的计划细节问题'
    );
  });

  it('flush 取出剩余内容且只取一次', () => {
    const splitter = new SentenceSplitter();
    splitter.push('还没结束的半句');
    expect(splitter.flush()).toBe('还没结束的半句');
    expect(splitter.flush()).toBe('');
  });

  it('流式输入逐 delta 累积切句', () => {
    const splitter = new SentenceSplitter();
    const collected: string[] = [];
    for (const ch of '好的。那我先走了？') {
      collected.push(...splitter.push(ch));
    }
    collected.push(splitter.flush());
    expect(collected.filter(Boolean)).toEqual(['好的。', '那我先走了？']);
  });
});
