/**
 * 复现脚本（1002 通话故障）：打断后立即新建的 ASR 会话是否变聋。
 * 直接打真实火山 sauc，不经过 CallSession/网关，不消耗 codex 额度。
 * 用法：pnpm exec tsx scripts/repro-asr-abort.mts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrebufferedAsrSession } from '../packages/voice-core/src/asr-prebuffer.ts';
import { VolcStreamAsrProvider } from '../packages/providers/volc-asr/src/stream.ts';
import type { StreamAsrOptions, AsrStreamHandlers, StreamAsrProvider } from '@siren/contracts';

// .env 盲载（不打印任何值）
for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
  if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!;
}

const config = {
  wsUrl: process.env.VOLC_ASR_WS_URL ?? 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
  appId: process.env.VOLC_APP_ID ?? '',
  accessToken: process.env.VOLC_ACCESS_TOKEN ?? '',
  apiKey: process.env.VOLC_API_KEY ?? '',
  resourceId: process.env.VOLC_ASR_RESOURCE_ID ?? 'volc.bigasr.sauc.duration',
  cluster: '',
  asrCluster: '',
  asrBatchResourceId: '',
  asrBatchUrl: '',
  ttsCluster: '',
  ttsUrl: '',
  ttsWsUrl: '',
  ttsResourceId: '',
  voiceId: '',
  httpTimeoutMs: 10_000,
  connectTimeoutMs: Number(process.env.VOLC_CONNECT_TIMEOUT_MS ?? 5000)
};

const pcm = readFileSync('/tmp/speech16k.pcm');
const options = { language: 'zh-CN' } as StreamAsrOptions;
const handlers: AsrStreamHandlers = {
  onPartial: (text) => { process.stdout.write(`    partial: ${text}\n`); },
  onError: (error) => { process.stdout.write(`    !! asr error: ${(error as Error).message}\n`); }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = () => Date.now();

async function runSession(label: string, provider: StreamAsrProvider): Promise<string> {
  const started = t0();
  const session = new PrebufferedAsrSession(provider, options, handlers, 1024 * 1024, 3000);
  void session.connect();
  // 200ms 一批（比真实快，但保持流式节奏）
  for (let off = 0; off < pcm.length; off += 6400) {
    session.feed(pcm.subarray(off, Math.min(off + 6400, pcm.length)));
    await sleep(100);
  }
  const result = await session.end();
  process.stdout.write(`  [${label}] ${t0() - started}ms -> "${result.text.slice(0, 30)}" (${result.text.length} 字)\n`);
  return result.text;
}

const newProvider = () => new VolcStreamAsrProvider(config as never, undefined);

async function main() {
  const provider = newProvider();

  process.stdout.write('场景1 基线：全新会话\n');
  await runSession('baseline', provider);

  process.stdout.write('场景2 复现目标：会话A正常end后 -> A.abort()（handleAbort 对已结束会话的调用）-> 立即新建会话B\n');
  const a = new PrebufferedAsrSession(provider, options, handlers, 1024 * 1024, 3000);
  void a.connect();
  for (let off = 0; off < pcm.length; off += 6400) {
    a.feed(pcm.subarray(off, Math.min(off + 6400, pcm.length)));
    await sleep(100);
  }
  await a.end();
  a.abort(); // <- handleAbort 在 turn 已收尾后仍会调 asr.abort()
  await runSession('post-abort', provider);

  process.stdout.write('场景3 abort 建连中的会话 -> 立即新建会话（打断发生在建连期）\n');
  const c = new PrebufferedAsrSession(provider, options, handlers, 1024 * 1024, 3000);
  void c.connect();
  c.feed(pcm.subarray(0, 6400));
  c.abort();
  await runSession('abort-connecting', provider);

  process.stdout.write('场景4 复现后隔 2s 再建（若场景2聋，判断是否时间自愈）\n');
  await sleep(2000);
  await runSession('delay-2s', provider);

  process.stdout.write('场景5 换新 provider 实例（判断是否有进程内共享状态）\n');
  await runSession('fresh-provider', newProvider());
}

void main();
