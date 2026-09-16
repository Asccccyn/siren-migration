/**
 * Call 状态机（规范第 19 节）。
 * 禁止用松散 boolean 替代；所有状态迁移必须走这里。
 */
import type { CallState } from '@siren/contracts';

const TRANSITIONS: Record<CallState, readonly CallState[]> = {
  idle: ['listening', 'ended', 'error'],
  listening: ['ending', 'ended', 'error'],
  ending: ['thinking', 'listening', 'ended', 'error'],
  thinking: ['speaking', 'listening', 'ended', 'error'],
  speaking: ['interrupting', 'listening', 'ended', 'error'],
  interrupting: ['listening', 'ended', 'error'],
  ended: [],
  error: ['ended']
};

export class InvalidTransitionError extends Error {
  constructor(from: CallState, to: CallState) {
    super(`illegal call state transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class CallStateMachine {
  private current: CallState = 'idle';

  constructor(private readonly onTransition?: (from: CallState, to: CallState, at: number) => void) {}

  get state(): CallState {
    return this.current;
  }

  is(...states: CallState[]): boolean {
    return states.includes(this.current);
  }

  can(next: CallState): boolean {
    return TRANSITIONS[this.current].includes(next);
  }

  transition(next: CallState, at: number = Date.now()): void {
    if (!this.can(next)) {
      throw new InvalidTransitionError(this.current, next);
    }
    const from = this.current;
    this.current = next;
    this.onTransition?.(from, next, at);
  }

  /** 内部通道断开等终态清理：允许从任意状态进入 ended */
  forceEnded(at: number = Date.now()): void {
    const from = this.current;
    if (from === 'ended') return;
    this.current = 'ended';
    this.onTransition?.(from, 'ended', at);
  }
}

export { TRANSITIONS as CALL_TRANSITIONS };
