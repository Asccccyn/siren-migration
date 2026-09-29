/**
 * 麦克风采集装配（规范第 16 节）：getUserMedia + AudioWorklet。
 * worklet 代码以 Blob URL 内联注入，避免独立文件与部署路径问题；
 * 不使用已废弃的 ScriptProcessorNode。
 * F18：MediaStream 通过 dispose() 统一释放（停止全部 track + 关闭 AudioContext），
 * getUserMedia 之后的任何一步失败也立即归还麦克风。
 */

const WORKLET_CODE = `
class SirenCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}
registerProcessor('siren-capture', SirenCaptureProcessor);
`;

export interface CapturePipeline {
  context: AudioContext;
  worklet: AudioWorkletNode;
  sampleRate: number;
  /** 停止全部麦克风轨道并关闭 AudioContext（幂等；挂断/换通话时必须调用） */
  dispose(): Promise<void>;
}

export async function setupCapture(onSamples: (samples: Float32Array) => void): Promise<CapturePipeline> {
  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  let context: AudioContext | null = null;
  let worklet: AudioWorkletNode | null = null;
  try {
    context = new AudioContext();
    const blobUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));
    await context.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);
    worklet = new AudioWorkletNode(context, 'siren-capture');
    worklet.port.onmessage = (event) => {
      onSamples(event.data as Float32Array);
    };
    context.createMediaStreamSource(mediaStream).connect(worklet);
  } catch (error) {
    // F18：授权已拿到但装配失败——先归还麦克风再抛，避免轨道泄漏（指示灯常亮）
    worklet?.disconnect();
    await context?.close().catch(() => undefined);
    mediaStream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  const boundContext = context;
  const boundWorklet = worklet;
  let disposed = false;
  return {
    context: boundContext,
    worklet: boundWorklet,
    sampleRate: boundContext.sampleRate,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      boundWorklet.port.onmessage = null;
      boundWorklet.disconnect();
      mediaStream.getTracks().forEach((track) => track.stop());
      await boundContext.close().catch(() => undefined);
    }
  };
}
