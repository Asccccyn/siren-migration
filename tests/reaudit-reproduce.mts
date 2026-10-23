import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { buildTestVoice, buildSessionHarness, connectMcpClient, silentLogger, waitFor } from '../tests/helpers.ts';
import { createSirenMcpServer } from '../apps/server/src/mcp/server.ts';
import { openDatabase, migrate, MIGRATION_001, addCallTurnLatencyColumns, CallTurnsRepository, CallSessionsRepository } from '../packages/storage/src/index.ts';
import { createLogger } from '../packages/telemetry/src/index.ts';
import { MockAsrProvider } from '../packages/providers/mock/src/mock-asr.ts';

const evidence = new URL('.', import.meta.url);
const checks: any[] = [];
const observations: Record<string, any> = {};
const payload = (r: any) => JSON.parse(r.content[0].text);
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
async function check(id: string, fn: () => Promise<void>) {
  try { await fn(); checks.push({ id, status: 'PASS' }); }
  catch (error) { checks.push({ id, status: 'FAIL', reason: (error as Error).message }); }
}
async function withMcp(fn: (b: ReturnType<typeof buildTestVoice>, client: any) => Promise<void>) {
  const b = buildTestVoice();
  const server = createSirenMcpServer({ voice: b.voice, store: b.store, logger: silentLogger, version: 'reaudit' });
  const { client, close } = await connectMcpClient(server);
  try { await fn(b, client); } finally { await close(); b.db.close(); }
}
const record = (id: string, at = 100, room = 'synthetic-room', body = '合成正文') => ({
  id, conversationId: room, messageId: `synthetic-${id}`, direction: 'assistant' as const, voiceProfile: 'main', provider: 'volc' as const,
  providerVoiceId: null, audioFormat: 'mp3' as const, sampleRate: 24000, durationMs: 1000, language: 'zh-CN', emotion: 'warm',
  text: body, ttsScript: null, transcript: null, objectKey: `voice/2026/10/${room}/synthetic-${id}/audio.mp3`, checksum: 'a'.repeat(64), createdAt: at
});
async function aggregate(path: string) {
  const { stdout } = await promisify(execFile)(process.execPath, [resolve('scripts/aggregate-turn-latency.mjs'), '--db', path]);
  return JSON.parse(stdout);
}
function insertSession(db: any, id='call-test-1') {
  db.prepare(`INSERT INTO call_sessions (id,voice_profile,status,created_at) VALUES (?,'main','active',0)`).run(id);
}
function insertTurn(db: any, id: string, outcome: string | null, index=1) {
  db.prepare(`INSERT INTO call_turns(id,call_id,turn_index,interrupted,outcome,created_at) VALUES (?,'call-test-1',?,0,?,?)`).run(id,index,outcome,index);
}

await check('R3-01 Chinese-and-Unicode-pagination-roundtrip', () => withMcp(async (b, client) => {
  const text = '海'.repeat(2400) + '😀\n"\\'.repeat(300);
  const a = await b.voice.speak({ text, messageId: 'unicode', conversationId: 'synthetic-room' });
  let cursor: string | undefined, all = '', pages = 0; const sizes: number[] = [];
  do {
    const r = await client.callTool({ name:'voice_get', arguments:{voice_message_id:a.id,...(cursor?{cursor}:{})} });
    const p = payload(r); assert.notEqual(r.isError,true); assert.ok(bytes(p)<=8192); sizes.push(bytes(p)); all+=p.text; cursor=p.text_page.next_cursor; pages++; assert.ok(pages<10);
  } while(cursor);
  assert.equal(all,text); observations.roundtrip={pages,sizes,codepoints:[...text].length};
}));

await check('R3-02 list-default-page-within-8192B', () => withMcp(async (b,client) => {
  for(let i=0;i<20;i++) b.assetsRepo.insert(record(`id-${i}`,100+i,'synthetic-room','海'.repeat(4000)) as any);
  const r=await client.callTool({name:'voice_list',arguments:{conversation_id:'synthetic-room'}});const p=payload(r);
  observations.list20={bytes:bytes(p),items:p.items?.length,isError:r.isError??false};
  await writeFile('/Users/owner/Projects/devspace-workspace/joint-voice-audit-20261023-codex/glm-callhome-bugfix-20261024/probes/siren-evidence-out/list20-result.json',JSON.stringify(r,null,2));
  assert.ok(bytes(p)<=8192,`returned ${bytes(p)}B; code accepts up to 40960B without a documented approved total-page budget`);
}));

await check('R3-03 valid-default-list-remains-readable', () => withMcp(async (b,client) => {
  const room='r'.repeat(64);
  for(let i=0;i<55;i++) {
    const id=`${String(i).padStart(8,'0')}-0000-0000-0000-000000000000`;
    const r=record(id,100+i,room,'海'.repeat(4000));r.messageId='m'.repeat(60)+String(i).padStart(4,'0');r.objectKey=`voice/2026/10/${room}/${r.messageId}/${id}/audio.mp3`;
    b.assetsRepo.insert(r as any);
  }
  const r=await client.callTool({name:'voice_list',arguments:{conversation_id:room}});observations.list55={result:r};
  assert.notEqual(r.isError,true,`default limit=50 returned ${JSON.stringify(payload(r))}, without items or continuation`);
}));

await check('R3-04 malformed-list-cursor-is-an-error', () => withMcp(async (b,client) => {
  b.assetsRepo.insert(record('one') as any);
  const r=await client.callTool({name:'voice_list',arguments:{conversation_id:'synthetic-room',cursor:'not-a-valid-cursor'}});
  observations.invalidListCursor=r;assert.equal(r.isError,true,'invalid cursor silently restarts the first page');
}));

await check('R3-05 concurrent-same-millisecond-insert-is-not-in-snapshot', () => withMcp(async (b,client) => {
  for(const id of ['a','b','c','d','e'])b.assetsRepo.insert(record(id) as any);
  const first=payload(await client.callTool({name:'voice_list',arguments:{conversation_id:'synthetic-room',limit:2}}));
  b.assetsRepo.insert(record('c9') as any);
  const second=payload(await client.callTool({name:'voice_list',arguments:{conversation_id:'synthetic-room',limit:2,cursor:first.next_cursor}}));
  observations.concurrentInsert={first:first.items.map((x:any)=>x.id),second:second.items.map((x:any)=>x.id),cursor:first.next_cursor};
  assert.ok(!second.items.some((x:any)=>x.id==='c9'),'later insert with the same created_at enters the ongoing page snapshot');
}));

await check('R3-06 changed-filter-rejects-old-list-cursor', () => withMcp(async (b,client) => {
  b.assetsRepo.insert(record('a',200,'room-a') as any);b.assetsRepo.insert(record('b',100,'room-b') as any);
  const first=payload(await client.callTool({name:'voice_list',arguments:{conversation_id:'room-a',limit:1}}));
  const r=await client.callTool({name:'voice_list',arguments:{conversation_id:'room-b',limit:1,cursor:first.next_cursor}});
  observations.changedFilter=r;assert.equal(r.isError,true,'cursor is not bound to the original query; this is not an actor bypass claim');
}));

await check('R3-07 stale-get-cursor-isError', () => withMcp(async (b,client) => {
  const a=await b.voice.speak({text:'海'.repeat(4000),messageId:'stale',conversationId:'synthetic-room'});
  const p=payload(await client.callTool({name:'voice_get',arguments:{voice_message_id:a.id}}));
  b.db.prepare('UPDATE voice_assets SET checksum=? WHERE id=?').run('b'.repeat(64),a.id);
  const r=await client.callTool({name:'voice_get',arguments:{voice_message_id:a.id,cursor:p.text_page.next_cursor}});
  observations.staleGet=r;assert.equal(payload(r).error,'snapshot_stale');assert.equal(r.isError,true,'stale snapshot is returned as MCP success');
}));

await check('R3-08 voice-speak-model-receipt-still-over-budget', () => withMcp(async (_b,client) => {
  const r=await client.callTool({name:'voice_speak',arguments:{text:'海'.repeat(4000),message_id:'long-speak',conversation_id:'synthetic-room'}});
  observations.speak={payloadBytes:bytes(payload(r)),protocolBytes:bytes(r),duplicated:JSON.stringify(r.structuredContent)===JSON.stringify(payload(r))};
  await writeFile('/Users/owner/Projects/devspace-workspace/joint-voice-audit-20261023-codex/glm-callhome-bugfix-20261024/probes/siren-evidence-out/long-speak-result.json',JSON.stringify(r,null,2));
  assert.ok(bytes(payload(r))<=8192,'get/list pagination does not shrink voice_speak text+structuredContent');
}));

await check('R7-01 actual-v2-upgrade-retains-null', async () => {
  const req=createRequire(new URL('../packages/storage/src/sqlite.ts',import.meta.url));const Database=req('better-sqlite3');
  const db=new Database(':memory:');
  try {
    db.exec(MIGRATION_001);addCallTurnLatencyColumns(db);db.exec('CREATE TABLE _migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);INSERT INTO _migrations VALUES(1,0),(2,0)');
    insertSession(db);db.exec("INSERT INTO call_turns(id,call_id,turn_index,created_at) VALUES('old','call-test-1',1,0)");migrate(db);migrate(db);
    observations.v2Upgrade=db.prepare('SELECT outcome FROM call_turns').get();assert.equal(observations.v2Upgrade.outcome,null);assert.equal(db.prepare('SELECT max(version) AS v FROM _migrations').get().v,3);
  }finally{db.close();}
});

await check('R7-02 all-unknown-does-not-report-zero-failure-rate', async () => {
  const dir=await mkdtemp(join(tmpdir(),'siren-reaudit-'));const path=join(dir,'unknown.db');const db=openDatabase(path);insertSession(db);insertTurn(db,'old',null);db.close();
  try{const r=await aggregate(path);observations.unknownOutcome=r.outcome;assert.equal(r.outcome.technical_failure_rate,null,'no known outcome is not evidence of 0% technical failures');}finally{await rm(dir,{recursive:true,force:true});}
});

await check('R7-03 invalid-outcome-rejected', async () => {
  const db=openDatabase(':memory:');insertSession(db);let rejected=false;
  try{try{insertTurn(db,'bad','asr_empyt');}catch{rejected=true;}observations.invalidOutcome={rejected,row:db.prepare('SELECT outcome FROM call_turns').get()};assert.ok(rejected,'plain TEXT/string accepts typo outcomes silently as unknown');}finally{db.close();}
});

await check('R7-04 accepted-and-recognized-denominators-match-real-stages', async () => {
  const dir=await mkdtemp(join(tmpdir(),'siren-reaudit-stages-'));const path=join(dir,'stages.db');const db=openDatabase(path);insertSession(db);
  const logs:any[]=[];let coreCalls=0;
  const asr=new MockAsrProvider({partials:['未定稿'],final:'final',finalDelayMs:1000});
  const h=buildSessionHarness({asr,turnsRepo:new CallTurnsRepository(db),sessionsRepo:new CallSessionsRepository(db),logger:createLogger({sink:(line)=>logs.push(JSON.parse(line))}),core:{async *streamReply(){coreCalls++;yield{text:'reply'};},async cancel(){}}});
  try{
    h.session.handleMessage({t:'start'});h.session.handleMessage({t:'abort'}); // accepted but never submitted end
    h.session.handleMessage({t:'start'});h.session.handleBinary(Buffer.alloc(3200,1));await waitFor(()=>h.texts().some(x=>x.t==='partial'));
    h.session.handleMessage({t:'end'});h.session.handleMessage({t:'abort'}); // ENDING interrupted before adoption/Core
    h.session.destroy('audit');
    const r=await aggregate(path);observations.stages={started:logs.filter(x=>x.event==='turn_started').length,coreCalls,rows:db.prepare('SELECT outcome,user_text FROM call_turns').all(),outcome:r.outcome};
    assert.equal(r.outcome.recognized_turns,coreCalls,'ENDING interrupted is counted as recognized/reply-chain despite zero Core calls');
    assert.equal(r.outcome.accepted_turns,observations.stages.started,'accepted start→abort disappeared from DB');
  }finally{h.session.destroy('cleanup');db.close();await rm(dir,{recursive:true,force:true});}
});

await check('R7-04b accepted-count-does-not-drop-start-abort', async () => {
  assert.equal(observations.stages.outcome.accepted_turns,observations.stages.started,'two actually accepted starts yielded only one persisted row');
});

await check('R7-05 empty-final-has-one-neutral-persisted-terminal', async () => {
  const db=openDatabase(':memory:');insertSession(db);let coreCalls=0;
  const h=buildSessionHarness({asr:new MockAsrProvider({partials:[],final:'',finalDelayMs:1}),turnsRepo:new CallTurnsRepository(db),sessionsRepo:new CallSessionsRepository(db),core:{async *streamReply(){coreCalls++;yield{text:'unexpected'};},async cancel(){}}});
  try{
    h.session.handleMessage({t:'start'});h.session.handleBinary(Buffer.alloc(640));h.session.handleMessage({t:'end'});
    await waitFor(()=>Number((db.prepare('SELECT count(*) AS n FROM call_turns').get() as any).n)===1);
    h.session.handleMessage({t:'end'});h.session.handleMessage({t:'abort'});h.session.destroy('audit');
    const rows=db.prepare('SELECT outcome,user_text,assistant_text FROM call_turns').all();
    observations.emptyFinal={rows,coreCalls};assert.equal(coreCalls,0);assert.deepEqual(rows,[{outcome:'asr_empty',user_text:null,assistant_text:null}]);
  }finally{h.session.destroy('cleanup');db.close();}
});

const result={evidence:'Real SDK InMemoryTransport/domain/storage/CallSession and actual aggregation CLI; all inputs synthetic, fake providers, no production or paid requests',checks,observations};
await writeFile('/Users/owner/Projects/devspace-workspace/joint-voice-audit-20261023-codex/glm-callhome-bugfix-20261024/probes/siren-evidence-out/reproduction-results.json',JSON.stringify(result,null,2));
for(const c of checks)console.log(`${c.status} ${c.id}${c.status==='FAIL'?': '+c.reason.split('\n')[0]:''}`);
console.log(JSON.stringify({passed:checks.filter(x=>x.status==='PASS').length,failed:checks.filter(x=>x.status==='FAIL').length,observations},null,2));
process.exitCode=checks.some(x=>x.status==='FAIL')?1:0;
