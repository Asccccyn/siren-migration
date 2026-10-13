/**
 * AST audit: node scripts/audit-coupling.mjs [--json]
 * File >300 lines: review; >500 lines and function >80 lines: violation.
 * Fan-out >10: review, except app.ts, actual export barrels and tests/helpers.ts.
 * All file/package components are checked, including type-only, re-export and
 * literal dynamic edges. Nonliteral imports remain explicitly unknown.
 * Package entries come from package.json exports/main/types, never an arbitrary index.ts.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', 'dist', 'public', '.git', 'data', 'coverage']);
const rel = (file) => relative(ROOT, file).split(sep).join('/');
const files = [];
const packages = new Map();
const packageDirs = new Map();
const violations = [];
const warnings = [];
const dependencyEdges = [];
const graph = new Map();
const packageGraph = new Map();

function discover(dir) {
  const manifest = join(dir, 'package.json');
  if (existsSync(manifest)) {
    const json = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof json.name === 'string') {
      const pkg = { ...json, dir };
      if (packages.has(json.name)) violations.push(`duplicate package name: ${json.name}`);
      packages.set(json.name, pkg);
      packageDirs.set(dir, json.name);
    }
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) discover(full);
    else if (/\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(entry.name)) files.push(full);
  }
}
discover(ROOT);
const fileSet = new Set(files);

function packageOf(file) {
  let dir = dirname(file);
  while (dir === ROOT || dir.startsWith(ROOT + sep)) {
    if (packageDirs.has(dir)) return packageDirs.get(dir);
    if (dir === ROOT) break;
    dir = dirname(dir);
  }
  return '(root)';
}

const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, 'tsconfig.json');
const compilerOptions = configPath
  ? ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, ROOT).options
  : { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };

function exportTarget(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(exportTarget).find(Boolean);
  if (value && typeof value === 'object') {
    for (const key of ['types', 'import', 'node', 'default', 'require']) {
      const selected = exportTarget(value[key]);
      if (selected) return selected;
    }
  }
  return null;
}

function packageEntry(pkg, subpath) {
  const map = pkg.exports;
  if (map !== undefined) {
    const direct = typeof map === 'string' || Array.isArray(map) || !Object.keys(map ?? {}).some((key) => key.startsWith('.'));
    if (direct) return subpath === '.' ? exportTarget(map) : null;
    if (Object.hasOwn(map, subpath)) return exportTarget(map[subpath]);
    for (const key of Object.keys(map).filter((key) => key.includes('*')).sort((a, b) => b.length - a.length)) {
      const [prefix, suffix] = key.split('*');
      if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
        const match = subpath.slice(prefix.length, subpath.length - suffix.length || undefined);
        return exportTarget(map[key])?.replaceAll('*', match) ?? null;
      }
    }
    return null;
  }
  return subpath === '.' ? pkg.types ?? pkg.main ?? './index.ts' : subpath;
}

function localTarget(from, spec) {
  const resolved = ts.resolveModuleName(spec, from, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
  if (resolved && fileSet.has(resolve(resolved))) return resolve(resolved);
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.mts`, `${base}.js`, join(base, 'index.ts')]) {
    if (fileSet.has(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function resolveDependency(from, spec) {
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  const pkg = packages.get(name);
  if (pkg) {
    const subpath = spec === name ? '.' : `.${spec.slice(name.length)}`;
    const entry = packageEntry(pkg, subpath);
    if (!entry?.startsWith('./')) return null;
    return localTarget(join(pkg.dir, 'package.json'), entry);
  }
  return localTarget(from, spec);
}

function specsOf(sf) {
  const specs = [];
  const add = (node, kind, typeOnly = false) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      specs.push({ specifier: node.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, kind, typeOnly });
    } else warnings.push(`${rel(sf.fileName)}: nonliteral ${kind} dependency remains unknown`);
  };
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node.body) {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const length = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 2 - start;
      if (length > 80) violations.push(`${rel(sf.fileName)}:${start} 函数 ${node.name?.getText(sf) ?? '(anonymous)'} ${length} 行 > 80`);
    }
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause?.namedBindings;
      const namedTypes = bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 &&
        !node.importClause.name && bindings.elements.every((element) => element.isTypeOnly);
      add(node.moduleSpecifier, 'import', node.importClause?.isTypeOnly || !!namedTypes);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const namedTypes = node.exportClause && ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 && node.exportClause.elements.every((element) => element.isTypeOnly);
      add(node.moduleSpecifier, 'export', node.isTypeOnly || !!namedTypes);
    }
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal, 'import-type', true);
    else if (ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(node.arguments[0], 'dynamic');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

function layerViolation(from, to) {
  if (from === to || !from.startsWith('@siren/') || !to.startsWith('@siren/')) return false;
  const common = ['@siren/contracts', '@siren/audio', '@siren/telemetry'];
  if (from.startsWith('@siren/provider-')) return !common.includes(to);
  const allowed = {
    '@siren/contracts': [],
    '@siren/audio': ['@siren/contracts'],
    '@siren/telemetry': ['@siren/contracts'],
    '@siren/storage': ['@siren/contracts', '@siren/telemetry', '@siren/audio'],
    '@siren/core-bridge': ['@siren/contracts', '@siren/telemetry'],
    '@siren/web': ['@siren/contracts', '@siren/audio'],
    '@siren/server': ['@siren/contracts', '@siren/voice-core', '@siren/storage', '@siren/telemetry', '@siren/core-bridge']
  };
  if (from === '@siren/voice-core') return to === '@siren/server' || to === '@siren/web';
  return Object.hasOwn(allowed, from) && !allowed[from].includes(to);
}

function scan(file) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const diagnostic of sf.parseDiagnostics) {
    violations.push(`${rel(file)}: cannot parse source: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
  }
  const lines = sf.getLineStarts().length;
  if (lines > 500) violations.push(`${rel(file)}: 文件 ${lines} 行 > 500`);
  else if (lines > 300) warnings.push(`${rel(file)}: 文件 ${lines} 行 > 300（复核）`);
  const fromPackage = packageOf(file);
  const targets = new Set();
  const packageTargets = packageGraph.get(fromPackage) ?? new Set();
  for (const spec of specsOf(sf)) {
    const target = resolveDependency(file, spec.specifier);
    if (!target) {
      if (spec.specifier.startsWith('.') || spec.specifier.startsWith('@siren/')) {
        violations.push(`${rel(file)}:${spec.line} unresolved internal dependency: ${spec.specifier}`);
      }
      continue;
    }
    const toPackage = packageOf(target);
    targets.add(target);
    dependencyEdges.push({ from: rel(file), to: rel(target), ...spec, fromPackage, toPackage });
    if (fromPackage !== toPackage) packageTargets.add(toPackage);
    if (layerViolation(fromPackage, toPackage)) violations.push(`分层违规: ${rel(file)}:${spec.line} -> ${rel(target)} (${fromPackage} -> ${toPackage})`);
  }
  graph.set(file, targets);
  packageGraph.set(fromPackage, packageTargets);
  const barrel = /\/index\.[cm]?ts$/.test(file) && sf.statements.every((node) => ts.isExportDeclaration(node) || ts.isImportDeclaration(node));
  if (targets.size > 10 && !barrel && !['apps/server/src/app.ts', 'tests/helpers.ts'].includes(rel(file))) {
    warnings.push(`${rel(file)}: 扇出 ${targets.size} > 10（复核）`);
  }
}
for (const file of files) scan(file);

function sccs(nodes, adjacency) {
  let index = 0;
  const stack = [], onStack = new Set(), indices = new Map(), low = new Map(), result = [];
  const visit = (node) => {
    indices.set(node, index); low.set(node, index++); stack.push(node); onStack.add(node);
    for (const target of adjacency.get(node) ?? []) {
      if (!indices.has(target)) { visit(target); low.set(node, Math.min(low.get(node), low.get(target))); }
      else if (onStack.has(target)) low.set(node, Math.min(low.get(node), indices.get(target)));
    }
    if (low.get(node) === indices.get(node)) {
      const component = [];
      let target;
      do { target = stack.pop(); onStack.delete(target); component.push(target); } while (target !== node);
      if (component.length > 1 || adjacency.get(node)?.has(node)) result.push(component);
    }
  };
  for (const node of nodes) if (!indices.has(node)) visit(node);
  return result;
}

const fileCycles = sccs(files, graph).map((component) => component.map(rel));
const packageCycles = sccs([...packageGraph.keys()], packageGraph);
for (const cycle of fileCycles) violations.push(`文件级循环依赖: ${cycle.join(' <-> ')}`);
for (const cycle of packageCycles) violations.push(`包级循环依赖: ${cycle.join(' <-> ')}`);
const result = { files: files.length, edges: dependencyEdges, fileCycles, packageCycles, violations, warnings };
if (process.argv.includes('--json')) console.log(JSON.stringify(result));
else {
  console.log(`扫描 ${files.length} 个文件（TypeScript AST），${dependencyEdges.length} 条内部边`);
  console.log('\n== 违规 ==\n' + (violations.map((item) => `✗ ${item}`).join('\n') || '（无）'));
  console.log('\n== 复核提示 ==\n' + (warnings.map((item) => `⚠ ${item}`).join('\n') || '（无）'));
  console.log(`\n== 结论 == 发现 ${violations.length} 项违规，${warnings.length} 项待复核`);
}
process.exitCode = violations.length > 0 ? 1 : 0;
