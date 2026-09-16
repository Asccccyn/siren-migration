/**
 * 麦克风采集装配（规范第 16 节）：getUserMedia + AudioWorklet。
 * worklet 代码以 Blob URL 内联注入，避免独立文件与部署路径问题；
 * 不使用已废弃的 ScriptProcessorNode。
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
}

export async function setupCapture(onSamples: (samples: Float32Array) => void): Promise<CapturePipeline> {
  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  const context = new AudioContext();
  const blobUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));
  await context.audioWorklet.addModule(blobUrl);
  URL.revokeObjectURL(blobUrl);
  const worklet = new AudioWorkletNode(context, 'siren-capture');
  worklet.port.onmessage = (event) => {
    onSamples(event.data as Float32Array);
  };
  context.createMediaStreamSource(mediaStream).connect(worklet);
  return { context, worklet, sampleRate: context.sampleRate };
}
