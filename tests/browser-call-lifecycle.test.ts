/** Browser wiring with fakes only: no microphone, AudioContext, WebSocket or fetch IO. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => {
  type Callback = (event: { preventDefault(): void }) => unknown;
  class Control {
    value = '';
    textContent = '';
    disabled = false;
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    listeners = new Map<string, Callback[]>();
    addEventListener(event: string, callback: Callback) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), callback]);
    }
    fire(event: string) {
      return Promise.all((this.listeners.get(event) ?? []).map(callback => callback({ preventDefault() {} })));
    }
  }
  const controls = new Map<string, Control>();
  const defaults: Record<string, string> = { modeSelect: 'vad', conversationId: 'synthetic-browser-call',
    vConfirm: '200', vMin: '400', vEnd: '700', vRatio: '4', vJitter: '350' };
  const ui = new Proxy({} as Record<string, Control>, {
    get(_target, key: string) {
      if (!controls.has(key)) { const element = new Control(); element.value = defaults[key] ?? ''; controls.set(key, element); }
      return controls.get(key);
    }
  });
  const captures: { context?: AudioContext; settled: boolean; resolve(value: unknown): void; reject(error: Error): void }[] = [];
  const capture = vi.fn((_samples: unknown, context?: AudioContext) => new Promise((resolve, reject) => {
    const pending = { context, settled: false,
      resolve(value: unknown) { pending.settled = true; resolve(value); },
      reject(error: Error) { pending.settled = true; reject(error); } };
    captures.push(pending);
  }));
  return { ui, controls, captures, capture, log: vi.fn(), badge: vi.fn() };
});

vi.mock('../apps/web/src/ui.ts', () => ({ ui: browser.ui, logEvent: browser.log, setBadge: browser.badge, renderMetrics: vi.fn() }));
vi.mock('../apps/web/src/login-gate.ts', () => ({ getStoredToken: () => 'synthetic-token', requireToken: vi.fn() }));
vi.mock('../apps/web/src/capture-worklet.ts', () => ({ setupCapture: browser.capture }));

class FakeContext {
  static instances: FakeContext[] = [];
  sampleRate = 48000;
  currentTime = 0;
  destination = {};
  state = 'suspended';
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => { this.state = 'closed'; });
  constructor() { FakeContext.instances.push(this); }
}

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readyState = 0;
  binaryType = '';
  sent: unknown[] = [];
  onopen: (() => unknown) | null = null;
  onclose: ((event: { code: number }) => unknown) | null = null;
  onerror: (() => unknown) | null = null;
  onmessage: ((event: { data: string }) => unknown) | null = null;
  close = vi.fn((code = 1000) => { this.readyState = 3; this.onclose?.({ code }); });
  constructor(readonly url: unknown) { FakeSocket.instances.push(this); }
  send(data: unknown) { this.sent.push(data); }
  open() { this.readyState = 1; this.onopen?.(); }
  ready() { this.onmessage?.({ data: JSON.stringify({ t: 'ready', protocol: 2, capabilities: { voice_interrupt: true } }) }); }
}

async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
function pipeline(context: AudioContext) {
  let disposed = false;
  return { context, sampleRate: 48000, playbackInput: {}, worklet: {}, echoCancellation: true,
    dispose: vi.fn(async () => { if (!disposed) { disposed = true; await context.close(); } }) };
}
async function startCall() {
  void browser.ui.callBtn.fire('click');
  await flush();
  const socket = FakeSocket.instances.at(-1)!;
  expect(socket).toBeDefined();
  socket.open();
  socket.ready();
  await flush();
  return socket;
}

beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules();
  browser.controls.clear(); browser.captures.length = 0; browser.capture.mockClear(); browser.log.mockClear(); browser.badge.mockClear();
  FakeContext.instances.length = 0; FakeSocket.instances.length = 0;
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', { setInterval, clearInterval });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    call_id: 'synthetic', ws_url: 'ws://127.0.0.1:1/ws/call/synthetic', token: 'synthetic-token'
  }), { status: 201 })));
  await import('../apps/web/src/RealtimeCallTest.ts');
});

afterEach(async () => {
  for (const socket of FakeSocket.instances) if (socket.readyState !== 3) socket.close();
  for (const pending of browser.captures) {
    if (!pending.settled && pending.context) pending.resolve(pipeline(pending.context));
  }
  await flush(); vi.clearAllTimers(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('call button owns browser capture lifetime', () => {
  it('creates and resumes AudioContext synchronously from the click, then supplies it to capture', async () => {
    let finishFetch!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finishFetch = resolve; })));
    void browser.ui.callBtn.fire('click');
    expect(FakeContext.instances).toHaveLength(1);
    const context = FakeContext.instances[0];
    expect(context.resume).toHaveBeenCalledOnce();
    expect(browser.capture).not.toHaveBeenCalled();
    await flush();
    finishFetch(new Response(JSON.stringify({ call_id: 'synthetic', ws_url: 'ws://127.0.0.1:1/ws/call/synthetic', token: 'synthetic' }), { status: 201 }));
    await flush(); FakeSocket.instances[0].open(); await flush();
    expect(browser.capture).not.toHaveBeenCalled(); // Permission/capture waits for capability ACK.
    FakeSocket.instances[0].ready(); await flush();
    expect(browser.captures[0]?.context).toBe(context);
  });

  it('request failure closes the prepared context and restores the call button', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    await browser.ui.callBtn.fire('click'); await flush();
    expect(FakeContext.instances[0]?.state).toBe('closed');
    expect(FakeSocket.instances).toHaveLength(0);
    expect(browser.ui.callBtn.disabled).toBe(false);
  });

  it('hangup cancels a pending call request and closes its prepared audio context', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
      signal = options.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    })));
    const pending = browser.ui.callBtn.fire('click');
    await flush();
    expect(browser.ui.hangupBtn.disabled).toBe(false);
    await browser.ui.hangupBtn.fire('click');
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(FakeContext.instances[0].state).toBe('closed');
    expect(FakeSocket.instances).toHaveLength(0);
    expect(browser.ui.callBtn.disabled).toBe(false);
  });

  it.each(['success', 'failure'])('late capture %s from a hung-up call cannot close a new call', async (outcome) => {
    const old = await startCall();
    const oldCapture = browser.captures[0];
    expect(oldCapture?.context).toBeDefined();
    old.close(); await flush();
    const current = await startCall();
    const newContext = FakeContext.instances[1];
    if (outcome === 'failure') oldCapture.reject(new Error('synthetic late permission failure'));
    else oldCapture.resolve(pipeline(oldCapture.context!));
    await flush();
    expect(current.close).not.toHaveBeenCalled();
    expect(newContext.state).toBe('running');
    expect(FakeContext.instances[0].state).toBe('closed');
  });

  it('stale socket callbacks cannot tear down the current call', async () => {
    const old = await startCall(); const oldClose = old.onclose; const oldError = old.onerror;
    old.close(); await flush();
    const current = await startCall();
    browser.badge.mockClear();
    oldClose?.({ code: 1006 }); oldError?.(); await flush();
    expect(current.close).not.toHaveBeenCalled();
    expect(FakeContext.instances[1].state).toBe('running');
    expect(browser.badge).not.toHaveBeenCalledWith('ended');
  });
});
