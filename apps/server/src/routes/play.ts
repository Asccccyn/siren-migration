/**
 * GET /play/:id：语音消息的即开即播页面（无需 Bearer，id 为不可枚举 UUID）。
 * 用途：MCP voice_speak 返回的 audio_url 是裸签名直链，对话 UI 不渲染音频；
 * 对方在回复里贴 /play/{voice_message_id} 链接，点开即是自动播放的语音条页面。
 */
import type { FastifyInstance } from 'fastify';
import { escapeHtml } from './html.ts';
import type { VoiceService } from '@siren/voice-core';

export interface PlayRoutesDeps {
  voice: VoiceService;
}

export function registerPlayRoute(app: FastifyInstance, deps: PlayRoutesDeps): void {
  app.get('/play/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    // 兼容 voice_message_id（asset id）与 message_id 两种引用
    const record = await deps.voice.getVoiceMessage({ id }) ?? await deps.voice.getVoiceMessage({ messageId: id });
    if (!record) {
      await reply.code(404).send({ error: 'not_found' });
      return;
    }
    const durationSec = (record.durationMs / 1000).toFixed(1);
    const text = escapeHtml(record.text ?? record.transcript ?? '');
    const title = escapeHtml(record.direction === 'user' ? '你的语音消息' : '他的语音');
    await reply.header('content-type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · 听见</title>
<link rel="stylesheet" href="/playground/siren.css">
<style>
  body { display: flex; align-items: center; justify-content: center; min-height: 100svh; }
  .wrap { max-width: 460px; width: 100%; padding-bottom: 0; }
  .who { display: flex; align-items: baseline; gap: 12px; margin-bottom: 16px; }
  .who h1 { margin: 0; font-family: var(--font-display); font-weight: 500; font-size: 34px; letter-spacing: .16em; }
  .who .dur { font-size: 12px; color: var(--dimmer); }
  audio { width: 100%; margin-top: 4px; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="who"><h1>${title}</h1><span class="dur">${durationSec} 秒</span></div>
    <div class="voice-item">
      <audio controls autoplay src="${escapeHtml(record.audioUrl)}"></audio>
      ${text ? `<div class="text">${text}</div>` : ''}
    </div>
  </div>
</body>
</html>`);
  });
}
