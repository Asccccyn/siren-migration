/** Owns negotiated input identity, ACK buffering and local output invalidation. */
export interface VoiceTurnCoordinatorDeps {
  sendJson(message: Record<string, unknown>): void;
  sendFrame(frame: ArrayBuffer): void;
  /** Must invalidate the router before stopping scheduled playback. */
  invalidateOutput(): { stream_id: string; played_ms: number } | undefined;
  onFailure(reason: string): void;
  idPrefix?: string;
  maxPendingBytes?: number;
  ackTimeoutMs?: number;
}

export class VoiceTurnCoordinator {
  private sequence = 0;
  private current: string | null = null;
  private outputAllowed = false;
  private acknowledged = false;
  private pending: ArrayBuffer[] = [];
  private pendingBytes = 0;
  private pendingEnd = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private negotiated: boolean | null = null;
  private readonly prefix: string;

  constructor(private readonly deps: VoiceTurnCoordinatorDeps) {
    this.prefix = deps.idPrefix ?? `in_${Math.random().toString(36).slice(2, 12)}`;
  }

  get supported(): boolean { return this.negotiated === true; }
  get inputId(): string | null { return this.current; }

  negotiate(supported: boolean): void {
    if (this.negotiated !== true) this.negotiated = supported;
  }

  begin(): void {
    if (this.negotiated === null) { this.deps.onFailure('capability_not_ready'); return; }
    if (!this.negotiated) {
      this.deps.sendJson({ t: 'start' });
      return;
    }
    const previous = this.current;
    const next = `${this.prefix}_${++this.sequence}`;
    this.clearPending();
    // Change the acceptance boundary synchronously, including old unseen streams.
    this.current = next;
    this.outputAllowed = true;
    this.acknowledged = false;
    const playback = this.deps.invalidateOutput();
    this.timer = setTimeout(() => this.fail('input_ack_timeout'), this.deps.ackTimeoutMs ?? 5000);
    this.deps.sendJson(previous
      ? { t: 'interrupt', target_input_id: previous, new_input_id: next, ...(playback ? { playback } : {}) }
      : { t: 'start', input_id: next });
  }

  sendFrame(frame: ArrayBuffer): void {
    if (this.negotiated === null) return;
    if (!this.negotiated) { this.deps.sendFrame(frame); return; }
    if (!this.current || !this.outputAllowed || this.pendingEnd) return;
    if (this.acknowledged) { this.deps.sendFrame(frame); return; }
    if (this.pendingBytes + frame.byteLength > (this.deps.maxPendingBytes ?? 256 * 1024)) {
      this.fail('input_buffer_overflow');
      return;
    }
    this.pending.push(frame.slice(0));
    this.pendingBytes += frame.byteLength;
  }

  finish(valid = true): void {
    if (this.negotiated === null) return;
    if (!valid) { this.abort(); return; }
    if (!this.negotiated) { this.deps.sendJson({ t: 'end' }); return; }
    if (!this.current || !this.outputAllowed) return;
    if (this.pendingEnd) return;
    this.pendingEnd = true;
    if (this.acknowledged) this.deps.sendJson({ t: 'end', input_id: this.current });
  }

  abort(): void {
    this.outputAllowed = false;
    const playback = this.deps.invalidateOutput();
    this.clearPending();
    if (this.negotiated === null) return;
    if (!this.negotiated) { this.deps.sendJson({ t: 'abort' }); return; }
    if (this.current) this.deps.sendJson({ t: 'abort', input_id: this.current, ...(playback ? { playback } : {}) });
  }

  /** Filter every turn frame, not just PCM: old final/state cannot overwrite new input. */
  accept(message: Record<string, unknown>): boolean {
    if (!this.negotiated || message.t === 'ready' || message.t === 'pong') return true;
    const id = typeof message.input_id === 'string' ? message.input_id : null;
    if (message.t === 'input_started') {
      if (id !== this.current || !this.outputAllowed || this.acknowledged) return false;
      clearTimeout(this.timer);
      this.timer = undefined;
      this.acknowledged = true;
      const pending = this.pending;
      this.pending = [];
      this.pendingBytes = 0;
      for (const frame of pending) this.deps.sendFrame(frame);
      if (this.pendingEnd) this.deps.sendJson({ t: 'end', input_id: id });
      return true;
    }
    if (id !== this.current) {
      // Connection-level errors have no turn identity and must remain visible.
      return !id && message.t === 'error';
    }
    if (message.t === 'error' && !this.acknowledged && this.outputAllowed) {
      this.fail(String(message.code ?? 'input_rejected'));
      return true;
    }
    if (!this.outputAllowed) {
      return message.t === 'interrupted' || message.t === 'metrics' || message.t === 'notice' ||
        message.t === 'error' || (message.t === 'state' && message.state === 'listening');
    }
    return true;
  }

  reset(): void {
    this.clearPending();
    this.current = null;
    this.outputAllowed = false;
    this.negotiated = null;
  }

  private fail(reason: string): void {
    this.abort();
    this.deps.onFailure(reason);
  }

  private clearPending(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    this.pendingBytes = 0;
    this.pendingEnd = false;
    this.acknowledged = false;
  }
}
