import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/audit-coupling.mjs', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'siren-ast-audit-')); roots.push(root);
  const write = (path: string, text: string) => { const full = join(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, text); };
  write('package.json', JSON.stringify({ name: 'audit-fixture' }));
  const pkg = (path: string, name: string, entry = './src/index.ts') => write(path + '/package.json', JSON.stringify({ name, exports: { '.': entry } }));
  return { write, pkg, run() {
    const result = spawnSync(process.execPath, [script, '--json'], { cwd: root, encoding: 'utf8' });
    if (![0, 1].includes(result.status ?? -1)) throw new Error(result.stderr || result.error?.message);
    return JSON.parse(result.stdout) as { edges: { from: string; to: string; typeOnly: boolean; kind: string }[];
      fileCycles: string[][]; packageCycles: string[][]; violations: string[]; warnings: string[] };
  } };
}

describe('AST审计解析真实入口与分层规则', () => {
  it('以manifest入口解析包，不被内部index.ts覆盖；.js源码引用解析为.ts', () => {
    const f = fixture();
    f.pkg('packages/contracts', '@siren/contracts', './src/entry.ts');
    f.write('packages/contracts/src/entry.ts', "export { value } from './value.js';");
    f.write('packages/contracts/src/value.ts', 'export const value = 1;');
    f.write('packages/contracts/src/repositories/index.ts', 'export const other = 2;');
    f.pkg('apps/server', '@siren/server');
    f.write('apps/server/src/index.ts', "import { value } from '@siren/contracts'; void value;");
    const result = f.run();
    expect(result.edges).toContainEqual(expect.objectContaining({ from: 'apps/server/src/index.ts', to: 'packages/contracts/src/entry.ts' }));
    expect(result.edges).toContainEqual(expect.objectContaining({ from: 'packages/contracts/src/entry.ts', to: 'packages/contracts/src/value.ts' }));
    expect(result.violations).toEqual([]);
  });

  it('相对路径跨层、server直引provider、provider互引均报告，合法provider依赖contracts不误报', () => {
    const f = fixture();
    for (const [path, name] of [['packages/contracts', '@siren/contracts'], ['packages/voice-core', '@siren/voice-core'],
      ['packages/providers/one', '@siren/provider-one'], ['packages/providers/two', '@siren/provider-two'], ['apps/server', '@siren/server']]) {
      f.pkg(path, name); f.write(path + '/src/index.ts', 'export const value = 1;');
    }
    f.write('packages/providers/one/src/index.ts', "import '@siren/contracts'; import '@siren/provider-two'; import '../../../voice-core/src/index.ts';");
    f.write('apps/server/src/index.ts', "import '@siren/provider-one';");
    const violations = f.run().violations.filter(x => x.includes('分层违规'));
    expect(violations).toHaveLength(3);
    expect(violations.some(x => x.includes('provider-one -> @siren/contracts'))).toBe(false);
  });

  it('非server可达组件的type-only/re-export/dynamic循环也检查', () => {
    const f = fixture();
    f.pkg('packages/a', '@siren/a'); f.pkg('packages/b', '@siren/b');
    f.write('packages/a/src/index.ts', "import { type B } from '@siren/b'; export type A = B;");
    f.write('packages/b/src/index.ts', "export { type A as B } from '@siren/a';");
    f.write('scripts/one.ts', "export const a = import('./two.ts');");
    f.write('scripts/two.ts', "export const b = import('./one.ts');");
    const result = f.run();
    expect(result.packageCycles.some(x => x.includes('@siren/a') && x.includes('@siren/b'))).toBe(true);
    expect(result.fileCycles.some(x => x.includes('scripts/one.ts') && x.includes('scripts/two.ts'))).toBe(true);
    expect(result.edges.some(x => x.typeOnly)).toBe(true);
    expect(result.edges.some(x => x.kind === 'dynamic')).toBe(true);
  });

  it('未导出子路径不能猜入口；非字面dynamic明确unknown', () => {
    const f = fixture(); f.pkg('packages/contracts', '@siren/contracts');
    f.write('packages/contracts/src/index.ts', 'export const x = 1;');
    f.write('scripts/main.ts', "import '@siren/contracts/private'; const path = './later.ts'; void import(path);");
    const result = f.run();
    expect(result.violations.some(x => x.includes('unresolved internal dependency: @siren/contracts/private'))).toBe(true);
    expect(result.warnings.some(x => x.includes('nonliteral dynamic dependency remains unknown'))).toBe(true);
  });
});
