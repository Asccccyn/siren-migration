/**
 * 静态耦合与长度审计（S1011-029 重写：TypeScript AST 版）：node scripts/audit-coupling.mjs
 *
 * 与旧版启发式正则的差异：
 * - 函数边界来自真实语法节点（含箭头函数/回调），不再是行启发式
 * - 依赖边来自 Import/Export 的 module specifier（含 type-only 与 re-export），
 *   动态 import() 与 require 一并收录；包名取各 package.json 的真实 name
 * - 循环依赖：文件级与包级全部强连通分量（Tarjan SCC）
 *
 * 阈值（两档制）：文件 LOC >300 ⚠ 复核、>500 违规；函数/回调 >80 行违规；
 * 文件扇出 >10 标记（组合根 app.ts / barrel index.ts / 测试工厂豁免）；
 * 文件/包级循环一律违规；providers 不得依赖 voice-core（分层规则）。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'dist', 'public', '.git', 'data', 'coverage']);
const FILE_LOC_WARN = 300;
const FILE_LOC_VIOLATION = 500;
const FUNC_LOC_VIOLATION = 80;
const FANOUT_FLAG = 10;
const FANOUT_EXEMPT = new Set([
  'apps/server/src/app.ts', // 组合根：装配即扇出
  'packages/voice-core/src/index.ts', // barrel
  'packages/contracts/src/index.ts', // barrel
  'packages/storage/src/index.ts', // barrel
  'packages/telemetry/src/index.ts', // barrel
  'packages/audio/src/index.ts', // barrel
  'packages/core-bridge/src/index.ts', // barrel
  'packages/provider-mock/src/index.ts', // barrel
  'packages/provider-volc-asr/src/index.ts', // barrel
  'packages/provider-volc-tts/src/index.ts', // barrel
  'packages/provider-elevenlabs-tts/src/index.ts', // barrel
  'tests/helpers.ts' // 测试工厂
]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|mts|mjs)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** 包名取自真实 package.json（S1011-029：不再拼路径猜名） */
function packageNameOf(file, cache) {
  if (cache.has(file)) return cache.get(file);
  let dir = dirname(file);
  let name = '(root)';
  while (dir.startsWith(ROOT)) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      try {
        name = JSON.parse(readFileSync(pj, 'utf8')).name ?? '(root)';
      } catch {
        /* 继续向上 */
      }
      break;
    }
    if (dir === ROOT) break;
    dir = dirname(dir);
  }
  cache.set(file, name);
  return name;
}

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
function endLineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

const files = walk(ROOT);
const rel = (f) => relative(ROOT, f).replace(/\\/g, '/');
const pkgNameCache = new Map();

/** @siren 包名 -> 入口 index.ts */
const pkgIndex = new Map();
for (const file of files) {
  if (file.endsWith('index.ts')) {
    const name = packageNameOf(file, pkgNameCache);
    if (name !== '(root)') pkgIndex.set(name, file);
  }
}

/** 解析 specifier -> 仓库内文件 */
function resolveSpecifier(fromFile, spec) {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const base = resolve(dirname(fromFile), spec);
    for (const cand of [`${base}.ts`, `${base}.mts`, `${base}.mjs`, base, join(base, 'index.ts')]) {
      if (existsSync(cand) && statSync(cand).isFile()) return cand;
    }
    return null;
  }
  if (spec.startsWith('@siren/')) return pkgIndex.get(spec) ?? null;
  return null;
}

const violations = [];
const warnings = [];
const edges = new Map();
const pkgEdges = new Map();

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const r = rel(file);

  const loc = sf.getLineStarts().length;
  if (loc > FILE_LOC_VIOLATION) violations.push(`${r}: 文件 ${loc} 行 > ${FILE_LOC_VIOLATION}`);
  else if (loc > FILE_LOC_WARN) warnings.push(`${r}: 文件 ${loc} 行 > ${FILE_LOC_WARN}（复核）`);

  const specs = [];
  const visit = (node) => {
    // 函数长度（真实语法节点，含回调）
    const isFunction =
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node);
    if (isFunction && node.body) {
      const len = endLineOf(sf, node) - lineOf(sf, node) + 1;
      if (len > FUNC_LOC_VIOLATION) {
        const name = node.name?.text ?? '(anonymous)';
        violations.push(`${r}:${lineOf(sf, node)} 函数 ${name} ${len} 行 > ${FUNC_LOC_VIOLATION}`);
      }
    }
    // 依赖边
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if ((callee === 'import' || callee === 'require') && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        specs.push(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const targets = new Set();
  for (const spec of specs) {
    const resolved = resolveSpecifier(file, spec);
    if (resolved) targets.add(resolved);
  }
  edges.set(file, targets);
  if (targets.size > FANOUT_FLAG && !FANOUT_EXEMPT.has(r)) {
    warnings.push(`${r}: 扇出 ${targets.size} > ${FANOUT_FLAG}（复核）`);
  }
  const fromPkg = packageNameOf(file, pkgNameCache);
  const pkgSet = pkgEdges.get(fromPkg) ?? new Set();
  for (const target of targets) pkgSet.add(packageNameOf(target, pkgNameCache));
  pkgEdges.set(fromPkg, pkgSet);
}

/** Tarjan SCC：全部强连通分量 */
function sccs(nodes, adjacency) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const low = new Map();
  const result = [];
  const strongconnect = (v) => {
    indices.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), indices.get(w)));
      }
    }
    if (low.get(v) === indices.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) result.push(comp);
    }
  };
  for (const v of nodes) if (!indices.has(v)) strongconnect(v);
  return result;
}

for (const comp of sccs(files, edges)) {
  violations.push(`文件级循环依赖: ${comp.map((f) => rel(f)).sort().join(' <-> ')}`);
}
for (const comp of sccs([...pkgEdges.keys()], pkgEdges)) {
  violations.push(`包级循环依赖: ${comp.sort().join(' <-> ')}`);
}

for (const [file, targets] of edges) {
  if (rel(file).startsWith('packages/providers/')) {
    for (const t of targets) {
      if (rel(t).startsWith('packages/voice-core/')) {
        violations.push(`分层违规: ${rel(file)} -> ${rel(t)}（provider 依赖 voice-core）`);
      }
    }
  }
}

console.log(`扫描 ${files.length} 个文件（TypeScript AST）\n`);
console.log('== 违规 ==');
console.log(violations.length ? violations.map((v) => `✗ ${v}`).join('\n') : '（无）');
console.log('\n== 复核提示 ==');
console.log(warnings.length ? warnings.map((v) => `⚠ ${v}`).join('\n') : '（无）');
console.log(`\n== 结论 == 发现 ${violations.length} 项违规，${warnings.length} 项待复核`);
process.exit(violations.length > 0 ? 1 : 0);
