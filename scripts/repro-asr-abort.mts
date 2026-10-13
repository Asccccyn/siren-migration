/**
 * 底层 ASR 诊断，默认拒绝运行。--allow-real-asr 只能在已获实机验证批准后使用。
 * 用法：node --import tsx scripts/repro-asr-abort.mts --allow-real-asr
 * 输入固定为 /tmp/speech16k.pcm，PCM16/16k/mono、至多5秒。
 * 最多6次完整输入和一次200ms建连期输入（30.2秒）；不调用TTS/Core。
 * 仅输出字节数、转写字符数、partial/error计数和耗时，不输出正文或错误原文。
 */
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AsrStreamHandlers, StreamAsrProvider } from '@siren/contracts';
import type { PrebufferedAsrSession } from '../packages/voice-core/src/asr-prebuffer.ts';

interface Context {
  pcm: Buffer;
  pending: Set<Promise<void>>;
  failed: boolean;
  open(provider: StreamAsrProvider, handlers: AsrStreamHandlers): PrebufferedAsrSession;
}
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function feed(context: Context, session: PrebufferedAsrSession): Promise<void> {
  for (let offset = 0; offset < context.pcm.length; offset += 6400) {
    session.feed(context.pcm.subarray(offset, offset + 6400));
    await sleep(100);
  }
}

async function withSession(
  context: Context, label: string, provider: StreamAsrProvider,
  action: (session: PrebufferedAsrSession) => Promise<number | null>
): Promise<number | null> {
  let partials = 0, errors = 0;
  const started = Date.now();
  const session = context.open(provider, {
    onPartial: () => { partials++; },
    onError: () => { errors++; context.failed = true; }
  });
  try {
    const connecting = session.connect();
    context.pending.add(connecting);
    void connecting.finally(() => context.pending.delete(connecting)).catch(() => undefined);
    const chars = await action(session);
    process.stdout.write(JSON.stringify({
      session: label, elapsed_ms: Date.now() - started, fed_bytes: session.fedBytes,
      transcript_chars: chars, partial_count: partials, error_count: errors
    }) + '\n');
    return chars;
  } finally {
    session.abort();
  }
}

async function scenarios(context: Context, newProvider: () => StreamAsrProvider): Promise<number> {
  const provider = newProvider();
  const results: number[] = [];
  const full = async (label: string, selected = provider) => {
    const chars = await withSession(context, label, selected, async (session) => {
      await feed(context, session);
      return (await session.end()).text.length;
    });
    results.push(chars ?? 0);
    return chars ?? 0;
  };
  if (await full('baseline') === 0) {
    process.stderr.write('基线没有有效转写，停止诊断；不能据此判断打断是否正常。\n');
    return 1;
  }
  await full('end-then-abort-A'); // finally 在正常end后abort，再立即开启下一会话。
  await full('post-abort');
  await withSession(context, 'abort-connecting', provider, async (session) => {
    session.feed(context.pcm.subarray(0, 6400));
    session.abort();
    return null; // 主动取消不是空转写成功判据。
  });
  await full('after-connect-abort');
  await sleep(2000);
  await full('delay-2s');
  await full('fresh-provider', newProvider());
  if (results.some((chars) => chars === 0)) {
    process.stderr.write('诊断观察到空转写；只记录现象，未确定根因。\n');
    return 1;
  }
  return 0;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  // 此门必须早于任何配置/音频读取、provider导入或建连。
  if (!args.includes('--allow-real-asr')) {
    process.stderr.write('未执行：真实ASR诊断需要已获批准并显式传入 --allow-real-asr；未读取配置或音频。\n');
    return 2;
  }
  const [{ readFile, stat }, { PrebufferedAsrSession }, { VolcStreamAsrProvider }] = await Promise.all([
    import('node:fs/promises'),
    import('../packages/voice-core/src/asr-prebuffer.ts'),
    import('../packages/providers/volc-asr/src/stream.ts')
  ]);
  const env = { ...process.env };
  try {
    for (const line of (await readFile(join(process.cwd(), '.env'), 'utf8')).split('\n')) {
      const match = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
      if (match && env[match[1]] === undefined) env[match[1]] = match[2];
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const audioFile = '/tmp/speech16k.pcm';
  const size = (await stat(audioFile)).size;
  if (size === 0 || size > 5 * 32000 || size % 2 !== 0) throw new Error('invalid diagnostic fixture');
  const pcm = await readFile(audioFile);
  if (pcm.length !== size) throw new Error('diagnostic fixture changed during read');
  const connectTimeoutMs = Number(env.VOLC_CONNECT_TIMEOUT_MS ?? 5000);
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0 || connectTimeoutMs > 10000) {
    throw new Error('invalid diagnostic connection timeout');
  }
  if (!env.VOLC_API_KEY && !(env.VOLC_APP_ID && env.VOLC_ACCESS_TOKEN)) throw new Error('missing diagnostic credentials');
  const newProvider = () => new VolcStreamAsrProvider({
    appId: env.VOLC_APP_ID ?? '', accessToken: env.VOLC_ACCESS_TOKEN ?? '', apiKey: env.VOLC_API_KEY,
    resourceId: env.VOLC_ASR_RESOURCE_ID ?? 'volc.bigasr.sauc.duration',
    wsUrl: env.VOLC_ASR_WS_URL ?? 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
    sampleRate: 16000, connectTimeoutMs
  });
  const context: Context = {
    pcm, pending: new Set(), failed: false,
    open: (provider, handlers) => new PrebufferedAsrSession(provider, { language: 'zh-CN' }, handlers, 1024 * 1024, 3000)
  };
  let status: number;
  try {
    status = await scenarios(context, newProvider);
  } finally {
    // 被取消的迟到建连也必须完成F09 abort，避免留下无人持有的连接。
    await Promise.allSettled([...context.pending]);
  }
  return context.failed ? 1 : status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().then((status) => { process.exitCode = status; }).catch(() => {
    process.stderr.write('真实ASR诊断失败；未输出错误原文或转写。\n');
    process.exitCode = 1;
  });
}
