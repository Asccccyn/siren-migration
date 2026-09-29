import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const VOICE_PLAYER_URI = 'ui://siren/voice-player-v1.html';
const MCP_APP_MIME = 'text/html;profile=mcp-app';

function publicOrigin(): string {
  try {
    return new URL(process.env.SIREN_PUBLIC_URL ?? 'http://127.0.0.1:8790').origin;
  } catch {
    return 'http://127.0.0.1:8790';
  }
}

function mediaOrigins(): string[] {
  const origins = new Set<string>([publicOrigin()]);
  const r2AccountId = process.env.R2_ACCOUNT_ID?.trim();
  if (r2AccountId) {
    origins.add(`https://${r2AccountId}.r2.cloudflarestorage.com`);
  }
  return [...origins];
}

function uiMeta(): Record<string, unknown> {
  const domain = process.env.SIREN_MCP_UI_DOMAIN?.trim();
  return {
    ui: {
      prefersBorder: false,
      csp: {
        resourceDomains: mediaOrigins()
      },
      ...(domain ? { domain } : {})
    }
  };
}

export function registerVoicePlayerResource(server: McpServer): void {
  server.registerResource(
    'siren-voice-player',
    VOICE_PLAYER_URI,
    {
      description: 'Siren inline audio player for voice_speak results',
      mimeType: MCP_APP_MIME,
      _meta: uiMeta()
    },
    async () => ({
      contents: [
        {
          uri: VOICE_PLAYER_URI,
          mimeType: MCP_APP_MIME,
          text: VOICE_PLAYER_HTML,
          _meta: uiMeta()
        }
      ]
    })
  );
}

export const VOICE_PLAYER_TOOL_META = {
  ui: {
    resourceUri: VOICE_PLAYER_URI,
    visibility: ['model', 'app']
  },
  'ui/resourceUri': VOICE_PLAYER_URI,
  'openai/outputTemplate': VOICE_PLAYER_URI,
  'openai/widgetAccessible': true,
  'openai/toolInvocation/invoking': '正在生成语音…',
  'openai/toolInvocation/invoked': '语音已生成'
} as const;

const VOICE_PLAYER_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif}
*{box-sizing:border-box}body{margin:0;padding:4px;background:transparent;color:CanvasText}.card{max-width:560px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:18px;padding:13px 14px 12px;background:color-mix(in srgb,Canvas 96%,transparent)}
.row{display:flex;align-items:center;gap:10px}.play{width:38px;height:38px;border:0;border-radius:50%;background:CanvasText;color:Canvas;font-size:15px;cursor:pointer;flex:0 0 auto}.track{flex:1;min-width:0}.bar{width:100%;accent-color:currentColor}.time{font-size:12px;opacity:.58;white-space:nowrap}.toggle{margin-top:8px;border:0;background:none;color:inherit;opacity:.72;padding:2px 0;font-size:13px;cursor:pointer}.copy{display:none;margin-top:8px;font-size:14px;line-height:1.55;white-space:pre-wrap}.status{font-size:12px;opacity:.58;margin-top:7px}.status:empty{display:none}audio{display:none}
</style>
</head>
<body>
<div class="card">
  <audio id="audio" preload="metadata"></audio>
  <div class="row">
    <button id="play" class="play" type="button" aria-label="播放">▶</button>
    <div class="track"><input id="bar" class="bar" type="range" min="0" max="1000" value="0" aria-label="播放进度"></div>
    <span id="time" class="time">0:00</span>
  </div>
  <button id="toggle" class="toggle" type="button">查看文字⌄</button>
  <div id="copy" class="copy"></div>
  <div id="status" class="status"></div>
</div>
<script>
(() => {
  const audio=document.getElementById('audio'),play=document.getElementById('play'),bar=document.getElementById('bar'),time=document.getElementById('time'),toggle=document.getElementById('toggle'),copy=document.getElementById('copy'),status=document.getElementById('status');
  let nextId=1, initId=null, handshakeDone=false, lastData=null;
  const fmt=s=>Number.isFinite(s)?Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0'):'0:00';
  function decode(d){
    if(!d)return null;
    if(typeof d==='string'){try{return decode(JSON.parse(d))}catch{return null}}
    if(typeof d!=='object')return null;
    if(d.structuredContent)return decode(d.structuredContent);
    if(Array.isArray(d.content)){
      const textBlock=d.content.find(x=>x&&x.type==='text'&&typeof x.text==='string');
      if(textBlock)return decode(textBlock.text);
    }
    return d;
  }
  function notifySize(){
    if(!handshakeDone)return;
    const rect=document.documentElement.getBoundingClientRect();
    send({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{width:Math.ceil(rect.width),height:Math.ceil(rect.height)}});
  }
  function render(raw){
    const d=decode(raw);if(!d)return;
    lastData=d;
    const url=d.audio_url||d.audioUrl||'';
    if(url&&audio.src!==url)audio.src=url;
    copy.textContent=d.text||d.transcript||'';
    status.textContent=url?'':'语音已生成，但播放器没有收到 audio_url。';
    queueMicrotask(notifySize);
  }
  function send(msg){window.parent.postMessage(msg,'*')}
  function request(method,params){const id=nextId++;send({jsonrpc:'2.0',id,method,params});return id}
  function initialize(){if(initId!==null)return;initId=request('ui/initialize',{appCapabilities:{availableDisplayModes:['inline']},appInfo:{name:'Siren Voice Player',version:'1.0.0'},protocolVersion:'2026-01-26'})}
  window.addEventListener('message',event=>{
    if(event.source!==window.parent)return;
    const m=event.data;
    if(!m||m.jsonrpc!=='2.0')return;
    if(m.id===initId&&m.result){
      handshakeDone=true;
      send({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}});
      queueMicrotask(notifySize);
      return;
    }
    if(m.method==='ui/notifications/tool-result')render(m.params);
  });
  window.addEventListener('openai:set_globals',event=>render(event.detail?.globals?.toolOutput||window.openai?.toolOutput),{passive:true});
  play.onclick=()=>audio.paused?audio.play().catch(()=>{status.textContent='点一下播放按钮即可播放。'}):audio.pause();
  audio.onplay=()=>play.textContent='❚❚'; audio.onpause=()=>play.textContent='▶';
  audio.onloadedmetadata=()=>{time.textContent='0:00 / '+fmt(audio.duration);queueMicrotask(notifySize)};
  audio.ontimeupdate=()=>{bar.value=audio.duration?String(Math.round(audio.currentTime/audio.duration*1000)):'0';time.textContent=fmt(audio.currentTime)+' / '+fmt(audio.duration)};
  bar.oninput=()=>{if(audio.duration)audio.currentTime=Number(bar.value)/1000*audio.duration};
  toggle.onclick=()=>{const open=copy.style.display==='block';copy.style.display=open?'none':'block';toggle.textContent=open?'查看文字⌄':'收起文字⌃';queueMicrotask(notifySize)};
  const openaiData=window.openai?.toolOutput; if(openaiData)render(openaiData);
  initialize();
  if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>notifySize()).observe(document.documentElement);
  setTimeout(()=>{if(!lastData&&!window.openai?.toolOutput)status.textContent='等待语音结果…'},1200);
})();
</script>
</body>
</html>`;
