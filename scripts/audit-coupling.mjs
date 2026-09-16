/**
 * 静态耦合与长度审计：node scripts/audit-coupling.mjs
 *
 * 阈值标准（两档制，>300 只提示复核，超过硬上限才判违规）：
 * - 文件 LOC：> 300 标记 ⚠ 复核；> 500 计入违规（常见工程上限）
 * - 函数长度：> 80 行计入违规（启发式解析类方法/顶层函数）
 * - 文件扇出：> 10 标记（组合根 app.ts / barrel index.ts / 测试工厂豁免）
 * - 包级循环依赖 / 分层规则违规：一律计入违规
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'dist', 'public', '.git', 'data', 'coverage']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|mjs)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function packageNameOf(file) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (rel.startsWith('packages/providers/')) return `@siren/provider-${rel.split('/')[2]}`;
  if (rel.startsWith('packages/')) return `@siren/${rel.split('/')[1]}`;
  if (rel.startsWith('apps/')) return `@siren/${rel.split('/')[1]}`;
  return 'root';
}

const IMPORT_RE =
  /import\s+(type\s+)?[\w$*{},\s]+?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

/** 返回 { spec, typeOnly }；import type 在运行时被擦除，不构成运行时耦合 */
function collectImports(source) {
  const specs = [];
  let match;
  const re = new RegExp(IMPORT_RE);
  while ((match = re.exec(source))) {
    const spec = match[2] ?? match[3] ?? match[4];
    if (spec) specs.push({ spec, typeOnly: Boolean(match[1]) });
  }
  return specs;
}

/** 启发式：类方法/顶层函数边界 -> 超长函数 */
function longFunctions(path, source, threshold) {
  const lines = source.split('\n');
  const starts = [];
  lines.forEach((line, index) => {
    // 类内方法（2 空格缩进）或顶层函数（0 缩进）
    if (/^ {2}(?:private |public |protected |override |readonly |async |static |get |set |\*)*\s*[A-Za-z_$][\w$]*(?:<[^>]*>)?\s*\(/.test(line) && !line.trim().startsWith('//')) {
      starts.push({ index, indent: 2, line: line.trim().slice(0, 90) });
    } else if (/^(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$]/.test(line)) {
      starts.push({ index, indent: 0, line: line.trim().slice(0, 90) });
    }
  });
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const current = starts[i];
    const next = starts[i + 1];
    // 函数体到下一个同级或更浅缩进的方法为止（近似）
    let end = next ? next.index : lines.length;
    if (next && next.indent > current.indent) end = current.index + 1; // 嵌套声明不算
    const length = end - current.index;
    if (length > threshold) {
      out.push({ path, start: current.index + 1, length, signature: current.line });
    }
  }
  return out;
}

// 分层规则：key 不得 import value 中的包（测试豁免）
const RULES = [
  ['@siren/contracts', ['@siren/'], 'contracts 不得依赖任何 workspace 包（只允许 zod）'],
  ['@siren/audio', ['@siren/contracts', '@siren/telemetry', '@siren/storage', '@siren/voice-core', '@siren/core-bridge', '@siren/provider'], 'audio 是底层工具包，不得依赖上层'],
  ['@siren/telemetry', ['@siren/audio', '@siren/storage', '@siren/voice-core', '@siren/core-bridge', '@siren/provider'], 'telemetry 不得依赖上层'],
  ['@siren/storage', ['@siren/voice-core', '@siren/core-bridge', '@siren/provider', '@siren/audio'], 'storage 不得依赖业务层'],
  ['@siren/core-bridge', ['@siren/voice-core', '@siren/storage', '@siren/provider', '@siren/audio'], 'core-bridge 不得依赖业务层'],
  ['@siren/provider-volc-asr', ['@siren/voice-core', '@siren/storage', '@siren/core-bridge', '@siren/provider-volc-tts', '@siren/provider-elevenlabs', '@siren/provider-mock'], 'provider 不得依赖业务层或互相依赖'],
  ['@siren/provider-volc-tts', ['@siren/voice-core', '@siren/storage', '@siren/core-bridge', '@siren/provider-volc-asr', '@siren/provider-elevenlabs', '@siren/provider-mock'], 'provider 不得依赖业务层或互相依赖'],
  ['@siren/provider-elevenlabs', ['@siren/voice-core', '@siren/storage', '@siren/core-bridge', '@siren/provider-volc-asr', '@siren/provider-volc-tts', '@siren/provider-mock'], 'provider 不得依赖业务层或互相依赖'],
  ['@siren/provider-mock', ['@siren/voice-core', '@siren/storage', '@siren/core-bridge', '@siren/provider-volc-asr', '@siren/provider-volc-tts', '@siren/provider-elevenlabs'], 'provider 不得依赖业务层或互相依赖'],
  ['@siren/server', ['@siren/provider-volc-asr', '@siren/provider-volc-tts', '@siren/provider-elevenlabs', '@siren/provider-mock'], 'server 不得直接依赖 Provider（必须经 voice-core 注册中心）']
];

// 职责性高扇出豁免名单（显示但计入结论时不算违规）：
// - app.ts 是组合根，装配全部模块是其职责
// - index.ts 是 barrel，只做 re-export
// - tests/helpers.ts 是测试工厂
const FANOUT_EXEMPT = new Set([
  'apps/server/src/app.ts',
  'packages/voice-core/src/index.ts',
  'tests/helpers.ts'
]);

const files = walk(ROOT);
const fileInfos = [];
const packageEdges = new Map(); // pkg -> Set(pkg)
const violations = [];

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const pkg = packageNameOf(file);
  const isTest = rel.startsWith('tests/');
  const imports = collectImports(source);
  const valueImports = [...new Set(imports.filter((i) => !i.typeOnly).map((i) => i.spec))];
  const workspaceImports = [...new Set(imports.map((i) => i.spec).filter((spec) => spec.startsWith('@siren/')))];
  const externalImports = valueImports.filter(
    (spec) => !spec.startsWith('@siren/') && !spec.startsWith('.') && !spec.startsWith('node:')
  );

  fileInfos.push({
    rel,
    pkg,
    loc: source.split('\n').length,
    fanOut: valueImports.length,
    workspaceImports,
    externalImports
  });

  // 包级边
  if (!packageEdges.has(pkg)) packageEdges.set(pkg, new Set());
  for (const target of workspaceImports) {
    if (target !== pkg) packageEdges.get(pkg).add(target);
  }

  // 分层违规（测试豁免：测试允许直接使用 provider mock）
  if (!isTest) {
    for (const [bannedPkg, patterns, message] of RULES) {
      if (pkg !== bannedPkg) continue;
      for (const target of workspaceImports) {
        if (patterns.some((p) => target === p || target.startsWith(p))) {
          violations.push(`${rel}: ${message}（发现 import ${target}）`);
        }
      }
    }
  }
}

// 循环依赖检测（DFS）
const CYCLES = [];
function dfs(node, stack, visited) {
  if (stack.includes(node)) {
    const cycle = stack.slice(stack.indexOf(node)).concat(node);
    CYCLES.push(cycle.join(' -> '));
    return;
  }
  if (visited.has(node)) return;
  visited.add(node);
  for (const next of packageEdges.get(node) ?? []) dfs(next, [...stack, node], visited);
}
dfs('@siren/server', [], new Set());

// ---- 输出 ----
console.log('== 文件数 / 总 LOC ==');
console.log(`源码文件 ${fileInfos.length} 个，总计 ${fileInfos.reduce((s, f) => s + f.loc, 0)} 行`);

console.log('\n== 最长文件（源码，>300 行标记 ⚠）==');
for (const f of [...fileInfos].sort((a, b) => b.loc - a.loc).slice(0, 12)) {
  console.log(`${String(f.loc).padStart(5)} 行  ${f.rel}${f.loc > 300 ? '  ⚠' : ''}`);
}

console.log('\n== 超长函数（> 80 行）==');
const longFns = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  longFns.push(...longFunctions(relative(ROOT, file).replace(/\\/g, '/'), source, 80));
}
if (longFns.length === 0) console.log('（无）');
for (const fn of longFns.sort((a, b) => b.length - a.length)) {
  console.log(`${String(fn.length).padStart(4)} 行  ${fn.path}:${fn.start}  ${fn.signature}`);
}

console.log('\n== 依赖扇出最高的文件（> 10 标记 ⚠ / ✱=职责豁免）==');
for (const f of [...fileInfos].sort((a, b) => b.fanOut - a.fanOut).slice(0, 10)) {
  const mark = FANOUT_EXEMPT.has(f.rel) ? '  ✱' : f.fanOut > 10 ? '  ⚠' : '';
  console.log(`${String(f.fanOut).padStart(3)} 个  ${f.rel}${mark}`);
}

console.log('\n== 包级依赖图（扇出） ==');
const fanIn = new Map();
for (const [_pkg, targets] of packageEdges) {
  for (const t of targets) fanIn.set(t, (fanIn.get(t) ?? 0) + 1);
}
for (const [currentPkg, targets] of [...packageEdges].sort()) {
  console.log(`${currentPkg} (${targets.size} 出 / ${fanIn.get(currentPkg) ?? 0} 入) -> ${[...targets].join(', ') || '-'}`);
}

console.log('\n== 包级循环依赖 ==');
if (CYCLES.length === 0) console.log('（无）');
for (const cycle of [...new Set(CYCLES)].slice(0, 5)) console.log(cycle);

console.log('\n== 分层违规 ==');
if (violations.length === 0) console.log('（无）');
for (const violation of violations) console.log(violation);

const problems =
  fileInfos.filter((f) => f.loc > 500).length +
  longFns.length +
  fileInfos.filter((f) => f.fanOut > 10 && !FANOUT_EXEMPT.has(f.rel)).length +
  violations.length +
  new Set(CYCLES).size;
console.log(`\n== 结论 == ${problems === 0 ? 'PASS（无超长文件/超长函数/高扇出/循环/违规）' : `发现 ${problems} 项待复核`}`);
process.exit(problems === 0 ? 0 : 1);
