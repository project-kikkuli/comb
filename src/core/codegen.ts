// codegen.ts — JavaScript code generator for verified Comb AST
// Emits readable ES module JavaScript targeting the Comb runtime API

import type {
  Module, Declaration, InputDecl, OutputDecl, SignalDecl, TokenDecl, CombDecl, CellDecl,
  ConstraintDecl, AlwaysBlock, ViewBlock, StyleBlock, EnumDecl, AssertDecl, TemporalAssertDecl, FnDecl,
  Statement, SignalAssign, IfStatement, ExprStatement, ReturnStmt, DestructureStmt, TryStmt,
  AsyncStmt, ConstDeclStmt, VNode, VElement, VText, VExpr, VIf, VFor,
  VComponent, VSlot, VAttr, Expr, SourceLoc,
} from './ast.js';
import type { StaticGraph } from './graph.js';

// --- Source Map Support ---

export interface SourceMapping {
  generatedLine: number;
  generatedColumn: number;
  originalLine: number;
  originalColumn: number;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeVLQ(value: number): string {
  let vlq = value < 0 ? ((-value) << 1) + 1 : value << 1;
  let encoded = '';
  do {
    let digit = vlq & 0x1f;
    vlq >>>= 5;
    if (vlq > 0) digit |= 0x20;
    encoded += BASE64[digit];
  } while (vlq > 0);
  return encoded;
}

export class SourceMapBuilder {
  private mappings: SourceMapping[] = [];

  addMapping(originalLine: number, originalColumn: number, generatedLine: number, generatedColumn: number) {
    this.mappings.push({ generatedLine, generatedColumn, originalLine, originalColumn });
  }

  getMappings(): SourceMapping[] {
    return [...this.mappings];
  }

  toJSON(sourceFile: string, sourceContent: string | null = null): object {
    return {
      version: 3,
      file: sourceFile.replace('.comb', '.js'),
      sources: [sourceFile],
      sourcesContent: [sourceContent],
      mappings: this.encodeMappings(),
    };
  }

  private encodeMappings(): string {
    // Sort by generated line, then column
    const sorted = [...this.mappings].sort((a, b) =>
      a.generatedLine !== b.generatedLine
        ? a.generatedLine - b.generatedLine
        : a.generatedColumn - b.generatedColumn
    );

    if (sorted.length === 0) return '';

    // Group by generated line
    const maxLine = sorted[sorted.length - 1].generatedLine;
    const byLine: SourceMapping[][] = [];
    for (let i = 0; i <= maxLine; i++) byLine.push([]);
    for (const m of sorted) byLine[m.generatedLine].push(m);

    let prevGenCol = 0;
    let prevOrigLine = 0;
    let prevOrigCol = 0;
    const sourceIndex = 0; // always 0, single source file

    const lineSegments: string[] = [];
    for (let line = 0; line <= maxLine; line++) {
      const mappingsOnLine = byLine[line];
      if (mappingsOnLine.length === 0) {
        lineSegments.push('');
        continue;
      }

      prevGenCol = 0; // reset per line
      const segments: string[] = [];
      for (const m of mappingsOnLine) {
        let segment = '';
        segment += encodeVLQ(m.generatedColumn - prevGenCol);
        segment += encodeVLQ(0); // source index delta (always 0)
        segment += encodeVLQ(m.originalLine - prevOrigLine);
        segment += encodeVLQ(m.originalColumn - prevOrigCol);
        prevGenCol = m.generatedColumn;
        prevOrigLine = m.originalLine;
        prevOrigCol = m.originalColumn;
        segments.push(segment);
      }
      lineSegments.push(segments.join(','));
    }

    return lineSegments.join(';');
  }
}

// --- Annotated Line: a generated line + optional source location ---

interface AnnotatedLine {
  text: string;
  loc?: SourceLoc; // original source location, if known
}

interface GenContext {
  moduleName: string;
  signals: Set<string>;
  combs: Set<string>;
  cells: Set<string>;
  params: Set<string>;
  inputs: Set<string>;
  outputs: Set<string>;
  enums: Map<string, string[]>;
  userFunctions: Set<string>;
  indent: number;
  elCount: number;
  txtCount: number;
  assertCount: number;
  temporalCount: number;
  scopeHash: string;
  hasStyle: boolean;
  constraintLocals?: Map<string, string>;
}

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 5);
}

function createContext(mod: Module): GenContext {
  const ctx: GenContext = {
    moduleName: mod.name,
    signals: new Set(),
    combs: new Set(),
    cells: new Set(),
    params: new Set(),
    inputs: new Set(),
    outputs: new Set(),
    enums: new Map(),
    userFunctions: new Set(),
    indent: 1,
    elCount: 0,
    txtCount: 0,
    assertCount: 0,
    temporalCount: 0,
    scopeHash: simpleHash(mod.name),
    hasStyle: mod.body.some(d => d.kind === 'style'),
  };
  for (const decl of mod.body) {
    if (decl.kind === 'input') { ctx.inputs.add(decl.name); ctx.signals.add(decl.name); }
    if (decl.kind === 'output') { ctx.outputs.add(decl.name); ctx.signals.add(decl.name); }
    if (decl.kind === 'signal') ctx.signals.add(decl.name);
    if (decl.kind === 'token') ctx.signals.add(decl.name); // tokens are reactive signals
    if (decl.kind === 'cell') { ctx.cells.add(decl.name); ctx.signals.add(decl.name); } // cells are reactive
    if (decl.kind === 'comb') ctx.combs.add(decl.name);
    if (decl.kind === 'enum') ctx.enums.set(decl.name, decl.variants);
    if (decl.kind === 'fn') ctx.userFunctions.add(decl.name);
  }
  for (const p of mod.params) ctx.params.add(p.name);
  return ctx;
}

function hasStyleBlock(ctx: GenContext): boolean { return ctx.hasStyle; }
function ind(ctx: GenContext): string { return '  '.repeat(ctx.indent); }
function nextEl(ctx: GenContext): string { return `el${ctx.elCount++}`; }
function nextTxt(ctx: GenContext): string { return `txt${ctx.txtCount++}`; }
function capitalize(s: string): string { return s[0].toUpperCase() + s.slice(1); }
function escapeStr(s: string): string { return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n'); }

function viewHasSlot(vnodes: VNode[]): boolean {
  for (const vn of vnodes) {
    if (vn.kind === 'vslot') return true;
    if (vn.kind === 'element' && viewHasSlot(vn.children)) return true;
    if (vn.kind === 'component' && viewHasSlot(vn.children)) return true;
    if (vn.kind === 'if') {
      if (viewHasSlot(vn.then)) return true;
      if (vn.else_ && viewHasSlot(vn.else_)) return true;
    }
    if (vn.kind === 'for' && viewHasSlot(vn.body)) return true;
  }
  return false;
}

export interface GenerateResult {
  code: string;
  sourceMap: SourceMapBuilder;
}

export function generate(mod: Module, graph: StaticGraph): string {
  return generateWithSourceMap(mod, graph).code;
}

export function generateWithSourceMap(mod: Module, graph: StaticGraph): GenerateResult {
  const ctx = createContext(mod);
  const alines: AnnotatedLine[] = [];

  // Helper to push annotated lines
  function pushLine(text: string, loc?: SourceLoc) {
    alines.push({ text, loc });
  }
  function pushLines(lines: string[], loc?: SourceLoc) {
    for (const l of lines) alines.push({ text: l, loc });
  }

  // Imports
  const hasCells = mod.body.some(d => d.kind === 'cell');
  const hasConstraints = mod.body.some(d => d.kind === 'constraint');
  const hasEdgeTriggers = mod.body.some(d => d.kind === 'always' && (d.triggerKind === 'posedge' || d.triggerKind === 'negedge'));
  function exprContainsEdgeCount(expr: Expr): boolean {
    if (expr.kind === 'call' && expr.callee.kind === 'identifier' && (expr.callee.name === 'edgeCount' || expr.callee.name === 'negedgeCount' || expr.callee.name === 'changeCount')) return true;
    if (expr.kind === 'binary') return exprContainsEdgeCount(expr.left) || exprContainsEdgeCount(expr.right);
    if (expr.kind === 'unary') return exprContainsEdgeCount(expr.operand);
    if (expr.kind === 'ternary') return exprContainsEdgeCount(expr.condition) || exprContainsEdgeCount(expr.then) || exprContainsEdgeCount(expr.else_);
    return false;
  }
  const hasEdgeCounters = mod.body.some(d => d.kind === 'comb' && exprContainsEdgeCount(d.expr));
  const hasTemporalAsserts = mod.body.some(d => d.kind === 'temporal_assert');
  const hasKeyedFor = hasKeyedForDirective(mod);
  const importParts = ['createSignal', 'createComb', 'createEffect', 'batch', 'createScope', 'circuit', 'X'];
  if (hasCells) importParts.push('createCell');
  if (hasConstraints) importParts.push('createPropagator');
  if (hasEdgeTriggers) { importParts.push('createEdgeEffect'); importParts.push('deferredBatch'); }
  if (hasEdgeCounters) {
    importParts.push('createEdgeCounter');
    // Also check for changeCount specifically
    const hasChangeCounters = mod.body.some(d => d.kind === 'comb' && JSON.stringify(d).includes('changeCount'));
    if (hasChangeCounters) importParts.push('createChangeCounter');
  }
  if (hasTemporalAsserts) importParts.push('createTemporalAssert');
  if (hasKeyedFor) importParts.push('reconcileKeyed');
  pushLine(`import { ${importParts.join(', ')} } from '../runtime/index.js';`);

  // Conditional color utility import
  const colorBuiltins = ['rgbToHsv', 'hsvToRgb', 'rgbToHex'];
  const src = JSON.stringify(mod);
  const usedColorFns = colorBuiltins.filter(fn => src.includes(fn));
  if (usedColorFns.length > 0) {
    pushLine(`import { ${usedColorFns.join(', ')} } from '../runtime/color.js';`);
  }
  pushLine('');

  // Static graph export
  const graphJson = JSON.stringify(graph, null, 2);
  const graphLines = `export const __graph = ${graphJson};`.split('\n');
  for (const gl of graphLines) pushLine(gl);
  pushLine('');

  // Module factory function
  const hasInputs = ctx.inputs.size > 0;
  const hasOutputs = ctx.outputs.size > 0;
  const hasPorts = hasInputs || hasOutputs;
  const paramNames = mod.params.map(p => p.name);

  // Check if module uses <slot /> — if so, accept __children parameter
  const hasSlot = mod.body.some(d => d.kind === 'view' && viewHasSlot(d.children));

  // Build signature: ModuleName(__props, root, __children?) or ModuleName(root, __children?)
  let sigParts: string[] = [];
  if (paramNames.length > 0) sigParts.push(`{ ${paramNames.join(', ')} }`);
  if (hasPorts) sigParts.push('__props');
  sigParts.push('root');
  if (hasSlot) sigParts.push('__children');
  pushLine(`export function ${mod.name}(${sigParts.join(', ')}) {`, mod.loc);
  if (hasPorts) pushLine(`  if (!__props) __props = {};`);
  pushLine(`  const $m = '${mod.name}';`);
  pushLine(`  circuit.loadStaticGraph(__graph);`);
  pushLine(`  const __scope = createScope();`);
  pushLine('');

  for (const decl of mod.body) {
    const declLines = emitDecl(decl, ctx);
    for (const l of declLines) pushLine(l, decl.loc);
    pushLine('');
  }

  // Build return with ports
  if (hasPorts) {
    const portEntries: string[] = [];
    for (const name of ctx.inputs) {
      portEntries.push(`${name}: { set: set${capitalize(name)} }`);
    }
    for (const name of ctx.outputs) {
      portEntries.push(`${name}: { get: ${name}, set: set${capitalize(name)} }`);
    }
    pushLine(`  return { dispose: __scope.dispose, __ports: { ${portEntries.join(', ')} } };`);
  } else {
    pushLine('  return { dispose: __scope.dispose };');
  }
  pushLine('}');
  pushLine('');

  // __test export — headless factory with signal/comb access, no view
  pushLine(`export function __test() {`);
  pushLine(`  const $m = '${mod.name}';`);
  pushLine(`  circuit.loadStaticGraph(__graph);`);
  pushLine(`  const __scope = createScope();`);
  pushLine('');

  const signalNames: string[] = [];
  const combNames: string[] = [];
  const eventNames: string[] = [];
  const testCtx = { ...ctx, indent: 1, elCount: 0, txtCount: 0, assertCount: 0 };

  for (const decl of mod.body) {
    if (decl.kind === 'input' || decl.kind === 'output' || decl.kind === 'signal' || decl.kind === 'token' || decl.kind === 'comb' || decl.kind === 'cell' || decl.kind === 'constraint' || decl.kind === 'enum' || decl.kind === 'assert' || decl.kind === 'temporal_assert' || decl.kind === 'fn' || decl.kind === 'always') {
      const declLines = emitDecl(decl, testCtx);
      for (const l of declLines) pushLine(l, decl.loc);
      pushLine('');
      if (decl.kind === 'signal' || decl.kind === 'token' || decl.kind === 'input' || decl.kind === 'output' || decl.kind === 'cell') signalNames.push(decl.name);
      if (decl.kind === 'comb') combNames.push(decl.name);
      if (decl.kind === 'always' && decl.triggerKind === 'event') eventNames.push(decl.trigger.name);
    }
  }

  // Build return object
  const signalEntries = signalNames.map(n => `${n}: { get: ${n}, set: set${capitalize(n)} }`).join(', ');
  const combEntries = combNames.map(n => `${n}`).join(', ');
  pushLine(`  return {`);
  pushLine(`    signals: { ${signalEntries} },`);
  pushLine(`    combs: { ${combEntries} },`);
  pushLine(`    events: { ${eventNames.join(', ')} },`);
  pushLine(`    dispose: __scope.dispose,`);
  pushLine(`  };`);
  pushLine('}');

  // Build source map from annotated lines
  const smb = new SourceMapBuilder();
  for (let i = 0; i < alines.length; i++) {
    const al = alines[i];
    if (al.loc) {
      // Original lines are 1-based in the AST, source maps use 0-based
      const origLine = al.loc.line - 1;
      const origCol = al.loc.column - 1;
      const genCol = al.text.length - al.text.trimStart().length; // leading whitespace = column
      smb.addMapping(origLine, origCol, i, genCol);
    }
  }

  return {
    code: alines.map(al => al.text).join('\n'),
    sourceMap: smb,
  };
}

// Declarations

function emitDecl(decl: Declaration, ctx: GenContext): string[] {
  switch (decl.kind) {
    case 'input': return emitInput(decl, ctx);
    case 'output': return emitOutput(decl, ctx);
    case 'signal': return emitSignal(decl, ctx);
    case 'token': return emitToken(decl, ctx);
    case 'comb': return emitComb(decl, ctx);
    case 'always': return emitAlways(decl, ctx);
    case 'view': return emitView(decl, ctx);
    case 'style': return emitStyle(decl, ctx);
    case 'enum': return emitEnum(decl, ctx);
    case 'cell': return emitCell(decl, ctx);
    case 'constraint': return emitConstraint(decl, ctx);
    case 'assert': return emitAssert(decl, ctx);
    case 'temporal_assert': return emitTemporalAssert(decl, ctx);
    case 'fn': return emitFnDecl(decl, ctx);
  }
}

function emitInput(decl: InputDecl, ctx: GenContext): string[] {
  const i = ind(ctx);
  const init = decl.initial ? emitExpr(decl.initial, ctx) : 'undefined';
  const setter = 'set' + capitalize(decl.name);
  return [`${i}const [${decl.name}, ${setter}] = createSignal(__props.${decl.name} ?? ${init}, { name: '${decl.name}', module: $m });`];
}

function emitOutput(decl: OutputDecl, ctx: GenContext): string[] {
  const i = ind(ctx);
  const init = decl.initial ? emitExpr(decl.initial, ctx) : 'undefined';
  const setter = 'set' + capitalize(decl.name);
  return [`${i}const [${decl.name}, ${setter}] = createSignal(__props.${decl.name} ?? ${init}, { name: '${decl.name}', module: $m });`];
}

function emitSignal(decl: SignalDecl, ctx: GenContext): string[] {
  const i = ind(ctx);
  const init = emitExpr(decl.initial, ctx);
  const setter = 'set' + capitalize(decl.name);

  if (decl.type && decl.type.kind === 'range') {
    const { base, min, max } = decl.type;
    const meta = `{ name: '${decl.name}', module: $m, type: '${base}' }`;
    const rawSetter = `__rawSet${capitalize(decl.name)}`;
    const clamp = base === 'int'
      ? `(v) => ${rawSetter}(Math.max(${min}, Math.min(${max}, typeof v === 'number' ? Math.round(v) : v)))`
      : `(v) => ${rawSetter}(Math.max(${min}, Math.min(${max}, v)))`;
    return [
      `${i}const [${decl.name}, ${rawSetter}] = createSignal(${init}, ${meta});`,
      `${i}const ${setter} = ${clamp};`,
    ];
  }

  const typeName = decl.type?.kind === 'simple' ? decl.type.name : undefined;
  const meta = typeName
    ? `{ name: '${decl.name}', module: $m, type: '${typeName}' }`
    : `{ name: '${decl.name}', module: $m }`;
  return [`${i}const [${decl.name}, ${setter}] = createSignal(${init}, ${meta});`];
}

function emitToken(decl: TokenDecl, ctx: GenContext): string[] {
  const i = ind(ctx);
  const init = emitExpr(decl.initial, ctx);
  const setter = 'set' + capitalize(decl.name);
  const typeName = decl.type?.kind === 'simple' ? decl.type.name : undefined;
  const meta = typeName
    ? `{ name: '${decl.name}', module: $m, type: '${typeName}' }`
    : `{ name: '${decl.name}', module: $m }`;
  const cssVar = `--${decl.name.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
  return [
    `${i}const [${decl.name}, ${setter}] = createSignal(${init}, ${meta});`,
    `${i}createEffect(() => {`,
    `${i}  document.documentElement.style.setProperty('${cssVar}', String(${decl.name}()));`,
    `${i}}, { name: 'token:${decl.name}', module: $m });`,
  ];
}

function emitComb(decl: CombDecl, ctx: GenContext): string[] {
  const i = ind(ctx);
  // Hoist any edgeCount()/negedgeCount() calls to top-level createEdgeCounter declarations
  const hoisted: string[] = [];
  let counterIdx = 0;
  function hoistEdgeCounters(expr: Expr): Expr {
    if (expr.kind === 'call' && expr.callee.kind === 'identifier'
        && (expr.callee.name === 'edgeCount' || expr.callee.name === 'negedgeCount' || expr.callee.name === 'changeCount')
        && expr.args.length === 1) {
      const name = `__ec_${decl.name}_${counterIdx++}`;
      const arg = emitExpr(expr.args[0], ctx);
      if (expr.callee.name === 'changeCount') {
        hoisted.push(`${i}const ${name} = createChangeCounter(() => ${arg}, { name: '${name}', module: $m });`);
      } else {
        const edge = expr.callee.name === 'edgeCount' ? 'posedge' : 'negedge';
        hoisted.push(`${i}const ${name} = createEdgeCounter(() => ${arg}, '${edge}', { name: '${name}', module: $m });`);
      }
      return { kind: 'identifier', name, loc: expr.loc } as any;
    }
    if (expr.kind === 'binary') {
      return { ...expr, left: hoistEdgeCounters(expr.left), right: hoistEdgeCounters(expr.right) };
    }
    if (expr.kind === 'unary') {
      return { ...expr, operand: hoistEdgeCounters(expr.operand) };
    }
    if (expr.kind === 'ternary') {
      return { ...expr, condition: hoistEdgeCounters((expr as any).condition), then: hoistEdgeCounters((expr as any).then), else_: hoistEdgeCounters((expr as any).else_) };
    }
    return expr;
  }
  const processed = hoistEdgeCounters(decl.expr);
  if (hoisted.length > 0) {
    // Add hoisted counter names to signals set so emitExpr calls them with ()
    for (let ci = 0; ci < counterIdx; ci++) {
      ctx.signals.add(`__ec_${decl.name}_${ci}`);
    }
    const exprCode = emitExpr(processed, ctx);
    const depsArr = JSON.stringify(decl.deps);
    return [...hoisted, `${i}const ${decl.name} = createComb(() => ${exprCode}, { name: '${decl.name}', module: $m, deps: ${depsArr} });`];
  }
  const expr = emitExpr(decl.expr, ctx);
  const depsArr = JSON.stringify(decl.deps);
  return [`${i}const ${decl.name} = createComb(() => ${expr}, { name: '${decl.name}', module: $m, deps: ${depsArr} });`];
}

function emitCell(decl: CellDecl, ctx: GenContext): string[] {
  const i = ind(ctx);
  const init = emitExpr(decl.initial, ctx);
  const setter = 'set' + capitalize(decl.name);
  return [`${i}const [${decl.name}, ${setter}] = createCell(${init}, { name: '${decl.name}', module: $m });`];
}

function emitConstraint(decl: ConstraintDecl, ctx: GenContext): string[] {
  const i = ind(ctx);
  const lines: string[] = [];
  for (let ci = 0; ci < decl.clauses.length; ci++) {
    const clause = decl.clauses[ci];
    // Build constraint locals map: input name → local variable name
    const constraintLocals = new Map<string, string>();
    for (const inp of clause.inputs) {
      constraintLocals.set(inp, `__${inp}`);
    }

    // Extract writes from clause body
    const clauseWrites = new Set<string>();
    for (const stmt of clause.body) {
      collectStmtWrites(stmt, clauseWrites);
    }
    const writesArr = [...clauseWrites];

    lines.push(`${i}createPropagator(() => {`);
    lines.push(`${i}  // Read inputs: ${clause.inputs.join(', ')}`);
    for (const inp of clause.inputs) {
      lines.push(`${i}  const __${inp} = ${inp}();`);
    }
    lines.push(`${i}  batch(() => {`);
    const savedIndent = ctx.indent;
    const savedLocals = ctx.constraintLocals;
    ctx.indent += 2;
    ctx.constraintLocals = constraintLocals;
    for (const stmt of clause.body) lines.push(...emitStmt(stmt, ctx));
    ctx.constraintLocals = savedLocals;
    ctx.indent = savedIndent;
    lines.push(`${i}  });`);
    const writesStr = writesArr.length > 0 ? `, writes: [${writesArr.map(w => `'${w}'`).join(', ')}]` : '';
    lines.push(`${i}}, { name: '${decl.name}:${ci}', module: $m, deps: [${clause.inputs.map(inp => `'${inp}'`).join(', ')}]${writesStr} });`);
  }
  return lines;
}

function collectStmtWrites(stmt: Statement, writes: Set<string>): void {
  if (stmt.kind === 'assign' && stmt.target.kind === 'identifier') {
    writes.add(stmt.target.name);
  }
  if (stmt.kind === 'if') {
    for (const s of stmt.then) collectStmtWrites(s, writes);
    if (stmt.else_) for (const s of stmt.else_) collectStmtWrites(s, writes);
  }
}

function emitEnum(decl: EnumDecl, ctx: GenContext): string[] {
  const i = ind(ctx);
  const lines = [`${i}const ${decl.name} = Object.freeze({`];
  for (const v of decl.variants) {
    lines.push(`${i}  ${v}: '${decl.name}.${v}',`);
  }
  lines.push(`${i}});`);
  return lines;
}

function emitAlways(decl: AlwaysBlock, ctx: GenContext): string[] {
  const i = ind(ctx);

  // Edge-triggered: compile to createEdgeEffect
  if ((decl.triggerKind === 'posedge' || decl.triggerKind === 'negedge') && decl.edgeExpr) {
    const edgeName = decl.edgeExpr.kind === 'identifier' ? decl.edgeExpr.name : 'expr';
    const exprCode = emitExpr(decl.edgeExpr, ctx);
    const lines = [
      `${i}createEdgeEffect(() => ${exprCode}, '${decl.triggerKind}', () => {`,
      `${i}  deferredBatch(() => {`,
    ];
    ctx.indent += 2;
    for (const stmt of decl.body) lines.push(...emitStmt(stmt, ctx));
    ctx.indent -= 2;
    lines.push(`${i}  });`);
    lines.push(`${i}}, { name: '${decl.triggerKind}_${edgeName}', module: $m });`);
    return lines;
  }

  // Sensitivity-triggered: compile to createEffect
  if (decl.triggerKind === 'sensitivity' && decl.trigger.signals) {
    const signals = decl.trigger.signals;
    const sensName = `sense_${signals.join('_')}`;
    const lines = [
      `${i}createEffect(() => {`,
      `${i}  // Read sensitivity deps`,
    ];
    for (const sig of signals) {
      lines.push(`${i}  const __${sig} = ${sig}();`);
    }
    lines.push(`${i}  batch(() => {`);
    ctx.indent += 2;
    for (const stmt of decl.body) lines.push(...emitStmt(stmt, ctx));
    ctx.indent -= 2;
    lines.push(`${i}  });`);
    lines.push(`${i}}, { name: '${sensName}', module: $m });`);
    return lines;
  }

  // Event-triggered: compile to named function
  const name = decl.trigger.name;
  const params = decl.trigger.params;
  const paramList = params.length > 0 ? params.join(', ') : '';
  const lines = [
    `${i}function ${name}(${paramList}) {`,
    `${i}  batch(() => {`,
  ];
  ctx.indent += 2;
  for (const stmt of decl.body) lines.push(...emitStmt(stmt, ctx));
  ctx.indent -= 2;
  lines.push(`${i}  });`);
  lines.push(`${i}}`);
  return lines;
}

function emitAssert(decl: AssertDecl, ctx: GenContext): string[] {
  const i = ind(ctx);
  const idx = ctx.assertCount++;
  const assertId = `assert:${idx}`;
  const exprStr = emitExpr(decl.expr, ctx);
  const exprSource = exprStr.replace(/\(\)/g, '');
  const valuesEntries = decl.deps.map(d => `${d}: ${d}()`).join(', ');
  return [
    `${i}createEffect(() => {`,
    `${i}  const __ok = ${exprStr};`,
    `${i}  if (!__ok) {`,
    `${i}    circuit.assertionFailed('${assertId}', {`,
    `${i}      expr: '${escapeStr(exprSource)}',`,
    `${i}      module: $m,`,
    `${i}      values: { ${valuesEntries} },`,
    `${i}    });`,
    `${i}  }`,
    `${i}}, { name: '${assertId}', module: $m });`,
  ];
}

function emitTemporalAssert(decl: TemporalAssertDecl, ctx: GenContext): string[] {
  const i = ind(ctx);
  const idx = ctx.temporalCount++;
  const triggerExpr = emitExpr(decl.trigger, ctx);
  const propertyExpr = emitExpr(decl.property, ctx);
  const durationStr = decl.duration !== undefined ? `, duration: ${decl.duration}` : '';
  // Build a descriptive label: "posedge(trigger) → operator(property) within N"
  const triggerLabel = emitExpr(decl.trigger, ctx).replace(/\(\)/g, '');
  const propLabel = emitExpr(decl.property, ctx).replace(/\(\)/g, '');
  const edgeLabel = decl.triggerEdge === 'negedge' ? 'negedge' : 'posedge';
  const withinLabel = decl.duration !== undefined ? ` within ${decl.duration}` : '';
  const temporalId = `${edgeLabel}(${escapeStr(triggerLabel)}) ${decl.operator}(${escapeStr(propLabel)})${withinLabel}`;
  return [
    `${i}createTemporalAssert(`,
    `${i}  () => ${triggerExpr},`,
    `${i}  '${decl.operator}',`,
    `${i}  () => ${propertyExpr},`,
    `${i}  { name: '${temporalId}', module: $m${durationStr}, edge: '${edgeLabel}' }`,
    `${i});`,
  ];
}

function emitFnDecl(decl: FnDecl, ctx: GenContext): string[] {
  const i = ind(ctx);
  const paramNames = decl.params.map(p => p.name).join(', ');
  const lines = [`${i}function ${decl.name}(${paramNames}) {`];
  ctx.indent++;
  // Emit body statements. The last expression statement gets an implicit return.
  for (let si = 0; si < decl.body.length; si++) {
    const stmt = decl.body[si];
    const isLast = si === decl.body.length - 1;
    if (isLast && stmt.kind === 'expr_stmt') {
      // Implicit return for last expression statement
      lines.push(`${ind(ctx)}return ${emitExpr(stmt.expr, ctx)};`);
    } else {
      lines.push(...emitStmt(stmt, ctx));
    }
  }
  ctx.indent--;
  lines.push(`${i}}`);
  return lines;
}
// Statements

function emitStmt(stmt: Statement, ctx: GenContext): string[] {
  switch (stmt.kind) {
    case 'assign': return emitAssign(stmt, ctx);
    case 'if': return emitIf(stmt, ctx);
    case 'expr_stmt': return [`${ind(ctx)}${emitExpr(stmt.expr, ctx)};`];
    case 'return': return emitReturn(stmt, ctx);
    case 'destructure': return emitDestructure(stmt, ctx);
    case 'try': return emitTry(stmt, ctx);
    case 'async': return emitAsync(stmt, ctx);
    case 'const_decl': return emitConstDecl(stmt, ctx);
  }
}

function emitAssign(stmt: SignalAssign, ctx: GenContext): string[] {
  const i = ind(ctx);
  const value = emitExpr(stmt.value, ctx);

  if (stmt.target.kind === 'identifier') {
    return [`${i}set${capitalize(stmt.target.name)}(${value});`];
  }

  if (stmt.target.kind === 'index') {
    const { base, indices } = flattenIndex(stmt.target);
    if (base.kind === 'identifier') {
      const setter = 'set' + capitalize(base.name);
      const tmpVar = `__tmp${ctx.elCount++}`;
      const lines = [`${i}const ${tmpVar} = JSON.parse(JSON.stringify(${base.name}()));`];
      let access = tmpVar;
      for (const idx of indices) access += `[${emitExpr(idx, ctx)}]`;
      lines.push(`${i}${access} = ${value};`);
      lines.push(`${i}${setter}(${tmpVar});`);
      return lines;
    }
  }

  const target = emitExpr(stmt.target, ctx);
  return [`${i}${target} = ${value};`];
}

function emitIf(stmt: IfStatement, ctx: GenContext): string[] {
  const i = ind(ctx);
  const lines = [`${i}if (${emitExpr(stmt.condition, ctx)}) {`];
  ctx.indent++;
  for (const s of stmt.then) lines.push(...emitStmt(s, ctx));
  ctx.indent--;
  if (stmt.else_ && stmt.else_.length > 0) {
    if (stmt.else_.length === 1 && stmt.else_[0].kind === 'if') {
      lines.push(`${i}} else {`);
      ctx.indent++;
      lines.push(...emitStmt(stmt.else_[0], ctx));
      ctx.indent--;
      lines.push(`${i}}`);
    } else {
      lines.push(`${i}} else {`);
      ctx.indent++;
      for (const s of stmt.else_) lines.push(...emitStmt(s, ctx));
      ctx.indent--;
      lines.push(`${i}}`);
    }
  } else {
    lines.push(`${i}}`);
  }
  return lines;
}

function emitReturn(stmt: ReturnStmt, ctx: GenContext): string[] {
  const i = ind(ctx);
  if (stmt.value) {
    return [`${i}return ${emitExpr(stmt.value, ctx)};`];
  }
  return [`${i}return;`];
}

function emitDestructure(stmt: DestructureStmt, ctx: GenContext): string[] {
  const i = ind(ctx);
  const value = emitExpr(stmt.value, ctx);
  if (stmt.pattern.kind === 'object') {
    const fields = stmt.pattern.fields.map(f => f.alias ? `${f.key}: ${f.alias}` : f.key).join(', ');
    return [`${i}const { ${fields} } = ${value};`];
  } else {
    const elements = [...stmt.pattern.elements];
    if (stmt.pattern.rest) elements.push(`...${stmt.pattern.rest}`);
    return [`${i}const [${elements.join(', ')}] = ${value};`];
  }
}

function emitTry(stmt: TryStmt, ctx: GenContext): string[] {
  const i = ind(ctx);
  const catchParam = stmt.catchParam || '__err';
  const lines = [`${i}try {`];
  ctx.indent++;
  for (const s of stmt.body) lines.push(...emitStmt(s, ctx));
  ctx.indent--;
  lines.push(`${i}} catch (${catchParam}) {`);
  ctx.indent++;
  for (const s of stmt.catchBody) lines.push(...emitStmt(s, ctx));
  ctx.indent--;
  lines.push(`${i}}`);
  return lines;
}

function emitAsync(stmt: AsyncStmt, ctx: GenContext): string[] {
  const i = ind(ctx);
  const lines: string[] = [];
  if (stmt.catchBody && stmt.catchBody.length > 0) {
    lines.push(`${i}(async () => {`);
    lines.push(`${i}  try {`);
    ctx.indent += 2;
    for (const s of stmt.body) lines.push(...emitAsyncBodyStmt(s, ctx));
    ctx.indent -= 2;
    lines.push(`${i}  } catch (__err) {`);
    lines.push(`${i}    batch(() => {`);
    ctx.indent += 3;
    for (const s of stmt.catchBody) lines.push(...emitStmt(s, ctx));
    ctx.indent -= 3;
    lines.push(`${i}    });`);
    lines.push(`${i}  }`);
    lines.push(`${i}})();`);
  } else {
    lines.push(`${i}(async () => {`);
    ctx.indent += 1;
    for (const s of stmt.body) lines.push(...emitAsyncBodyStmt(s, ctx));
    ctx.indent -= 1;
    lines.push(`${i}})();`);
  }
  return lines;
}

// Emit statements inside async blocks. Signal assignments are wrapped in batch().
function emitAsyncBodyStmt(stmt: Statement, ctx: GenContext): string[] {
  if (stmt.kind === 'assign') {
    const i = ind(ctx);
    return [
      `${i}batch(() => {`,
      ...emitStmt(stmt, { ...ctx, indent: ctx.indent + 1 }),
      `${i}});`,
    ];
  }
  if (stmt.kind === 'const_decl') return emitConstDecl(stmt, ctx);
  if (stmt.kind === 'expr_stmt') return emitStmt(stmt, ctx);
  if (stmt.kind === 'if') return emitStmt(stmt, ctx);
  if (stmt.kind === 'async') return emitStmt(stmt, ctx);
  return emitStmt(stmt, ctx);
}

function emitConstDecl(stmt: ConstDeclStmt, ctx: GenContext): string[] {
  const i = ind(ctx);
  return [`${i}const ${stmt.name} = ${emitExpr(stmt.init, ctx)};`];
}
// View

function emitView(decl: ViewBlock, ctx: GenContext): string[] {
  const lines: string[] = [];
  for (const child of decl.children) lines.push(...emitVNode(child, 'root', ctx, 'root'));
  return lines;
}

function getVElementDesc(node: VElement, ctx: GenContext): string {
  let desc = node.tag;
  for (const attr of node.attrs) {
    if (attr.name === 'id' && attr.value?.kind === 'literal' && attr.value.type === 'string') {
      return `${desc}#${attr.value.value}`;
    }
    if (attr.name === 'class' && attr.value?.kind === 'literal' && attr.value.type === 'string') {
      const cls = String(attr.value.value).split(/\s+/)[0];
      if (cls) desc += `.${cls}`;
    }
  }
  return desc;
}

function primaryReactiveNameFromExpr(expr: Expr, ctx: GenContext): string {
  if (expr.kind === 'identifier' && (ctx.signals.has(expr.name) || ctx.combs.has(expr.name))) return expr.name;
  if (expr.kind === 'binary') return primaryReactiveNameFromExpr(expr.left, ctx) || primaryReactiveNameFromExpr(expr.right, ctx);
  if (expr.kind === 'unary') return primaryReactiveNameFromExpr(expr.operand, ctx);
  if (expr.kind === 'ternary') return primaryReactiveNameFromExpr(expr.condition, ctx);
  if (expr.kind === 'member') return primaryReactiveNameFromExpr(expr.object, ctx);
  if (expr.kind === 'call' && expr.callee.kind === 'identifier') return expr.callee.name;
  return '';
}

function emitStyle(decl: StyleBlock, ctx: GenContext): string[] {
  const i = ind(ctx);
  const hash = ctx.scopeHash;
  // Scope class names: .foo → .foo_hash
  const scopedCss = decl.css.replace(/\.([a-zA-Z_][\w-]*)/g, `.$1_${hash}`);
  const escaped = escapeStr(scopedCss);
  return [
    `${i}const __style = document.createElement('style');`,
    `${i}__style.textContent = '${escaped}';`,
    `${i}document.head.appendChild(__style);`,
  ];
}

function emitVNode(node: VNode, parent: string, ctx: GenContext, parentDesc: string): string[] {
  switch (node.kind) {
    case 'element': return emitVElement(node, parent, ctx, parentDesc);
    case 'component': return emitVComponent(node, parent, ctx, parentDesc);
    case 'text': return emitVText(node, parent, ctx);
    case 'expr': return emitVExpr(node, parent, ctx, parentDesc);
    case 'if': return emitVIf(node, parent, ctx, parentDesc);
    case 'for': return emitVFor(node, parent, ctx, parentDesc);
    case 'vslot': return emitVSlot(node, parent, ctx);
    default: return [];
  }
}

function emitVElement(node: VElement, parent: string, ctx: GenContext, parentDesc: string): string[] {
  const i = ind(ctx);
  const v = nextEl(ctx);
  const elDesc = getVElementDesc(node, ctx);
  const lines = [`${i}const ${v} = document.createElement('${node.tag}');`];

  for (const attr of node.attrs) {
    if (attr.isEvent) {
      lines.push(...emitEventAttr(attr, v, ctx));
    } else if (attr.isBind) {
      const typeAttr = node.attrs.find(a => a.name === 'type' && a.value?.kind === 'literal');
      const inputType = (typeAttr && typeAttr.value?.kind === 'literal') ? String(typeAttr.value.value) : '';
      lines.push(...emitBindAttr(attr, v, ctx, elDesc, inputType, node.tag));
    } else if (attr.value) {
      if (attr.value.kind === 'literal' && attr.value.type === 'string') {
        let attrVal = String(attr.value.value);
        if (attr.name === 'class' && hasStyleBlock(ctx)) {
          attrVal = attrVal.split(/\s+/).map(c => `${c}_${ctx.scopeHash}`).join(' ');
        }
        lines.push(`${i}${v}.setAttribute('${attr.name}', '${escapeStr(attrVal)}');`);
      } else if (isReactive(attr.value, ctx)) {
        const viewName = primaryReactiveNameFromExpr(attr.value, ctx) || attr.name;
        const boolAttrs = ['disabled', 'checked', 'readonly', 'hidden', 'required'];
        if (boolAttrs.includes(attr.name)) {
          lines.push(`${i}createEffect(() => { const __v = ${emitExpr(attr.value, ctx)}; if (__v) ${v}.setAttribute('${attr.name}', ''); else ${v}.removeAttribute('${attr.name}'); }, { name: 'view:attr:${viewName}', module: $m, viewTarget: { element: '${escapeStr(elDesc)}', binding: 'attr:${attr.name}' } });`);
        } else {
          lines.push(`${i}createEffect(() => { ${v}.setAttribute('${attr.name}', ${emitExpr(attr.value, ctx)}); }, { name: 'view:attr:${viewName}', module: $m, viewTarget: { element: '${escapeStr(elDesc)}', binding: 'attr:${attr.name}' } });`);
        }
      } else {
        lines.push(`${i}${v}.setAttribute('${attr.name}', ${emitExpr(attr.value, ctx)});`);
      }
    }
  }

  for (const child of node.children) lines.push(...emitVNode(child, v, ctx, elDesc));
  lines.push(`${i}${parent}.appendChild(${v});`);
  return lines;
}

function emitVComponent(node: VComponent, parent: string, ctx: GenContext, parentDesc: string): string[] {
  const i = ind(ctx);
  const v = nextEl(ctx);
  const childVar = `__child${ctx.elCount}`;
  const lines = [
    `${i}const ${v} = document.createElement('div');`,
    `${i}${v}.style.display = 'contents';`,
  ];

  // Collect initial prop values for child factory
  const propsEntries: string[] = [];
  const inputBindings: { name: string; expr: string }[] = [];
  const outputBindings: { name: string; expr: Expr }[] = [];
  for (const prop of node.props) {
    if (prop.isEvent) continue;
    if (prop.isBinding && prop.value) {
      // := binding — bidirectional output wire
      propsEntries.push(`${prop.name}: ${emitExpr(prop.value, ctx)}`);
      outputBindings.push({ name: prop.name, expr: prop.value });
    } else if (prop.value) {
      propsEntries.push(`${prop.name}: ${emitExpr(prop.value, ctx)}`);
      if (isReactive(prop.value, ctx)) {
        inputBindings.push({ name: prop.name, expr: emitExpr(prop.value, ctx) });
      }
    }
  }
  const propsObj = propsEntries.length > 0 ? `{ ${propsEntries.join(', ')} }` : '{}';

  // If the component has children in the template, create a container and pass as __children
  const hasChildren = node.children.length > 0;
  let childrenVar = '';
  if (hasChildren) {
    childrenVar = `__childContent${ctx.elCount}`;
    lines.push(`${i}const ${childrenVar} = document.createDocumentFragment();`);
    for (const child of node.children) {
      lines.push(...emitVNode(child, childrenVar, ctx, node.name));
    }
    lines.push(`${i}const ${childVar} = ${node.name}(${propsObj}, ${v}, ${childrenVar});`);
  } else {
    lines.push(`${i}const ${childVar} = ${node.name}(${propsObj}, ${v});`);
  }

  // Wire reactive input forwarding
  for (const bind of inputBindings) {
    lines.push(`${i}createEffect(() => {`);
    lines.push(`${i}  if (${childVar}.__ports && ${childVar}.__ports.${bind.name}) ${childVar}.__ports.${bind.name}.set(${bind.expr});`);
    lines.push(`${i}}, { name: 'wire:${bind.name}', module: $m });`);
  }

  // Wire output bindings (child output → parent signal)
  for (const bind of outputBindings) {
    if (bind.expr.kind === 'identifier') {
      const parentSetter = `set${capitalize(bind.expr.name)}`;
      lines.push(`${i}createEffect(() => {`);
      lines.push(`${i}  if (${childVar}.__ports && ${childVar}.__ports.${bind.name}) ${parentSetter}(${childVar}.__ports.${bind.name}.get());`);
      lines.push(`${i}}, { name: 'bind:${bind.name}', module: $m });`);
    }
  }

  for (const prop of node.props) {
    if (prop.isEvent) lines.push(...emitEventAttr(prop, v, ctx));
  }

  lines.push(`${i}${parent}.appendChild(${v});`);
  return lines;
}

function emitVText(node: VText, parent: string, ctx: GenContext): string[] {
  const i = ind(ctx);
  const v = nextTxt(ctx);
  return [
    `${i}const ${v} = document.createTextNode('${escapeStr(node.value)}');`,
    `${i}${parent}.appendChild(${v});`,
  ];
}

function emitVExpr(node: VExpr, parent: string, ctx: GenContext, parentDesc: string): string[] {
  const i = ind(ctx);
  const v = nextTxt(ctx);
  const expr = emitExpr(node.expr, ctx);
  const lines: string[] = [];

  if (isReactive(node.expr, ctx)) {
    const viewName = primaryReactiveNameFromExpr(node.expr, ctx) || v;
    lines.push(`${i}const ${v} = document.createTextNode('');`);
    lines.push(`${i}createEffect(() => { ${v}.data = String(${expr}); }, { name: 'view:${viewName}', module: $m, viewTarget: { element: '${escapeStr(parentDesc)}', binding: 'text' } });`);
  } else {
    lines.push(`${i}const ${v} = document.createTextNode(String(${expr}));`);
  }
  lines.push(`${i}${parent}.appendChild(${v});`);
  return lines;
}

function emitVIf(node: VIf, parent: string, ctx: GenContext, parentDesc: string): string[] {
  const i = ind(ctx);
  const anchor = nextEl(ctx);
  const container = nextEl(ctx);
  const cond = emitExpr(node.condition, ctx);
  const lines = [
    `${i}const ${anchor} = document.createComment('@if');`,
    `${i}${parent}.appendChild(${anchor});`,
    `${i}let ${container} = null;`,
    `${i}createEffect(() => {`,
  ];
  ctx.indent++;
  const ii = ind(ctx);
  lines.push(`${ii}if (${container}) { ${container}.remove(); ${container} = null; }`);
  lines.push(`${ii}if (${cond}) {`);
  ctx.indent++;
  lines.push(`${ind(ctx)}${container} = document.createElement('span');`);
  lines.push(`${ind(ctx)}${container}.style.display = 'contents';`);
  for (const child of node.then) lines.push(...emitVNode(child, container, ctx, parentDesc));
  lines.push(`${ind(ctx)}${anchor}.parentNode.insertBefore(${container}, ${anchor}.nextSibling);`);
  ctx.indent--;

  if (node.else_ && node.else_.length > 0) {
    lines.push(`${ii}} else {`);
    ctx.indent++;
    lines.push(`${ind(ctx)}${container} = document.createElement('span');`);
    lines.push(`${ind(ctx)}${container}.style.display = 'contents';`);
    for (const child of node.else_) lines.push(...emitVNode(child, container, ctx, parentDesc));
    lines.push(`${ind(ctx)}${anchor}.parentNode.insertBefore(${container}, ${anchor}.nextSibling);`);
    ctx.indent--;
  }

  lines.push(`${ii}}`);
  ctx.indent--;
  lines.push(`${i}}, { name: 'if:${anchor}', module: $m });`);
  return lines;
}

function emitVFor(node: VFor, parent: string, ctx: GenContext, parentDesc: string): string[] {
  if (node.keyExpr) {
    return emitVForKeyed(node, parent, ctx, parentDesc);
  }
  return emitVForUnkeyed(node, parent, ctx, parentDesc);
}

function emitVForUnkeyed(node: VFor, parent: string, ctx: GenContext, parentDesc: string): string[] {
  const i = ind(ctx);
  const anchor = nextEl(ctx);
  const container = nextEl(ctx);
  const lines = [
    `${i}const ${anchor} = document.createComment('@for');`,
    `${i}${parent}.appendChild(${anchor});`,
    `${i}let ${container} = null;`,
    `${i}createEffect(() => {`,
  ];
  ctx.indent++;
  const ii = ind(ctx);
  lines.push(`${ii}if (${container}) { ${container}.remove(); ${container} = null; }`);
  lines.push(`${ii}${container} = document.createElement('span');`);
  lines.push(`${ii}${container}.style.display = 'contents';`);

  if (node.iterable.kind === 'range') {
    const start = emitExpr(node.iterable.start, ctx);
    const end = emitExpr(node.iterable.end, ctx);
    lines.push(`${ii}for (let ${node.variable} = ${start}; ${node.variable} < ${end}; ${node.variable}++) {`);
  } else {
    lines.push(`${ii}for (const ${node.variable} of ${emitExpr(node.iterable, ctx)}) {`);
  }

  ctx.indent++;
  for (const child of node.body) lines.push(...emitVNode(child, container, ctx, parentDesc));
  ctx.indent--;

  lines.push(`${ii}}`);
  lines.push(`${ii}${anchor}.parentNode.insertBefore(${container}, ${anchor}.nextSibling);`);
  ctx.indent--;
  lines.push(`${i}}, { name: 'for:${anchor}', module: $m });`);
  return lines;
}

function emitVSlot(_node: VSlot, parent: string, ctx: GenContext): string[] {
  const i = ind(ctx);
  return [
    `${i}if (__children) { ${parent}.appendChild(__children); }`,
  ];
}

function emitVForKeyed(node: VFor, parent: string, ctx: GenContext, parentDesc: string): string[] {
  const i = ind(ctx);
  const anchor = nextEl(ctx);
  const stateVar = `__forState${ctx.elCount++}`;
  const itemVar = `__item`;
  const idxVar = `__i`;
  const containerVar = `__c`;

  // Emit the key expression with the loop variable name replaced by the lambda parameter
  const keyExprStr = emitExprWithReplacement(node.keyExpr!, node.variable, itemVar, ctx);

  // Emit the body nodes into a container, using a temporary variable name for the item
  const savedElCount = ctx.elCount;
  const savedTxtCount = ctx.txtCount;

  // Generate body code for createFn — builds DOM from scratch
  // Indent: base + 1 (createEffect) + 2 (closure body inside reconcileKeyed args) = +3
  ctx.indent += 3;
  const bodyLines: string[] = [];
  for (const child of node.body) {
    bodyLines.push(...emitVNodeWithReplacement(child, containerVar, ctx, parentDesc, node.variable, itemVar));
  }
  ctx.indent -= 3;

  // Generate body code for updateFn — clears and rebuilds
  ctx.elCount = savedElCount + 100; // offset to avoid var name collisions
  ctx.txtCount = savedTxtCount + 100;
  ctx.indent += 3;
  const updateBodyLines: string[] = [];
  for (const child of node.body) {
    updateBodyLines.push(...emitVNodeWithReplacement(child, containerVar, ctx, parentDesc, node.variable, itemVar));
  }
  ctx.indent -= 3;

  const iterableExpr = emitExpr(node.iterable, ctx);

  const lines = [
    `${i}const ${stateVar} = { keyMap: new Map(), disposers: new Map() };`,
    `${i}const ${anchor} = document.createComment('@for');`,
    `${i}${parent}.appendChild(${anchor});`,
    `${i}createEffect(() => {`,
  ];
  ctx.indent++;
  const ii = ind(ctx);
  lines.push(`${ii}const __items = ${iterableExpr};`);
  lines.push(`${ii}reconcileKeyed(`);
  lines.push(`${ii}  ${parent},`);
  lines.push(`${ii}  ${anchor},`);
  lines.push(`${ii}  __items,`);
  lines.push(`${ii}  (${itemVar}, ${idxVar}) => ${keyExprStr},`);
  lines.push(`${ii}  (${itemVar}, ${idxVar}) => {`);
  lines.push(`${ii}    const ${containerVar} = document.createElement('span');`);
  lines.push(`${ii}    ${containerVar}.style.display = 'contents';`);
  for (const line of bodyLines) lines.push(line);
  lines.push(`${ii}    return ${containerVar};`);
  lines.push(`${ii}  },`);
  lines.push(`${ii}  (__node, ${itemVar}, ${idxVar}) => {`);
  lines.push(`${ii}    const ${containerVar} = __node;`);
  lines.push(`${ii}    ${containerVar}.innerHTML = '';`);
  for (const line of updateBodyLines) lines.push(line);
  lines.push(`${ii}  },`);
  lines.push(`${ii}  ${stateVar},`);
  lines.push(`${ii});`);
  ctx.indent--;
  lines.push(`${i}}, { name: 'for:${anchor}', module: $m });`);
  return lines;
}

/** Emit an expression, replacing occurrences of `oldName` identifier with `newName` */
function emitExprWithReplacement(expr: Expr, oldName: string, newName: string, ctx: GenContext): string {
  // Create a temporary context that maps the old variable name
  // We need to avoid signal() wrapping for the loop variable
  switch (expr.kind) {
    case 'literal':
      if (expr.type === 'string') return JSON.stringify(expr.value);
      return String(expr.value);
    case 'identifier':
      if (expr.name === oldName) return newName;
      if (ctx.signals.has(expr.name) || ctx.combs.has(expr.name)) return `${expr.name}()`;
      return expr.name;
    case 'binary': {
      const op = expr.op === '<=' ? '<=' : expr.op;
      return `(${emitExprWithReplacement(expr.left, oldName, newName, ctx)} ${op} ${emitExprWithReplacement(expr.right, oldName, newName, ctx)})`;
    }
    case 'member':
      return `${emitExprWithReplacement(expr.object, oldName, newName, ctx)}.${expr.property}`;
    case 'index':
      return `${emitExprWithReplacement(expr.object, oldName, newName, ctx)}[${emitExprWithReplacement(expr.index, oldName, newName, ctx)}]`;
    case 'call': {
      const callee = emitExprWithReplacement(expr.callee, oldName, newName, ctx);
      const args = expr.args.map(a => emitExprWithReplacement(a, oldName, newName, ctx)).join(', ');
      return `${callee}(${args})`;
    }
    default:
      return emitExpr(expr, ctx);
  }
}

/** Emit a VNode tree, replacing the loop variable name with a different identifier */
function emitVNodeWithReplacement(node: VNode, parent: string, ctx: GenContext, parentDesc: string, oldName: string, newName: string): string[] {
  // For the keyed for body, the loop variable is a plain value (not a signal).
  // We temporarily add and remove it from signals so emitExpr doesn't add () calls.
  // Actually, the loop variable is NOT in signals/combs, so emitExpr will emit it as-is.
  // We just need to rename references from oldName to newName.
  // The simplest approach: emit normally, then do string replacement.
  // But that could cause false replacements. Instead, let's use a scoped approach.

  // Save the old signals state and temporarily exclude the loop variable
  const wasSignal = ctx.signals.has(oldName);
  const wasComb = ctx.combs.has(oldName);
  ctx.signals.delete(oldName);
  ctx.combs.delete(oldName);

  const lines = emitVNode(node, parent, ctx, parentDesc);

  // Restore
  if (wasSignal) ctx.signals.add(oldName);
  if (wasComb) ctx.combs.add(oldName);

  // Replace the old variable name with the new one in the generated code
  // We need to be careful to only replace whole-word occurrences
  const regex = new RegExp(`\\b${oldName}\\b`, 'g');
  return lines.map(line => line.replace(regex, newName));
}

function emitEventAttr(attr: VAttr, elVar: string, ctx: GenContext): string[] {
  const i = ind(ctx);
  const event = attr.name;
  const handler = attr.value && attr.value.kind === 'identifier' ? attr.value.name : 'unknown';
  const modifiers = attr.modifier ? attr.modifier.split('.') : [];

  // Check for DOM event modifiers (prevent, stop) vs key modifiers (enter, escape, etc.)
  const domModifiers = modifiers.filter(m => m === 'prevent' || m === 'stop');
  const keyModifiers = modifiers.filter(m => m !== 'prevent' && m !== 'stop');

  // Build modifier preamble
  const preamble: string[] = [];
  for (const m of domModifiers) {
    if (m === 'prevent') preamble.push('e.preventDefault();');
    if (m === 'stop') preamble.push('e.stopPropagation();');
  }

  const needsEventParam = domModifiers.length > 0 || keyModifiers.length > 0 || (attr.eventArgs && attr.eventArgs.length > 0 && event === 'contextmenu');

  if (attr.eventArgs && attr.eventArgs.length > 0) {
    const args = attr.eventArgs.map(a => emitExpr(a, ctx)).join(', ');
    const pre = preamble.length > 0 ? ` ${preamble.join(' ')}` : '';
    return [`${i}${elVar}.addEventListener('${event}', (e) => {${pre} ${handler}(${args}); });`];
  }
  if (keyModifiers.length > 0) {
    const keyCheck = `e.key === '${capitalize(keyModifiers[0])}'`;
    const pre = preamble.length > 0 ? ` ${preamble.join(' ')}` : '';
    return [`${i}${elVar}.addEventListener('${event}', (e) => {${pre} if (${keyCheck}) ${handler}(); });`];
  }
  if (domModifiers.length > 0) {
    const pre = preamble.join(' ');
    return [`${i}${elVar}.addEventListener('${event}', (e) => { ${pre} ${handler}(); });`];
  }
  return [`${i}${elVar}.addEventListener('${event}', ${handler});`];
}

function emitBindAttr(attr: VAttr, elVar: string, ctx: GenContext, elDesc: string = '', inputType: string = '', tagName: string = 'input'): string[] {
  const i = ind(ctx);
  if (!attr.value || attr.value.kind !== 'identifier') return [];
  const name = attr.value.name;
  const setter = 'set' + capitalize(name);

  // Checkbox: use checked property, change event, boolean coercion
  if (tagName === 'input' && inputType === 'checkbox') {
    return [
      `${i}${elVar}.checked = ${name}();`,
      `${i}createEffect(() => { ${elVar}.checked = ${name}(); }, { name: 'view:bind:${name}', module: $m, viewTarget: { element: '${escapeStr(elDesc)}', binding: 'bind:checked' } });`,
      `${i}${elVar}.addEventListener('change', (e) => { ${setter}(e.target.checked); });`,
    ];
  }

  // Radio: use checked comparison, change event, set value on check
  if (tagName === 'input' && inputType === 'radio') {
    return [
      `${i}${elVar}.checked = (${name}() === ${elVar}.value);`,
      `${i}createEffect(() => { ${elVar}.checked = (${name}() === ${elVar}.value); }, { name: 'view:bind:${name}', module: $m, viewTarget: { element: '${escapeStr(elDesc)}', binding: 'bind:checked' } });`,
      `${i}${elVar}.addEventListener('change', (e) => { if (e.target.checked) ${setter}(e.target.value); });`,
    ];
  }

  // Select: use value property, change event
  if (tagName === 'select') {
    return [
      `${i}${elVar}.value = ${name}();`,
      `${i}createEffect(() => { ${elVar}.value = ${name}(); }, { name: 'view:bind:${name}', module: $m, viewTarget: { element: '${escapeStr(elDesc)}', binding: 'bind:value' } });`,
      `${i}${elVar}.addEventListener('change', (e) => { ${setter}(e.target.value); });`,
    ];
  }

  // Default (input text/number/range, textarea): use value property, input event
  const coerce = (inputType === 'range' || inputType === 'number') ? 'Number(e.target.value)' : 'e.target.value';
  return [
    `${i}${elVar}.value = ${name}();`,
    `${i}createEffect(() => { ${elVar}.value = ${name}(); }, { name: 'view:bind:${name}', module: $m, viewTarget: { element: '${escapeStr(elDesc)}', binding: 'bind:value' } });`,
    `${i}${elVar}.addEventListener('input', (e) => { ${setter}(${coerce}); });`,
  ];
}

// Expressions

function emitExpr(expr: Expr, ctx: GenContext): string {
  switch (expr.kind) {
    case 'literal':
      if (expr.type === 'string') return JSON.stringify(expr.value);
      return String(expr.value);
    case 'identifier':
      // Check constraint locals first — use pre-read local variable
      if (ctx.constraintLocals && ctx.constraintLocals.has(expr.name)) {
        return ctx.constraintLocals.get(expr.name)!;
      }
      if (expr.name === 'X') return 'X';
      if (ctx.signals.has(expr.name) || ctx.combs.has(expr.name)) return `${expr.name}()`;
      return expr.name;
    case 'binary': {
      const op = expr.op === '<=' ? '<=' : expr.op;
      return `(${emitExpr(expr.left, ctx)} ${op} ${emitExpr(expr.right, ctx)})`;
    }
    case 'unary':
      return `${expr.op}${emitExpr(expr.operand, ctx)}`;
    case 'ternary':
      return `(${emitExpr(expr.condition, ctx)} ? ${emitExpr(expr.then, ctx)} : ${emitExpr(expr.else_, ctx)})`;
    case 'call':
      return emitCall(expr, ctx);
    case 'member':
      return `${emitExpr(expr.object, ctx)}.${expr.property}`;
    case 'index':
      return `${emitExpr(expr.object, ctx)}[${emitExpr(expr.index, ctx)}]`;
    case 'array':
      return `[${expr.elements.map(e => emitExpr(e, ctx)).join(', ')}]`;
    case 'object':
      return `{ ${expr.properties.map(p => `${p.key}: ${emitExpr(p.value, ctx)}`).join(', ')} }`;
    case 'spread':
      return `...${emitExpr(expr.expr, ctx)}`;
    case 'lambda':
      return `(${expr.params.join(', ')}) => ${emitExpr(expr.body, ctx)}`;
    case 'range': {
      const s = emitExpr(expr.start, ctx);
      const e = emitExpr(expr.end, ctx);
      return `Array.from({ length: ${e} - ${s} }, (_, i) => i + ${s})`;
    }
    case 'template': {
      let result = '`';
      for (const part of expr.parts) {
        if (typeof part === 'string') {
          result += part;
        } else {
          result += '${' + emitExpr(part, ctx) + '}';
        }
      }
      result += '`';
      return result;
    }
    case 'await':
      return `await ${emitExpr(expr.expr, ctx)}`;
  }
}

function emitCall(expr: Expr & { kind: 'call' }, ctx: GenContext): string {
  if (expr.callee.kind === 'identifier') {
    const name = expr.callee.name;
    const args = expr.args.map(a => emitExpr(a, ctx)).join(', ');
    if (name === 'str') return `String(${args})`;
    if (name === 'int') return `parseInt(${args}, 10)`;
    if (name === 'float') return `parseFloat(${args})`;
    if (name === 'now') return `Date.now()`;
    if (name === 'format_time') return `new Date(${args}).toLocaleTimeString()`;
    if (name === 'len' && expr.args.length === 1) return `${emitExpr(expr.args[0], ctx)}.length`;
    if (name === 'contains' && expr.args.length === 2) return `${emitExpr(expr.args[0], ctx)}.includes(${emitExpr(expr.args[1], ctx)})`;
    if (name === 'append' && expr.args.length === 2) return `[...${emitExpr(expr.args[0], ctx)}, ${emitExpr(expr.args[1], ctx)}]`;
    if (name === 'reduce' && expr.args.length === 3) return `${emitExpr(expr.args[0], ctx)}.reduce(${emitExpr(expr.args[1], ctx)}, ${emitExpr(expr.args[2], ctx)})`;
    if (name === 'slice' && expr.args.length >= 2) return `${emitExpr(expr.args[0], ctx)}.slice(${expr.args.slice(1).map(a => emitExpr(a, ctx)).join(', ')})`;
    if (name === 'floor' && expr.args.length === 1) return `Math.floor(${emitExpr(expr.args[0], ctx)})`;
    if (name === 'round' && expr.args.length === 1) return `Math.round(${emitExpr(expr.args[0], ctx)})`;
    if (name === 'min' && expr.args.length === 2) return `Math.min(${emitExpr(expr.args[0], ctx)}, ${emitExpr(expr.args[1], ctx)})`;
    if (name === 'max' && expr.args.length === 2) return `Math.max(${emitExpr(expr.args[0], ctx)}, ${emitExpr(expr.args[1], ctx)})`;
    if (name === 'abs' && expr.args.length === 1) return `Math.abs(${emitExpr(expr.args[0], ctx)})`;
    return `${emitExpr(expr.callee, ctx)}(${args})`;
  }
  if (expr.callee.kind === 'member') {
    const obj = emitExpr(expr.callee.object, ctx);
    const method = expr.callee.property;
    const args = expr.args.map(a => emitExpr(a, ctx)).join(', ');
    if (method === 'len' && expr.args.length === 0) return `${obj}.length`;
    return `${obj}.${method}(${args})`;
  }
  const callee = emitExpr(expr.callee, ctx);
  const args = expr.args.map(a => emitExpr(a, ctx)).join(', ');
  return `${callee}(${args})`;
}

// Helpers

function hasKeyedForDirective(mod: Module): boolean {
  function scanVNodes(nodes: VNode[]): boolean {
    for (const node of nodes) {
      if (node.kind === 'for' && node.keyExpr) return true;
      if (node.kind === 'for') { if (scanVNodes(node.body)) return true; }
      if (node.kind === 'element') { if (scanVNodes(node.children)) return true; }
      if (node.kind === 'component') { if (scanVNodes(node.children)) return true; }
      if (node.kind === 'if') {
        if (scanVNodes(node.then)) return true;
        if (node.else_ && scanVNodes(node.else_)) return true;
      }
    }
    return false;
  }
  for (const decl of mod.body) {
    if (decl.kind === 'view' && scanVNodes(decl.children)) return true;
  }
  return false;
}

function isReactive(expr: Expr, ctx: GenContext): boolean {
  switch (expr.kind) {
    case 'identifier': return ctx.signals.has(expr.name) || ctx.combs.has(expr.name);
    case 'binary': return isReactive(expr.left, ctx) || isReactive(expr.right, ctx);
    case 'unary': return isReactive(expr.operand, ctx);
    case 'ternary': return isReactive(expr.condition, ctx) || isReactive(expr.then, ctx) || isReactive(expr.else_, ctx);
    case 'call': return isReactive(expr.callee, ctx) || expr.args.some(a => isReactive(a, ctx));
    case 'member': return isReactive(expr.object, ctx);
    case 'index': return isReactive(expr.object, ctx) || isReactive(expr.index, ctx);
    case 'array': return expr.elements.some(e => isReactive(e, ctx));
    case 'object': return expr.properties.some(p => isReactive(p.value, ctx));
    case 'template': return expr.parts.some(p => typeof p !== 'string' && isReactive(p, ctx));
    case 'await': return isReactive(expr.expr, ctx);
    default: return false;
  }
}

function flattenIndex(expr: Expr): { base: Expr; indices: Expr[] } {
  const indices: Expr[] = [];
  let current = expr;
  while (current.kind === 'index') {
    indices.unshift(current.index);
    current = current.object;
  }
  return { base: current, indices };
}
