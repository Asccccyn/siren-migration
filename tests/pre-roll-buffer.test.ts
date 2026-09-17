/** P0-1：客户端 pre-roll ring buffer 行为 */
import { describe, expect, it } from 'vitest';
import { AudioPreRollBuffer } from '../apps/playground/src/pre-roll-buffer.ts';

const BLOCK = 160; // 10ms @16k

describe('AudioPreRollBuffer（P0-1 客户端首音保护）', () => {
  it('buffer 未满时 drain 顺序正确且 drain 后为空', () => {
    const buffer = new AudioPreRollBuffer(6400);
    buffer.push(fill(1, BLOCK));
    buffer.push(fill(2, BLOCK));
    const drained = buffer.drain();
    expect(drained.length).toBe(BLOCK * 2);
    expect(drained[0]).toBe(1);
    expect(drained[BLOCK - 1]).toBe(1);
    expect(drained[BLOCK]).toBe(2);
    expect(buffer.length).toBe(0);
    expect(buffer.drain().length).toBe(0);
  });

  it('buffer 超容量后只保留最新数据（环形覆盖最旧）', () => {
    const capacity = 6400;
    const buffer = new AudioPreRollBuffer(capacity);
    // 写入 60 块（600ms），超过 400ms 容量
    for (let block = 1; block <= 60; block++) {
      buffer.push(fill(block, BLOCK));
    }
    expect(buffer.length).toBe(capacity);
    const drained = buffer.drain();
    expect(drained.length).toBe(capacity);
    // 最旧保留的是第 (60 - 40 + 1) 块（1-based：21..60 共 40 块）
    expect(drained[0]).toBe(60 - capacity / BLOCK + 1);
    expect(drained[drained.length - 1]).toBe(60);
  });

  it('单块大于容量时只留块尾', () => {
    const buffer = new AudioPreRollBuffer(100);
    buffer.push(fill(7, 300));
    expect(buffer.length).toBe(100);
    const drained = buffer.drain();
    expect(drained.length).toBe(100);
    expect(drained[0]).toBe(7);
  });

  it('drain 后重新写入从头开始（无旧数据残留）', () => {
    const buffer = new AudioPreRollBuffer(320);
    buffer.push(fill(1, 320));
    buffer.drain();
    buffer.push(fill(9, 160));
    const drained = buffer.drain();
    expect(drained.length).toBe(160);
    expect(drained.every((v) => v === 9)).toBe(true);
  });

  it('clear 清空全部状态', () => {
    const buffer = new AudioPreRollBuffer(320);
    buffer.push(fill(1, 320));
    buffer.clear();
    expect(buffer.length).toBe(0);
    expect(buffer.drain().length).toBe(0);
  });
});

function fill(value: number, count: number): Float32Array {
  const out = new Float32Array(count);
  out.fill(value);
  return out;
}
