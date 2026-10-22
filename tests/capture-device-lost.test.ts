/**
 * C09：capture-worklet 设备丢失上报（track.onended / devicechange）。
 * 无真实浏览器：getUserMedia / AudioContext / AudioWorkletNode / mediaDevices 全部 fake。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupCapture } from '../apps/web/src/capture-worklet.ts';

interface FakeTrack {
  readyState: 'live' | 'ended';
  onended: (() => void) | null;
  stop(): void;
  getSettings(): { echoCancellation: boolean };
}

function fakeTrack(): FakeTrack {
  return {
    readyState: 'live',
    onended: null,
    stop() { this.readyState = 'ended'; },
    getSettings: () => ({ echoCancellation: true })
  };
}

class FakeWorkletNode {
  static instances: FakeWorkletNode[] = [];
  port = { onmessage: null as ((event: unknown) => void) | null, postMessage: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor() { FakeWorkletNode.instances.push(this); }
}

class FakeContext {
  static instances: FakeContext[] = [];
  sampleRate = 48000;
  state = 'running';
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => {}) };
  close = vi.fn(async () => { this.state = 'closed'; });
  createGain = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
  constructor() { FakeContext.instances.push(this); }
}

let track: FakeTrack;
let deviceListeners: Map<string, (() => void)[]>;

beforeEach(async () => {
  vi.resetModules();
  track = fakeTrack();
  deviceListeners = new Map();
  FakeWorkletNode.instances.length = 0;
  FakeContext.instances.length = 0;
  const mediaStream = {
    getTracks: () => [track],
    getAudioTracks: () => [track]
  };
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn(async () => mediaStream),
      addEventListener: vi.fn((event: string, listener: () => void) => {
        deviceListeners.set(event, [...(deviceListeners.get(event) ?? []), listener]);
      }),
      removeEventListener: vi.fn((event: string, listener: () => void) => {
        deviceListeners.set(event, (deviceListeners.get(event) ?? []).filter((l) => l !== listener));
      })
    }
  });
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fireDeviceChange(): void {
  for (const listener of deviceListeners.get('devicechange') ?? []) listener();
}

describe('setupCapture 设备丢失上报（C09）', () => {
  it('track 外部结束（onended）触发一次上报；重复触发只报一次', async () => {
    const onDeviceLost = vi.fn();
    const pipeline = await setupCapture(() => {}, undefined, onDeviceLost);
    expect(onDeviceLost).not.toHaveBeenCalled();
    expect(pipeline.deviceLost).toBe(false);
    track.readyState = 'ended';
    track.onended!();
    track.onended!(); // onended 与 devicechange 同时命中只报一次
    fireDeviceChange();
    expect(onDeviceLost).toHaveBeenCalledTimes(1);
    expect(pipeline.deviceLost).toBe(true);
  });

  it('devicechange 只有本流轨道已 ended 才判丢失；设备增删不误杀', async () => {
    const onDeviceLost = vi.fn();
    await setupCapture(() => {}, undefined, onDeviceLost);
    fireDeviceChange(); // 轨道仍 live：插入新设备等场景
    expect(onDeviceLost).not.toHaveBeenCalled();
    track.readyState = 'ended';
    fireDeviceChange();
    expect(onDeviceLost).toHaveBeenCalledTimes(1);
  });

  it('dispose 解除监听且不再上报；dispose 自身（track.stop）不触发丢失', async () => {
    const onDeviceLost = vi.fn();
    const pipeline = await setupCapture(() => {}, undefined, onDeviceLost);
    await pipeline.dispose();
    expect(track.onended).toBeNull(); // onended 监听已解除
    expect(deviceListeners.get('devicechange')).toHaveLength(0); // devicechange 已移除
    track.onended?.(); // 即使外部误触也不再上报
    fireDeviceChange();
    expect(onDeviceLost).not.toHaveBeenCalled();
    expect(pipeline.deviceLost).toBe(false);
  });

  it('装配失败（addModule 抛错）同样解除监听并归还麦克风', async () => {
    const onDeviceLost = vi.fn();
    const prepared = new FakeContext();
    prepared.audioWorklet.addModule = vi.fn(async () => {
      throw new Error('worklet rejected');
    });
    await expect(setupCapture(() => {}, prepared as never, onDeviceLost)).rejects.toThrow('worklet rejected');
    expect(track.onended).toBeNull();
    expect(deviceListeners.get('devicechange')).toHaveLength(0);
    expect(track.readyState).toBe('ended'); // 麦克风已归还（F18 保持）
  });
});
