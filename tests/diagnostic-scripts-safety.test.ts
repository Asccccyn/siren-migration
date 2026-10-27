import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const scratch: string[] = [];
afterEach(async () => { for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function run(script: string, imported = false) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'siren-diagnostic-gate-')));
  scratch.push(dir);
  const marker = join(dir, 'forbidden-actions.log');
  const guard = join(dir, 'guard.cjs');
  await writeFile(guard, `
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const dns = require('node:dns');
const dnsPromises = require('node:dns/promises');
const append = fs.appendFileSync;
const deny = (kind) => { append(${JSON.stringify(marker)}, kind+'\\n'); throw new Error('FORBIDDEN_DIAGNOSTIC_ACTION'); };
const sensitive = (value) => /(?:^|[\\\\/])\\.env$|\\.pcm$|[\\\\/]data[\\\\/]/.test(String(value));
for (const [api, names] of [[fs, ['readFileSync', 'readFile', 'openSync', 'open', 'statSync', 'stat']], [fsp, ['readFile', 'open', 'stat']]]) {
  for (const name of names) { const original = api[name]; api[name] = function(path, ...args) { if (sensitive(path)) deny('sensitive-read'); return original.call(this, path, ...args); }; }
}
net.Socket.prototype.connect = () => deny('network');
for (const api of [dns, dnsPromises]) for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) api[name] = () => deny('dns');
globalThis.fetch = () => deny('fetch');
require('node:module').syncBuiltinESMExports();
`);
  // 只转译该脚本、不打包依赖；纯node执行以排除tsx自身IPC对网络观测的干扰。
  const source = await readFile(join(root, 'scripts', script), 'utf8');
  const compiled = ts.transpileModule(source, {
    fileName: script, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  const file = join(dir, script.replace(/\.mts$/, '.mjs'));
  await writeFile(file, compiled);
  const args = imported ? ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(file).href)})`] : [file];
  const result = await new Promise<{ code: string | number; stdout: string; stderr: string }>((done) => {
    execFile(process.execPath, args, {
      cwd: dir, timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf8',
      env: { PATH: process.env.PATH, NODE_OPTIONS: `--require=${guard}` }
    }, (error, stdout, stderr) => done({ code: error?.code ?? 0, stdout, stderr }));
  });
  const forbidden = await readFile(marker, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return { ...result, forbidden };
}

describe('diagnostic scripts default to no credentials / no network', () => {

  it('ASR诊断没有明确实机开关即非0退出，无配置/音频/DNS/网络尝试', async () => {
    const result = await run('repro-asr-abort.mts');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--allow-real-asr');
    expect(result.stdout).toBe('');
    expect(result.forbidden).toBe('');
  });

  it.each(['repro-asr-abort.mts'])('导入%s不执行诊断或输出', async (script) => {
    const result = await run(script, true);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.forbidden).toBe('');
  });

  it('ASR实机分支的会话在统一finally释放；默认门位于main第一条语句', async () => {
    const source = await readFile(join(root, 'scripts/repro-asr-abort.mts'), 'utf8');
    const ast = ts.createSourceFile('repro-asr-abort.mts', source, ts.ScriptTarget.Latest, true);
    const functions = ast.statements.filter(ts.isFunctionDeclaration);
    const main = functions.find((node) => node.name?.text === 'main')!;
    const first = main.body!.statements[0];
    expect(ts.isIfStatement(first)).toBe(true);
    expect(first.getText(ast)).toContain('--allow-real-asr');
    expect(first.getText(ast)).toContain('return 2');
    const owner = functions.find((node) => node.name?.text === 'withSession')!;
    const cleanup = owner.body!.statements.find(ts.isTryStatement)!.finallyBlock!;
    expect(cleanup.getText(ast)).toContain('session.abort()');
    expect(source).not.toContain('error.message');
    expect(source).not.toContain('result.text.slice');
  });
});
