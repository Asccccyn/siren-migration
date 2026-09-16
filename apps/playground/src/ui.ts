/**
 * Realtime 页面的 DOM 引用与渲染（只做展示，不含任何逻辑状态）。
 */
export const ui = {
  stateBadge: document.getElementById('stateBadge') as HTMLSpanElement,
  partial: document.getElementById('partial') as HTMLDivElement,
  asrLog: document.getElementById('asrLog') as HTMLPreElement,
  reply: document.getElementById('reply') as HTMLDivElement,
  metricsBody: document.getElementById('metricsBody') as HTMLTableSectionElement,
  eventLog: document.getElementById('eventLog') as HTMLPreElement,
  noiseFloor: document.getElementById('noiseFloor') as HTMLSpanElement,
  callBtn: document.getElementById('callBtn') as HTMLButtonElement,
  muteBtn: document.getElementById('muteBtn') as HTMLButtonElement,
  hangupBtn: document.getElementById('hangupBtn') as HTMLButtonElement,
  pttBtn: document.getElementById('pttBtn') as HTMLButtonElement,
  modeSelect: document.getElementById('mode') as HTMLSelectElement,
  conversationId: document.getElementById('conversationId') as HTMLInputElement,
  vConfirm: document.getElementById('vConfirm') as HTMLInputElement,
  vMin: document.getElementById('vMin') as HTMLInputElement,
  vEnd: document.getElementById('vEnd') as HTMLInputElement,
  vRatio: document.getElementById('vRatio') as HTMLInputElement,
  vJitter: document.getElementById('vJitter') as HTMLInputElement
};

export function setBadge(state: string): void {
  ui.stateBadge.textContent = state;
  ui.stateBadge.className = `badge ${state}`;
}

export function logEvent(message: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  ui.eventLog.textContent = `${line}\n${ui.eventLog.textContent ?? ''}`.split('\n').slice(0, 200).join('\n');
}

export function renderMetrics(metrics: Record<string, unknown> | undefined): void {
  if (!metrics) return;
  const rows: [string, string][] = [
    ['ASR latency', `${metrics.asr_latency_ms ?? '-'} ms`],
    ['LLM TTFT', `${metrics.llm_first_token_ms ?? '-'} ms`],
    ['TTS first audio', `${metrics.tts_first_audio_ms ?? '-'} ms`],
    ['Total first audio', `${metrics.total_first_audio_ms ?? '-'} ms`],
    ['Interrupted', String(metrics.interrupted ?? false)],
    ['Filler', String(metrics.filler_played ?? false)]
  ];
  ui.metricsBody.innerHTML = rows
    .map(([k, v]) => `<tr><td class="muted">${k}</td><td>${v}</td></tr>`)
    .join('');
}
