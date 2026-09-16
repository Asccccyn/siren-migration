import { describe, expect, it } from 'vitest';
import { CallStateMachine, InvalidTransitionError } from '@siren/voice-core';

describe('CallStateMachine', () => {
  it('合法主链路', () => {
    const machine = new CallStateMachine();
    machine.transition('listening');
    machine.transition('ending');
    machine.transition('thinking');
    machine.transition('speaking');
    machine.transition('listening');
    expect(machine.state).toBe('listening');
  });

  it('打断链路 SPEAKING -> INTERRUPTING -> LISTENING', () => {
    const machine = new CallStateMachine();
    machine.transition('listening');
    machine.transition('ending');
    machine.transition('thinking');
    machine.transition('speaking');
    machine.transition('interrupting');
    machine.transition('listening');
    expect(machine.state).toBe('listening');
  });

  it('非法迁移抛错', () => {
    const machine = new CallStateMachine();
    expect(() => machine.transition('speaking')).toThrow(InvalidTransitionError);
    machine.transition('listening');
    expect(() => machine.transition('thinking')).toThrow(InvalidTransitionError); // 必须先 ending
  });

  it('thinking 可直接回 listening（空回复）', () => {
    const machine = new CallStateMachine();
    machine.transition('listening');
    machine.transition('ending');
    machine.transition('thinking');
    machine.transition('listening');
    expect(machine.state).toBe('listening');
  });

  it('ended 是终态；forceEnded 可从任意状态进入', () => {
    const machine = new CallStateMachine();
    machine.transition('listening');
    machine.forceEnded();
    expect(machine.state).toBe('ended');
    expect(() => machine.transition('listening')).toThrow(InvalidTransitionError);
  });

  it('迁移回调记录轨迹', () => {
    const trace: string[] = [];
    const machine = new CallStateMachine((from, to) => trace.push(`${from}->${to}`));
    machine.transition('listening');
    machine.transition('ending');
    expect(trace).toEqual(['idle->listening', 'listening->ending']);
  });
});
