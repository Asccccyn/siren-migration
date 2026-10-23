/**
 * 麦克风采集装配（规范第 16 节）：getUserMedia + AudioWorklet。
 * worklet 代码以 Blob URL 内联注入，避免独立文件与部署路径问题；
 * 不使用已废弃的 ScriptProcessorNode。
 * F18：MediaStream 通过 dispose() 统一释放（停止全部 track + 关闭 AudioContext），
 * getUserMedia 之后的任何一步失败也立即归还麦克风。
 * C09：监听 track.onended 与 devicechange，采集设备丢失（蓝牙耳机拔出等）
 * 显式上报而非让流静默死亡；这是设备状态，不是供应商错误。
 */

const WORKLET_CODE = `
class SirenCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const microphone = new Float32Array(input[0]);
      const reference = new Float32Array(inputs[1]?.[0] ?? microphone.length);
      this.port.postMessage({ microphone, reference }, [microphone.buffer, reference.buffer]);
    }
    for (const channel of outputs[0] ?? []) channel.fill(0);
    return true;
  }
}
registerProcessor('siren-capture', SirenCaptureProcessor);
`;

export interface CapturePipeline {
  context: AudioContext;
  worklet: AudioWorkletNode;
  sampleRate: number;
  /** Rendered playback goes to both the output device and reference input. */
  playbackInput: GainNode;
  echoCancellation: boolean | undefined;
  /** 本管线是否已上报设备丢失（C09；一次性） */
  readonly deviceLost: boolean;
  /** 停止全部麦克风轨道并关闭 AudioContext（幂等；挂断/换通话时必须调用） */
  dispose(): Promise<void>;
}

interface DeviceWatch {
  /** 是否已上报设备丢失（一次性） */
  readonly lost: boolean;
  /** 解除 onended / devicechange 监听（dispose / 装配失败时调用） */
  release(): void;
}

/** C09：监听 track.onended 与 devicechange（有则监听）。
 * devicechange 上任何设备增删都可能移走当前输入——只有本流轨道真已 ended
 * 才判定丢失，避免插入新设备误杀通话。上报至多一次。 */
function installDeviceWatch(audioTracks: MediaStreamTrack[], onDeviceLost?: () => void): DeviceWatch {
  let lost = false;
  let released = false;
  const notify = (): void => {
    if (lost || released) return;
    lost = true;
    onDeviceLost?.();
  };
  for (const track of audioTracks) {
    // stop() 不触发 onended（仅外部原因如设备拔出触发）
    track.onended = () => notify();
  }
  let onDeviceChange: (() => void) | null = null;
  if (navigator.mediaDevices?.addEventListener) {
    onDeviceChange = () => {
      if (audioTracks.some((track) => track.readyState === 'ended')) notify();
    };
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
  }
  return {
    get lost() { return lost; },
    release(): void {
      released = true;
      for (const track of audioTracks) track.onended = null;
      if (onDeviceChange && navigator.mediaDevices?.removeEventListener) {
        navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
      }
    }
  };
}

export async function setupCapture(
  onSamples: (samples: Float32Array, reference: Float32Array) => void,
  preparedContext?: AudioContext,
  /** C09：采集设备丢失回调（track ended / devicechange 确认轨道死亡），至多触发一次 */
  onDeviceLost?: () => void
): Promise<CapturePipeline> {
  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  const audioTracks = mediaStream.getAudioTracks();
  const deviceWatch = installDeviceWatch(audioTracks, onDeviceLost);
  let context: AudioContext | null = preparedContext ?? null;
  let worklet: AudioWorkletNode | null = null;
  let playbackInput: GainNode | null = null;
  try {
    context ??= new AudioContext();
    const blobUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));
    try {
      await context.audioWorklet.addModule(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    worklet = new AudioWorkletNode(context, 'siren-capture', { numberOfInputs: 2, outputChannelCount: [1] });
    worklet.port.onmessage = (event) => {
      onSamples(event.data.microphone as Float32Array, event.data.reference as Float32Array);
    };
    playbackInput = context.createGain();
    playbackInput.connect(context.destination);
    playbackInput.connect(worklet, 0, 1);
    // The processor outputs silence; connecting it keeps the capture graph pulled.
    worklet.connect(context.destination);
    context.createMediaStreamSource(mediaStream).connect(worklet);
  } catch (error) {
    // F18：授权已拿到但装配失败——先归还麦克风再抛，避免轨道泄漏（指示灯常亮）
    worklet?.disconnect();
    playbackInput?.disconnect();
    deviceWatch.release();
    mediaStream.getTracks().forEach((track) => track.stop());
    await context?.close().catch(() => undefined);
    throw error;
  }
  const boundContext = context;
  const boundWorklet = worklet;
  const boundPlayback = playbackInput;
  let disposed = false;
  return {
    context: boundContext,
    worklet: boundWorklet,
    sampleRate: boundContext.sampleRate,
    playbackInput: boundPlayback,
    echoCancellation: audioTracks[0]?.getSettings().echoCancellation,
    get deviceLost(): boolean {
      return deviceWatch.lost;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      deviceWatch.release();
      boundWorklet.port.onmessage = null;
      boundWorklet.disconnect();
      boundPlayback.disconnect();
      mediaStream.getTracks().forEach((track) => track.stop());
      await boundContext.close().catch(() => undefined);
    }
  };
}
