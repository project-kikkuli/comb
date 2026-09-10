// verify.ts — Verification pass: dependency extraction, resolution, cycle detection, type checking

import type { Module, Declaration, CombDecl, AlwaysBlock, AssertDecl, TemporalAssertDecl, ConstraintDecl, Expr, Statement, VNode, VSlot, AsyncStmt, TypeExpr } from './ast.js';
import type { StaticGraph, GraphNode, GraphEdge } from './graph.js';

export interface CompileError {
  message: string;
  line: number;
  column: number;
}

export interface CompileWarning {
  message: string;
  line: number;
  column: number;
}

export interface VerifyResult {
  graph: StaticGraph;
  errors: CompileError[];
  warnings: CompileWarning[];
}

type SymbolKind = 'signal' | 'comb' | 'enum' | 'input' | 'output' | 'cell';

// Internal type representation for type checking
type CombType =
  | { kind: 'int' } | { kind: 'float' } | { kind: 'string' } | { kind: 'bool' }
  | { kind: 'color' } | { kind: 'length' }
  | { kind: 'enum'; name: string; variants: string[] }
  | { kind: 'array'; element: CombType }
  | { kind: 'range'; base: 'int' | 'float'; min: number; max: number }
  | { kind: 'union'; members: CombType[]; hasX: boolean }
  | { kind: 'any' } | { kind: 'X' };

function resolveType(typeExpr: TypeExpr, enumDefs: Map<string, string[]>): CombType {
  switch (typeExpr.kind) {
    case 'simple': {
      const name = typeExpr.name;
      if (name === 'int') return { kind: 'int' };
      if (name === 'float') return { kind: 'float' };
      if (name === 'string') return { kind: 'string' };
      if (name === 'bool') return { kind: 'bool' };
      if (name === 'color') return { kind: 'color' };
      if (name === 'length') return { kind: 'length' };
      if (name === 'X') return { kind: 'X' };
      if (enumDefs.has(name)) return { kind: 'enum', name, variants: enumDefs.get(name)! };
      return { kind: 'any' };
    }
    case 'array':
      return { kind: 'array', element: resolveType(typeExpr.element, enumDefs) };
    case 'range':
      return { kind: 'range', base: typeExpr.base === 'float' ? 'float' : 'int', min: typeExpr.min, max: typeExpr.max };
    case 'union': {
      const members = typeExpr.members.map(m => resolveType(m, enumDefs));
      const hasX = typeExpr.hasX || members.some(m => m.kind === 'X');
      return { kind: 'union', members, hasX };
    }
    case 'object':
      return { kind: 'any' };
  }
}

function inferExprType(expr: Expr, env: Map<string, CombType>, enumDefs: Map<string, string[]>): CombType {
  switch (expr.kind) {
    case 'literal': {
      if (expr.type === 'number') {
        return typeof expr.value === 'number' && Number.isInteger(expr.value) ? { kind: 'int' } : { kind: 'float' };
      }
      if (expr.type === 'string') return { kind: 'string' };
      if (expr.type === 'boolean') return { kind: 'bool' };
      return { kind: 'any' };
    }
    case 'identifier': {
      if (env.has(expr.name)) return env.get(expr.name)!;
      // Check if it's an enum member like Phase.Red
      return { kind: 'any' };
    }
    case 'binary': {
      const left = inferExprType(expr.left, env, enumDefs);
      const right = inferExprType(expr.right, env, enumDefs);
      if (expr.op === '+' && (left.kind === 'string' || right.kind === 'string')) return { kind: 'string' };
      if (['+', '-', '*', '/', '%'].includes(expr.op)) {
        if (left.kind === 'float' || right.kind === 'float') return { kind: 'float' };
        if (left.kind === 'int' && right.kind === 'int') return { kind: 'int' };
        return { kind: 'float' };
      }
      if (['==', '!=', '<', '>', '<=', '>='].includes(expr.op)) return { kind: 'bool' };
      if (['&&', '||'].includes(expr.op)) return { kind: 'bool' };
      return { kind: 'any' };
    }
    case 'unary': {
      if (expr.op === '!') return { kind: 'bool' };
      if (expr.op === '-') return inferExprType(expr.operand, env, enumDefs);
      return { kind: 'any' };
    }
    case 'ternary': {
      const thenType = inferExprType(expr.then, env, enumDefs);
      const elseType = inferExprType(expr.else_, env, enumDefs);
      if (thenType.kind === elseType.kind) return thenType;
      return { kind: 'any' };
    }
    case 'call': {
      if (expr.callee.kind === 'identifier') {
        const name = expr.callee.name;
        if (name === 'str') return { kind: 'string' };
        if (name === 'int' || name === 'parseInt') return { kind: 'int' };
        if (name === 'float' || name === 'parseFloat') return { kind: 'float' };
        if (name === 'len') return { kind: 'int' };
        if (name === 'contains') return { kind: 'bool' };
        if (name === 'floor' || name === 'round' || name === 'abs') return { kind: 'int' };
        if (name === 'min' || name === 'max') return { kind: 'float' };
      }
      return { kind: 'any' };
    }
    case 'member': {
      // Enum member: Phase.Red → enum type
      if (expr.object.kind === 'identifier' && enumDefs.has(expr.object.name)) {
        return { kind: 'enum', name: expr.object.name, variants: enumDefs.get(expr.object.name)! };
      }
      // .length → int
      if (expr.property === 'length') return { kind: 'int' };
      return { kind: 'any' };
    }
    case 'index': return { kind: 'any' };
    case 'array': {
      if (expr.elements.length > 0) {
        const elemType = inferExprType(expr.elements[0], env, enumDefs);
        return { kind: 'array', element: elemType };
      }
      return { kind: 'array', element: { kind: 'any' } };
    }
    case 'object': return { kind: 'any' };
    case 'range': return { kind: 'array', element: { kind: 'int' } };
    default: return { kind: 'any' };
  }
}

function typeCompatible(declared: CombType, actual: CombType): boolean {
  if (declared.kind === 'any' || actual.kind === 'any') return true;
  if (declared.kind === 'X' || actual.kind === 'X') return true;
  if (declared.kind === actual.kind) return true;
  // int widening to float
  if (declared.kind === 'float' && actual.kind === 'int') return true;
  // range base compatible
  if (declared.kind === 'range') return typeCompatible({ kind: declared.base }, actual);
  if (actual.kind === 'range') return typeCompatible(declared, { kind: actual.base });
  // union — any member compatible
  if (declared.kind === 'union') return declared.members.some(m => typeCompatible(m, actual));
  if (actual.kind === 'union') return actual.members.some(m => typeCompatible(declared, m));
  // color/length can accept string
  if ((declared.kind === 'color' || declared.kind === 'length') && actual.kind === 'string') return true;
  return false;
}

function typeName(t: CombType): string {
  switch (t.kind) {
    case 'int': case 'float': case 'string': case 'bool': case 'color': case 'length': case 'any': case 'X':
      return t.kind;
    case 'enum': return t.name;
    case 'array': return `${typeName(t.element)}[]`;
    case 'range': return `${t.base}(${t.min}..${t.max})`;
    case 'union': return t.members.map(typeName).join(' | ');
  }
}

export function verify(mod: Module, moduleRegistry?: Map<string, Module>): VerifyResult {
  const errors: CompileError[] = [];
  const warnings: CompileWarning[] = [];
  const symbols = new Map<string, SymbolKind>();
  const enumValues = new Set<string>(); // e.g. "Phase.Red"
  const enumDefs = new Map<string, string[]>();
  const builtins = new Set(['str', 'int', 'float', 'len', 'contains', 'append', 'push', 'pop', 'slice', 'map', 'filter', 'concat', 'Math', 'JSON', 'console', 'Object', 'parseInt', 'parseFloat', 'toString', 'rgbToHsv', 'hsvToRgb', 'rgbToHex', 'reduce', 'floor', 'round', 'min', 'max', 'abs', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'X', 'edgeCount', 'negedgeCount', 'changeCount']);

  // Method names that are valid on arrays/objects/strings — should not trigger undefined reference errors
  const knownMethods = new Set([
    'map', 'filter', 'find', 'findIndex', 'some', 'every', 'includes', 'indexOf',
    'join', 'flat', 'flatMap', 'sort', 'reverse', 'splice', 'push', 'pop',
    'shift', 'unshift', 'trim', 'split', 'replace', 'startsWith', 'endsWith',
    'toUpperCase', 'toLowerCase', 'substring', 'charAt',
    'keys', 'values', 'entries', 'parse', 'stringify', 'random', 'log',
    'length', 'concat', 'slice', 'reduce', 'forEach',
    'floor', 'ceil', 'round', 'abs', 'min', 'max', 'sqrt', 'pow',
  ]);

  // Track user-defined functions: name -> param count
  const userFunctions = new Map<string, number>();

  // 1. Build symbol table
  for (const decl of mod.body) {
    if (decl.kind === 'input') symbols.set(decl.name, 'input');
    if (decl.kind === 'output') symbols.set(decl.name, 'output');
    if (decl.kind === 'signal') symbols.set(decl.name, 'signal');
    if (decl.kind === 'token') symbols.set(decl.name, 'signal'); // tokens are signals
    if (decl.kind === 'comb') symbols.set(decl.name, 'comb');
    if (decl.kind === 'cell') symbols.set(decl.name, 'cell');
    if (decl.kind === 'enum') {
      symbols.set(decl.name, 'enum');
      enumDefs.set(decl.name, decl.variants);
      for (const v of decl.variants) enumValues.add(`${decl.name}.${v}`);
    }
    if (decl.kind === 'fn') {
      userFunctions.set(decl.name, decl.params.length);
    }
  }

  // Also collect always block event trigger params as local scope
  // (they're not module-level symbols but valid identifiers in their block)
  const eventParams = new Map<AlwaysBlock, Set<string>>();
  for (const decl of mod.body) {
    if (decl.kind === 'always') {
      eventParams.set(decl, new Set(decl.trigger.params));
    }
  }

  function isKnownIdentifier(name: string, localScope?: Set<string>): boolean {
    return symbols.has(name) || builtins.has(name) || enumValues.has(name) || userFunctions.has(name) || (localScope?.has(name) ?? false);
  }

  // 1b. Validate user-defined function call arg counts
  function validateCallArgCounts(expr: Expr, loc: { line: number; column: number }): void {
    walkExpr(expr, e => {
      if (e.kind === 'call' && e.callee.kind === 'identifier') {
        const name = e.callee.name;
        if (userFunctions.has(name)) {
          const expected = userFunctions.get(name)!;
          if (e.args.length !== expected) {
            errors.push({ message: `Function '${name}' expects ${expected} arguments but got ${e.args.length}`, line: loc.line, column: loc.column });
          }
        }
      }
    });
  }

  // --- Type checking (warnings only) ---
  const typeEnv = new Map<string, CombType>();
  for (const decl of mod.body) {
    if (decl.kind === 'input' || decl.kind === 'output' || decl.kind === 'signal' || decl.kind === 'token' || decl.kind === 'cell') {
      const declaredType = decl.type ? resolveType(decl.type, enumDefs) : { kind: 'any' as const };
      typeEnv.set(decl.name, declaredType);
      if (decl.initial || ('initial' in decl && (decl as any).initial)) {
        const init = (decl as any).initial as Expr | undefined;
        if (init) {
          const actualType = inferExprType(init, typeEnv, enumDefs);
          if (!typeCompatible(declaredType, actualType)) {
            warnings.push({
              message: `Type mismatch: '${decl.name}' declared as ${typeName(declaredType)} but initialized with ${typeName(actualType)}`,
              line: decl.loc.line,
              column: decl.loc.column,
            });
          }
        }
      }
    }
  }

  // Infer comb types
  for (const decl of mod.body) {
    if (decl.kind === 'comb') {
      const inferredType = inferExprType(decl.expr, typeEnv, enumDefs);
      typeEnv.set(decl.name, inferredType);
    }
  }

  // 2. Extract comb dependencies
  for (const decl of mod.body) {
    if (decl.kind === 'comb') {
      const deps = new Set<string>();
      collectDeps(decl.expr, deps, symbols, builtins, enumValues);
      decl.deps = [...deps];

      // Verify all referenced identifiers exist
      const allRefs = new Set<string>();
      collectAllIdentifiers(decl.expr, allRefs);
      for (const ref of allRefs) {
        if (!isKnownIdentifier(ref)) {
          errors.push({ message: `Undefined reference '${ref}' in comb '${decl.name}'`, line: decl.loc.line, column: decl.loc.column });
        }
      }

      // Validate function call arg counts
      validateCallArgCounts(decl.expr, decl.loc);
    }
  }

  // 2b. Extract assert dependencies
  for (const decl of mod.body) {
    if (decl.kind === 'assert') {
      const deps = new Set<string>();
      collectDeps(decl.expr, deps, symbols, builtins, enumValues);
      decl.deps = [...deps];

      const allRefs = new Set<string>();
      collectAllIdentifiers(decl.expr, allRefs);
      for (const ref of allRefs) {
        if (!isKnownIdentifier(ref)) {
          errors.push({ message: `Undefined reference '${ref}' in assert`, line: decl.loc.line, column: decl.loc.column });
        }
      }
    }
  }

  // 2c. Extract temporal assert dependencies
  for (const decl of mod.body) {
    if (decl.kind === 'temporal_assert') {
      const deps = new Set<string>();
      collectDeps(decl.trigger, deps, symbols, builtins, enumValues);
      collectDeps(decl.property, deps, symbols, builtins, enumValues);
      decl.deps = [...deps];

      const refs = new Set<string>();
      collectAllIdentifiers(decl.trigger, refs);
      collectAllIdentifiers(decl.property, refs);
      for (const ref of refs) {
        if (!isKnownIdentifier(ref)) errors.push({ message: `Undefined reference '${ref}' in temporal assertion`, line: decl.loc.line, column: decl.loc.column });
      }
      // Validate duration
      if (decl.operator !== 'next' && (decl.duration === undefined || !Number.isSafeInteger(decl.duration) || decl.duration <= 0)
        || decl.operator === 'next' && decl.duration !== undefined && ![0, 1].includes(decl.duration)) {
        errors.push({ message: `Temporal assertion requires integer turns: eventually/always need a positive within N; next accepts no duration, 0 or 1 (got ${decl.duration})`, line: decl.loc.line, column: decl.loc.column });
      }
    }
  }

  // 2d. Auto-detect single-signal sensitivity blocks:
  // always @(sigName) where sigName is a signal/comb → promote to sensitivity
  for (const decl of mod.body) {
    if (decl.kind === 'always' && decl.triggerKind === 'event' && decl.trigger.params.length === 0) {
      const name = decl.trigger.name;
      if (symbols.has(name) && isReactiveKind(symbols.get(name)!)) {
        decl.triggerKind = 'sensitivity';
        decl.trigger.signals = [name];
        decl.trigger.name = `sense_${name}`;
      }
    }
  }

  // 3. Extract always block reads/writes
  for (const decl of mod.body) {
    if (decl.kind === 'always') {
      const reads = new Set<string>();
      const writes = new Set<string>();
      const localScope = eventParams.get(decl) ?? new Set();

      // For posedge/negedge, also collect deps from the edge expression
      if ((decl.triggerKind === 'posedge' || decl.triggerKind === 'negedge') && decl.edgeExpr) {
        walkExpr(decl.edgeExpr, e => {
          if (e.kind === 'identifier' && symbols.has(e.name) && isReactiveKind(symbols.get(e.name)!)) {
            reads.add(e.name);
          }
        });
      }

      collectAlwaysReadsWrites(decl.body, reads, writes, symbols, localScope);
      decl.reads = [...reads];
      decl.writes = [...writes];

      // Verify all written targets are writable (signals or outputs, not inputs or combs)
      for (const w of writes) {
        if (!symbols.has(w)) {
          errors.push({ message: `Undefined signal '${w}' written in always @(${decl.trigger.name})`, line: decl.loc.line, column: decl.loc.column });
        } else {
          const kind = symbols.get(w)!;
          if (kind === 'comb') {
            errors.push({ message: `Cannot write to '${w}' (comb) in always @(${decl.trigger.name}) — only signals can be assigned`, line: decl.loc.line, column: decl.loc.column });
          } else if (kind === 'input') {
            errors.push({ message: `Cannot write to '${w}' (input) in always @(${decl.trigger.name}) — inputs are read-only`, line: decl.loc.line, column: decl.loc.column });
          } else if (kind !== 'signal' && kind !== 'output' && kind !== 'cell') {
            errors.push({ message: `Cannot write to '${w}' (${kind}) in always @(${decl.trigger.name}) — only signals can be assigned`, line: decl.loc.line, column: decl.loc.column });
          }
        }
      }

      // Verify all read identifiers exist
      for (const r of reads) {
        if (!isKnownIdentifier(r, localScope)) {
          errors.push({ message: `Undefined reference '${r}' in always @(${decl.trigger.name})`, line: decl.loc.line, column: decl.loc.column });
        }
      }

      // Sensitivity-specific validation
      if (decl.triggerKind === 'sensitivity' && decl.trigger.signals) {
        const sensList = new Set(decl.trigger.signals);

        // All declared sensitivity signals must exist as signals or combs
        for (const sig of sensList) {
          if (!symbols.has(sig)) {
            errors.push({ message: `Undefined signal '${sig}' in sensitivity list @(${decl.trigger.signals.join(', ')})`, line: decl.loc.line, column: decl.loc.column });
          } else if (!isReactiveKind(symbols.get(sig)!)) {
            errors.push({ message: `'${sig}' is not a signal or comb — cannot appear in sensitivity list`, line: decl.loc.line, column: decl.loc.column });
          }
        }

        // Reads must be subset of sensitivity list
        for (const r of reads) {
          if (symbols.has(r) && isReactiveKind(symbols.get(r)!) && !sensList.has(r)) {
            errors.push({ message: `Read of '${r}' not declared in sensitivity list @(${decl.trigger.signals.join(', ')})`, line: decl.loc.line, column: decl.loc.column });
          }
        }

        // Writes must not overlap sensitivity list (no self-triggering)
        for (const w of writes) {
          if (sensList.has(w)) {
            errors.push({ message: `Cannot write to '${w}' — it appears in its own sensitivity list (would self-trigger)`, line: decl.loc.line, column: decl.loc.column });
          }
        }
      }

      // Posedge/negedge validation — similar to sensitivity
      if ((decl.triggerKind === 'posedge' || decl.triggerKind === 'negedge') && decl.trigger.signals) {
        for (const sig of decl.trigger.signals) {
          if (sig !== 'expr' && !symbols.has(sig)) {
            errors.push({ message: `Undefined signal '${sig}' in ${decl.triggerKind} trigger`, line: decl.loc.line, column: decl.loc.column });
          }
        }
      }
    }
  }

  // 3b. Verify constraint clauses
  for (const decl of mod.body) {
    if (decl.kind === 'constraint') {
      for (const clause of decl.clauses) {
        // Verify all declared inputs exist and are cells
        for (const inp of clause.inputs) {
          if (!symbols.has(inp)) {
            errors.push({ message: `Undefined cell '${inp}' in constraint '${decl.name}' clause inputs`, line: decl.loc.line, column: decl.loc.column });
          } else if (symbols.get(inp) !== 'cell') {
            errors.push({ message: `'${inp}' is not a cell — constraint '${decl.name}' inputs must be cells`, line: decl.loc.line, column: decl.loc.column });
          }
        }

        // Collect reads and writes in clause body
        const reads = new Set<string>();
        const writes = new Set<string>();
        collectAlwaysReadsWrites(clause.body, reads, writes, symbols, new Set());

        // Verify reads are subset of declared inputs
        const inputSet = new Set(clause.inputs);
        for (const r of reads) {
          if (symbols.has(r) && isReactiveKind(symbols.get(r)!) && !inputSet.has(r)) {
            errors.push({ message: `Read of '${r}' not declared in constraint '${decl.name}' clause inputs (${clause.inputs.join(', ')})`, line: decl.loc.line, column: decl.loc.column });
          }
        }

        // Verify write targets are cells
        for (const w of writes) {
          if (!symbols.has(w)) {
            errors.push({ message: `Undefined cell '${w}' written in constraint '${decl.name}'`, line: decl.loc.line, column: decl.loc.column });
          } else if (symbols.get(w) !== 'cell') {
            errors.push({ message: `'${w}' is not a cell — constraint '${decl.name}' can only write to cells`, line: decl.loc.line, column: decl.loc.column });
          }
        }

        // Verify no clause writes to its own inputs (no self-triggering)
        for (const w of writes) {
          if (inputSet.has(w)) {
            errors.push({ message: `Cannot write to '${w}' in constraint '${decl.name}' — it is a declared input of this clause (would self-trigger)`, line: decl.loc.line, column: decl.loc.column });
          }
        }
      }
    }
  }

  // 3c. CDC-style async boundary analysis
  analyzeAsyncBoundaries(mod, symbols, warnings);

  // 4. Cycle detection among combs
  const combDeps = new Map<string, string[]>();
  for (const decl of mod.body) {
    if (decl.kind === 'comb') {
      combDeps.set(decl.name, decl.deps.filter(d => symbols.get(d) === 'comb'));
    }
  }

  const cycleError = detectCycles(combDeps);
  if (cycleError) {
    errors.push({ message: cycleError, line: 1, column: 1 });
  }

  // 4b. Cycle detection among always blocks (Verilator-style UNOPTFLAT)
  // Build signal-level dependency graph: if block X writes signal A and reads signal B,
  // then A depends on B. If there's a cycle (A→B→A), it may oscillate.
  const signalDeps = new Map<string, Set<string>>();
  for (const decl of mod.body) {
    if (decl.kind === 'always' && (decl.triggerKind === 'sensitivity' || decl.triggerKind === 'posedge' || decl.triggerKind === 'negedge')) {
      // For each signal this block writes, it depends on all signals this block reads
      for (const written of decl.writes) {
        if (!signalDeps.has(written)) signalDeps.set(written, new Set());
        for (const read of decl.reads) {
          if (read !== written) signalDeps.get(written)!.add(read);
        }
      }
    }
  }
  // Convert to the format detectCycles expects
  const signalDepMap = new Map<string, string[]>();
  for (const [sig, deps] of signalDeps) {
    // Only include deps that are also written by some always block (potential feedback)
    const feedbackDeps = [...deps].filter(d => signalDeps.has(d));
    if (feedbackDeps.length > 0) signalDepMap.set(sig, feedbackDeps);
  }
  const alwaysCycleError = detectCycles(signalDepMap);
  if (alwaysCycleError) {
    warnings.push({ message: `Potential oscillation: ${alwaysCycleError}. This may cause infinite delta cycles at runtime.`, line: 1, column: 1 });
  }

  // 5. Build static graph
  const graph = buildGraph(mod, symbols, enumDefs, typeEnv);

  return { graph, errors, warnings };
}

// Collect identifiers that resolve to signals or combs (dependencies)
function isReactiveKind(kind: SymbolKind): boolean {
  return kind === 'signal' || kind === 'comb' || kind === 'input' || kind === 'output' || kind === 'cell';
}

function collectDeps(expr: Expr, deps: Set<string>, symbols: Map<string, SymbolKind>, builtins: Set<string>, enumValues: Set<string>): void {
  walkExpr(expr, e => {
    if (e.kind === 'identifier' && symbols.has(e.name) && isReactiveKind(symbols.get(e.name)!)) {
      deps.add(e.name);
    }
  });
}

// Collect ALL identifiers (for undefined reference checking)
// Skips identifiers that are member access properties (e.g., 'map' in arr.map)
// and lambda parameters (e.g., 'x' in |x| x + 1)
function collectAllIdentifiers(expr: Expr, ids: Set<string>, lambdaParams?: Set<string>): void {
  const params = lambdaParams ?? new Set<string>();
  switch (expr.kind) {
    case 'identifier':
      if (!params.has(expr.name)) ids.add(expr.name);
      break;
    case 'member':
      // Only collect the object, not the property (property is a method/field name)
      collectAllIdentifiers(expr.object, ids, params);
      break;
    case 'lambda': {
      // Lambda params are local scope — don't check them as undefined
      const innerParams = new Set(params);
      for (const p of expr.params) innerParams.add(p);
      collectAllIdentifiers(expr.body, ids, innerParams);
      break;
    }
    case 'binary':
      collectAllIdentifiers(expr.left, ids, params);
      collectAllIdentifiers(expr.right, ids, params);
      break;
    case 'unary':
      collectAllIdentifiers(expr.operand, ids, params);
      break;
    case 'ternary':
      collectAllIdentifiers(expr.condition, ids, params);
      collectAllIdentifiers(expr.then, ids, params);
      collectAllIdentifiers(expr.else_, ids, params);
      break;
    case 'call':
      collectAllIdentifiers(expr.callee, ids, params);
      for (const a of expr.args) collectAllIdentifiers(a, ids, params);
      break;
    case 'index':
      collectAllIdentifiers(expr.object, ids, params);
      collectAllIdentifiers(expr.index, ids, params);
      break;
    case 'array':
      for (const el of expr.elements) collectAllIdentifiers(el, ids, params);
      break;
    case 'object':
      for (const p of expr.properties) collectAllIdentifiers(p.value, ids, params);
      break;
    case 'spread':
      collectAllIdentifiers(expr.expr, ids, params);
      break;
    case 'range':
      collectAllIdentifiers(expr.start, ids, params);
      collectAllIdentifiers(expr.end, ids, params);
      break;
    case 'template':
      for (const part of expr.parts) {
        if (typeof part !== 'string') collectAllIdentifiers(part, ids, params);
      }
      break;
  }
}

// Collect reads and writes in always block statements
function collectAlwaysReadsWrites(
  stmts: Statement[],
  reads: Set<string>,
  writes: Set<string>,
  symbols: Map<string, SymbolKind>,
  localScope: Set<string>,
): void {
  for (const stmt of stmts) {
    if (stmt.kind === 'assign') {
      // LHS target is a write
      if (stmt.target.kind === 'identifier') writes.add(stmt.target.name);
      else if (stmt.target.kind === 'member') collectMemberReads(stmt.target, reads, symbols);
      else if (stmt.target.kind === 'index') {
        walkExpr(stmt.target, e => { if (e.kind === 'identifier' && symbols.has(e.name)) reads.add(e.name); });
      }
      // RHS value contains reads
      walkExpr(stmt.value, e => {
        if (e.kind === 'identifier' && (symbols.has(e.name) || localScope.has(e.name)) && !writes.has(e.name)) {
          if (symbols.has(e.name)) reads.add(e.name);
        }
      });
      // Actually, always collect reads from RHS regardless
      walkExpr(stmt.value, e => {
        if (e.kind === 'identifier' && symbols.has(e.name) && isReactiveKind(symbols.get(e.name)!)) {
          reads.add(e.name);
        }
      });
    }
    if (stmt.kind === 'if') {
      walkExpr(stmt.condition, e => {
        if (e.kind === 'identifier' && symbols.has(e.name) && isReactiveKind(symbols.get(e.name)!)) {
          reads.add(e.name);
        }
      });
      collectAlwaysReadsWrites(stmt.then, reads, writes, symbols, localScope);
      if (stmt.else_) collectAlwaysReadsWrites(stmt.else_, reads, writes, symbols, localScope);
    }
    if (stmt.kind === 'expr_stmt') {
      walkExpr(stmt.expr, e => {
        if (e.kind === 'identifier' && symbols.has(e.name) && isReactiveKind(symbols.get(e.name)!)) {
          reads.add(e.name);
        }
      });
    }
    if (stmt.kind === 'return' && stmt.value) {
      walkExpr(stmt.value, e => {
        if (e.kind === 'identifier' && symbols.has(e.name) && isReactiveKind(symbols.get(e.name)!)) {
          reads.add(e.name);
        }
      });
    }
    if (stmt.kind === 'destructure') {
      walkExpr(stmt.value, e => {
        if (e.kind === 'identifier' && symbols.has(e.name) && isReactiveKind(symbols.get(e.name)!)) {
          reads.add(e.name);
        }
      });
      // Add destructured names to local scope
      if (stmt.pattern.kind === 'object') {
        for (const f of stmt.pattern.fields) localScope.add(f.alias ?? f.key);
      } else {
        for (const el of stmt.pattern.elements) localScope.add(el);
        if (stmt.pattern.rest) localScope.add(stmt.pattern.rest);
      }
    }
    if (stmt.kind === 'try') {
      collectAlwaysReadsWrites(stmt.body, reads, writes, symbols, localScope);
      if (stmt.catchParam) localScope.add(stmt.catchParam);
      collectAlwaysReadsWrites(stmt.catchBody, reads, writes, symbols, localScope);
    }
    if (stmt.kind === 'async') {
      collectAlwaysReadsWrites(stmt.body, reads, writes, symbols, localScope);
      if (stmt.catchBody) collectAlwaysReadsWrites(stmt.catchBody, reads, writes, symbols, localScope);
    }
    if (stmt.kind === 'const_decl') {
      // const declarations introduce local variables; track reads from the initializer
      walkExpr(stmt.init, e => {
        if (e.kind === 'identifier' && symbols.has(e.name) && isReactiveKind(symbols.get(e.name)!)) {
          reads.add(e.name);
        }
      });
      // Add to local scope so it's not flagged as undefined
      localScope.add(stmt.name);
    }
  }
}

function collectMemberReads(expr: Expr, reads: Set<string>, symbols: Map<string, SymbolKind>): void {
  if (expr.kind === 'member') {
    if (expr.object.kind === 'identifier' && symbols.has(expr.object.name)) {
      reads.add(expr.object.name);
    } else {
      collectMemberReads(expr.object, reads, symbols);
    }
  }
}

// Cycle detection via topological sort
function detectCycles(deps: Map<string, string[]>): string | null {
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string, path: string[]): string | null {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      const cycle = path.slice(cycleStart).concat(node);
      return `Circular dependency detected: ${cycle.join(' → ')}`;
    }
    if (visited.has(node)) return null;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const dep of deps.get(node) ?? []) {
      const err = dfs(dep, path);
      if (err) return err;
    }

    path.pop();
    inStack.delete(node);
    return null;
  }

  for (const node of deps.keys()) {
    const err = dfs(node, []);
    if (err) return err;
  }
  return null;
}

// Build the static graph from verified module
function exprToString(expr: any): string {
  if (expr.kind === 'literal') return String(expr.value);
  if (expr.kind === 'identifier') return expr.name;
  if (expr.kind === 'binary') return `${exprToString(expr.left)} ${expr.op} ${exprToString(expr.right)}`;
  if (expr.kind === 'unary') return `${expr.op}${exprToString(expr.operand)}`;
  if (expr.kind === 'call' && expr.callee.kind === 'identifier') return `${expr.callee.name}(${expr.args.map(exprToString).join(', ')})`;
  if (expr.kind === 'member') return `${exprToString(expr.object)}.${expr.property}`;
  if (expr.kind === 'ternary') return `${exprToString(expr.condition)} ? ${exprToString(expr.then)} : ${exprToString(expr.else_)}`;
  return '...';
}

function buildGraph(mod: Module, symbols: Map<string, SymbolKind>, enumDefs: Map<string, string[]>, typeEnv: Map<string, CombType>): StaticGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let assertIdx = 0;
  let temporalIdx = 0;

  // Analyze write expressions to infer bounded state spaces for int signals.
  // Walk all always/constraint block bodies and collect RHS of assignments to each signal.
  const signalWriteValues = new Map<string, { literals: Set<string>; hasSelfRef: boolean; hasReset: boolean }>();

  // Collect guard bounds: scan for `if (signal >= N)` or `if (signal > N)` patterns
  // that indicate the upper bound of a counter
  const signalGuardBounds = new Map<string, number>();

  function collectGuardBounds(stmts: Statement[]) {
    for (const stmt of stmts) {
      if (stmt.kind === 'if' && stmt.condition.kind === 'binary') {
        const { left, right, op } = stmt.condition;
        if (left.kind === 'identifier' && right.kind === 'literal' && typeof right.value === 'number') {
          if (op === '>=' || op === '>') {
            const bound = op === '>=' ? right.value : right.value + 1;
            const existing = signalGuardBounds.get(left.name);
            if (existing === undefined || bound < existing) {
              signalGuardBounds.set(left.name, bound);
            }
          }
        }
        collectGuardBounds(stmt.then);
        if (stmt.else_) collectGuardBounds(stmt.else_);
      }
    }
  }

  function collectWritePatterns(stmts: Statement[], scope: Set<string>) {
    for (const stmt of stmts) {
      if (stmt.kind === 'assign' && stmt.target.kind === 'identifier') {
        const name = stmt.target.name;
        if (!symbols.has(name)) continue;
        let info = signalWriteValues.get(name);
        if (!info) { info = { literals: new Set(), hasSelfRef: false, hasReset: false }; signalWriteValues.set(name, info); }
        // Check if RHS is a literal
        if (stmt.value.kind === 'literal') {
          info.literals.add(String(stmt.value.value));
          info.hasReset = true;
        }
        // Check if RHS is an enum member (Member.Variant)
        else if (stmt.value.kind === 'member' && stmt.value.object.kind === 'identifier') {
          info.literals.add(`${stmt.value.object.name}.${stmt.value.property}`);
        }
        // Check if RHS references the signal itself (self-referencing write like x <= x + 1)
        else {
          const refs = new Set<string>();
          collectAllIdentifiers(stmt.value, refs);
          if (refs.has(name)) {
            info.hasSelfRef = true;
          }
        }
      }
      if (stmt.kind === 'if') {
        collectWritePatterns(stmt.then, scope);
        if (stmt.else_) collectWritePatterns(stmt.else_, scope);
      }
      if (stmt.kind === 'async' && 'body' in stmt) {
        collectWritePatterns((stmt as any).body, scope);
      }
    }
  }

  for (const decl of mod.body) {
    if (decl.kind === 'always') {
      collectWritePatterns(decl.body, new Set(decl.trigger.params));
    }
    if (decl.kind === 'constraint') {
      for (const clause of decl.clauses) {
        collectWritePatterns(clause.body, new Set(clause.inputs));
      }
    }
  }

  // Also collect guard bounds from all always blocks
  for (const decl of mod.body) {
    if (decl.kind === 'always') collectGuardBounds(decl.body);
  }

  // Helper: resolve a declaration's type to a valueType string and possible states
  function resolveNodeType(decl: { type?: any; name: string; kind: string }): { valueType?: string; states?: string[] } {
    if ('type' in decl && decl.type) {
      const te = decl.type as any;
      if (te.kind === 'simple') {
        const typeName = te.name;
        if (typeName === 'bool') return { valueType: 'bool', states: ['true', 'false'] };
        if (typeName === 'float' || typeName === 'string') return { valueType: typeName };
        if (typeName === 'int') {
          const writeInfo = signalWriteValues.get(decl.name);
          if (writeInfo) {
            if (writeInfo.hasSelfRef && writeInfo.hasReset) {
              // Self-referencing with reset (e.g. counter <= counter + 1, reset to 0)
              // Check for guard bound: if (counter >= N) → range is 0..N
              const guardBound = signalGuardBounds.get(decl.name);
              if (guardBound !== undefined) {
                const resetVal = [...writeInfo.literals].map(Number).filter(n => !isNaN(n));
                const minVal = resetVal.length > 0 ? Math.min(...resetVal) : 0;
                if (guardBound - minVal <= 256) {
                  const states: string[] = [];
                  for (let v = minVal; v <= guardBound; v++) states.push(String(v));
                  return { valueType: 'int', states };
                }
              }
              // Self-ref with reset but no detectable bound — still likely bounded,
              // include just the literals we found
              if (writeInfo.literals.size > 0 && writeInfo.literals.size <= 32) {
                return { valueType: 'int', states: [...writeInfo.literals] };
              }
            } else if (!writeInfo.hasSelfRef && writeInfo.literals.size > 0 && writeInfo.literals.size <= 32) {
              // No self-reference, only literal writes → finite set of values
              return { valueType: 'int', states: [...writeInfo.literals] };
            }
            // Self-ref without reset (pure counter like cycle++) → unbounded
          }
          return { valueType: 'int' };
        }
        if (enumDefs.has(typeName)) return { valueType: typeName, states: enumDefs.get(typeName)!.map(v => `${typeName}.${v}`) };
      }
      if (te.kind === 'range') {
        if ((te.base === 'int' || te.base === undefined) && typeof te.min === 'number' && typeof te.max === 'number' && (te.max - te.min) <= 256) {
          const states: string[] = [];
          for (let v = te.min; v <= te.max; v++) states.push(String(v));
          return { valueType: te.base ?? 'int', states };
        }
        return { valueType: te.base };
      }
    }
    return {};
  }

  // Helper: infer states for a comb from its inferred type
  function combStates(name: string): { valueType?: string; states?: string[] } {
    const ct = typeEnv.get(name);
    if (!ct) return {};
    if (ct.kind === 'bool') return { valueType: 'bool', states: ['true', 'false'] };
    if (ct.kind === 'int') return { valueType: 'int' };
    if (ct.kind === 'float') return { valueType: 'float' };
    if (ct.kind === 'string') return { valueType: 'string' };
    if (ct.kind === 'enum') return { valueType: ct.name, states: (enumDefs.get(ct.name) ?? []).map(v => `${ct.name}.${v}`) };
    return {};
  }

  for (const decl of mod.body) {
    if (decl.kind === 'input') {
      const { valueType, states } = resolveNodeType(decl);
      nodes.push({ id: decl.name, name: decl.name, type: 'signal', valueType, states });
    }
    if (decl.kind === 'output') {
      const { valueType, states } = resolveNodeType(decl);
      nodes.push({ id: decl.name, name: decl.name, type: 'signal', valueType, states });
    }
    if (decl.kind === 'signal') {
      const { valueType, states } = resolveNodeType(decl);
      nodes.push({ id: decl.name, name: decl.name, type: 'signal', valueType, states });
    }
    if (decl.kind === 'token') {
      nodes.push({ id: decl.name, name: decl.name, type: 'signal', isToken: true });
    }
    if (decl.kind === 'comb') {
      const { valueType, states } = combStates(decl.name);
      nodes.push({ id: decl.name, name: decl.name, type: 'comb', valueType, states });
      for (const dep of decl.deps) {
        edges.push({ from: dep, to: decl.name, type: 'data' });
      }
    }
    if (decl.kind === 'always') {
      if ((decl.triggerKind === 'posedge' || decl.triggerKind === 'negedge') && decl.trigger.signals) {
        // Edge-triggered: similar to sensitivity
        const edgeId = `${decl.triggerKind}:${decl.trigger.signals.join(',')}`;
        nodes.push({ id: edgeId, name: `${decl.triggerKind}(${decl.trigger.signals.join(', ')})`, type: 'sensitivity' });
        for (const sig of decl.trigger.signals) {
          if (sig !== 'expr' && symbols.has(sig)) {
            edges.push({ from: sig, to: edgeId, type: 'data' });
          }
        }
        for (const w of decl.writes) {
          edges.push({ from: edgeId, to: w, type: 'write' });
        }
      } else if (decl.triggerKind === 'sensitivity' && decl.trigger.signals) {
        // Sensitivity block: signals → sensitivity node → written signals
        const sensId = `sense:${decl.trigger.signals.join(',')}`;
        nodes.push({ id: sensId, name: decl.trigger.signals.join(', '), type: 'sensitivity' });
        for (const sig of decl.trigger.signals) {
          edges.push({ from: sig, to: sensId, type: 'data' });
        }
        for (const w of decl.writes) {
          edges.push({ from: sensId, to: w, type: 'write' });
        }
      } else {
        const eventId = `event:${decl.trigger.name}`;
        nodes.push({ id: eventId, name: decl.trigger.name, type: 'event' });
        for (const w of decl.writes) {
          edges.push({ from: eventId, to: w, type: 'write' });
        }
      }
    }
    if (decl.kind === 'assert') {
      const assertId = `assert:${assertIdx++}`;
      const exprText = exprToString(decl.expr);
      nodes.push({ id: assertId, name: assertId, type: 'assert', expr: exprText });
      for (const dep of decl.deps) {
        edges.push({ from: dep, to: assertId, type: 'data' });
      }
    }
    if (decl.kind === 'temporal_assert') {
      const edgeLabel = decl.triggerEdge === 'negedge' ? 'negedge' : 'posedge';
      const triggerText = exprToString(decl.trigger);
      const propText = exprToString(decl.property);
      const withinText = decl.duration !== undefined ? ` within ${decl.duration}` : '';
      const tempId = `${edgeLabel}(${triggerText}) ${decl.operator}(${propText})${withinText}`;
      nodes.push({ id: tempId, name: tempId, type: 'assert', expr: tempId });
      for (const dep of decl.deps) {
        edges.push({ from: dep, to: tempId, type: 'data' });
      }
      temporalIdx++;
    }
    if (decl.kind === 'cell') {
      nodes.push({ id: decl.name, name: decl.name, type: 'cell' });
    }
    if (decl.kind === 'constraint') {
      // Per-clause subnodes for constraint hardening
      for (let ci = 0; ci < decl.clauses.length; ci++) {
        const clause = decl.clauses[ci];
        const clauseId = `constraint:${decl.name}:${ci}`;
        nodes.push({ id: clauseId, name: `${decl.name}[${ci}]`, type: 'constraint' });

        // Input edges: from clause inputs to clause subnode
        for (const inp of clause.inputs) {
          edges.push({ from: inp, to: clauseId, type: 'data' });
        }

        // Write edges: from clause subnode to written cells
        const clauseWrites = new Set<string>();
        collectAlwaysReadsWrites(clause.body, new Set(), clauseWrites, symbols, new Set());
        for (const w of clauseWrites) {
          edges.push({ from: clauseId, to: w, type: 'write' });
        }
      }
    }
    if (decl.kind === 'view') {
      const viewEffects: { id: string; deps: string[]; viewTarget: { element: string; binding: string } }[] = [];
      collectViewEffects(decl.children, 'root', viewEffects, symbols);
      for (const eff of viewEffects) {
        nodes.push({ id: eff.id, name: eff.id, type: 'view-effect', viewTarget: eff.viewTarget });
        for (const dep of eff.deps) {
          edges.push({ from: dep, to: eff.id, type: 'data' });
        }
      }
    }
  }

  // Build enum definitions map
  const enums: Record<string, string[]> = {};
  for (const [name, variants] of enumDefs) {
    enums[name] = variants;
  }

  return { nodes, edges, enums: Object.keys(enums).length > 0 ? enums : undefined };
}

function getElementDesc(vn: VNode): string {
  if (vn.kind === 'element') {
    let desc = vn.tag;
    for (const attr of vn.attrs) {
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
  if (vn.kind === 'component') return vn.name;
  return 'root';
}

function primaryReactiveName(expr: Expr, symbols: Map<string, SymbolKind>): string {
  if (expr.kind === 'identifier' && symbols.has(expr.name) && isReactiveKind(symbols.get(expr.name)!)) return expr.name;
  if (expr.kind === 'call' && expr.callee.kind === 'identifier') return expr.callee.name;
  if (expr.kind === 'binary') return primaryReactiveName(expr.left, symbols) || primaryReactiveName(expr.right, symbols);
  if (expr.kind === 'unary') return primaryReactiveName(expr.operand, symbols);
  if (expr.kind === 'ternary') return primaryReactiveName(expr.condition, symbols);
  if (expr.kind === 'member') return primaryReactiveName(expr.object, symbols);
  return '';
}

function exprHasReactive(expr: Expr, symbols: Map<string, SymbolKind>): boolean {
  let found = false;
  walkExpr(expr, e => { if (e.kind === 'identifier' && symbols.has(e.name) && isReactiveKind(symbols.get(e.name)!)) found = true; });
  return found;
}

function collectExprDeps(expr: Expr, symbols: Map<string, SymbolKind>): string[] {
  const deps = new Set<string>();
  walkExpr(expr, e => { if (e.kind === 'identifier' && symbols.has(e.name) && isReactiveKind(symbols.get(e.name)!)) deps.add(e.name); });
  return [...deps];
}

function collectViewEffects(
  vnodes: VNode[],
  parentDesc: string,
  effects: { id: string; deps: string[]; viewTarget: { element: string; binding: string } }[],
  symbols: Map<string, SymbolKind>,
): void {
  for (const vn of vnodes) {
    if (vn.kind === 'expr' && exprHasReactive(vn.expr, symbols)) {
      const deps = collectExprDeps(vn.expr, symbols);
      const name = primaryReactiveName(vn.expr, symbols) || deps[0] || 'expr';
      effects.push({ id: `view:${name}`, deps, viewTarget: { element: parentDesc, binding: 'text' } });
    }
    if (vn.kind === 'element') {
      const elDesc = getElementDesc(vn);
      for (const attr of vn.attrs) {
        if (attr.isBind && attr.value) {
          const deps = collectExprDeps(attr.value, symbols);
          if (deps.length > 0) {
            const name = primaryReactiveName(attr.value, symbols) || deps[0];
            effects.push({ id: `view:bind:${name}`, deps, viewTarget: { element: elDesc, binding: `bind:${attr.name}` } });
          }
        } else if (attr.value && !attr.isEvent && exprHasReactive(attr.value, symbols)) {
          const deps = collectExprDeps(attr.value, symbols);
          const name = primaryReactiveName(attr.value, symbols) || deps[0];
          effects.push({ id: `view:attr:${attr.name}`, deps, viewTarget: { element: elDesc, binding: `attr:${attr.name}` } });
        }
      }
      collectViewEffects(vn.children, elDesc, effects, symbols);
    }
    if (vn.kind === 'component') {
      const compDesc = getElementDesc(vn);
      collectViewEffects(vn.children, compDesc, effects, symbols);
    }
    if (vn.kind === 'if') {
      const condDeps = collectExprDeps(vn.condition, symbols);
      if (condDeps.length > 0) {
        const name = primaryReactiveName(vn.condition, symbols) || condDeps[0];
        effects.push({ id: `view:if:${name}`, deps: condDeps, viewTarget: { element: parentDesc, binding: 'if' } });
      }
      collectViewEffects(vn.then, parentDesc, effects, symbols);
      if (vn.else_) collectViewEffects(vn.else_, parentDesc, effects, symbols);
    }
    if (vn.kind === 'for') {
      const iterDeps = collectExprDeps(vn.iterable, symbols);
      if (iterDeps.length > 0) {
        const name = primaryReactiveName(vn.iterable, symbols) || iterDeps[0];
        effects.push({ id: `view:for:${name}`, deps: iterDeps, viewTarget: { element: parentDesc, binding: 'for' } });
      }
      collectViewEffects(vn.body, parentDesc, effects, symbols);
    }
  }
}

// CDC-style async boundary analysis
// Detects unsynchronized async writes, race conditions, and missing error handling
function analyzeAsyncBoundaries(
  mod: Module,
  symbols: Map<string, SymbolKind>,
  warnings: CompileWarning[],
): void {
  // Track which signals are written by async blocks and where
  const asyncWrites = new Map<string, { triggerName: string; line: number }[]>();

  for (const decl of mod.body) {
    if (decl.kind !== 'always') continue;

    for (const stmt of decl.body) {
      if (stmt.kind !== 'async') continue;

      // Collect writes inside this async block
      const asyncBlockWrites = new Set<string>();
      collectWritesFromStatements(stmt.body, asyncBlockWrites, symbols);

      // Also collect writes from catchBody if present
      if (stmt.catchBody) {
        collectWritesFromStatements(stmt.catchBody, asyncBlockWrites, symbols);
      }

      for (const sig of asyncBlockWrites) {
        if (!asyncWrites.has(sig)) asyncWrites.set(sig, []);
        asyncWrites.get(sig)!.push({ triggerName: decl.trigger.name, line: stmt.loc.line });
      }

      // Warning (c): Missing catch — async block writes signals but has no catch
      if (asyncBlockWrites.size > 0 && !stmt.catchBody) {
        const signalList = [...asyncBlockWrites].join(', ');
        warnings.push({
          message: `CDC: async block in always @(${decl.trigger.name}) writes signal '${signalList}' but has no catch block — signal may be left stale on error`,
          line: stmt.loc.line,
          column: stmt.loc.column,
        });
      }
    }
  }

  // Warning (b): Race condition — two+ async blocks write the same signal
  for (const [sig, sources] of asyncWrites) {
    if (sources.length >= 2) {
      const sourceDescs = sources.map(s => `always @(${s.triggerName}) line ${s.line}`).join(', ');
      warnings.push({
        message: `CDC: signal '${sig}' is written by multiple async blocks (${sourceDescs}) — potential race condition`,
        line: sources[0].line,
        column: 1,
      });
    }
  }

  // Warning (a): Unsynchronized async write — a comb reads an async-written signal
  // Build transitive taint set: start with directly async-written signals,
  // then propagate through comb dependency chains (fixed-point iteration)
  const taintedSignals = new Set<string>(asyncWrites.keys());

  // Build a map of comb name -> deps for propagation
  const combDepMap = new Map<string, string[]>();
  for (const decl of mod.body) {
    if (decl.kind === 'comb') {
      combDepMap.set(decl.name, decl.deps);
    }
  }

  // Fixed-point: propagate taint through combs
  let changed = true;
  while (changed) {
    changed = false;
    for (const [combName, deps] of combDepMap) {
      if (!taintedSignals.has(combName) && deps.some(d => taintedSignals.has(d))) {
        taintedSignals.add(combName);
        changed = true;
      }
    }
  }

  // Check each comb for tainted dependencies
  for (const decl of mod.body) {
    if (decl.kind !== 'comb') continue;
    for (const dep of decl.deps) {
      if (taintedSignals.has(dep)) {
        if (asyncWrites.has(dep)) {
          // Direct: dep is itself async-written
          const sources = asyncWrites.get(dep)!;
          const sourceDesc = sources.map(s => `always @(${s.triggerName}), async block at line ${s.line}`).join('; ');
          warnings.push({
            message: `CDC: signal '${dep}' is written asynchronously (${sourceDesc}) but read synchronously by comb '${decl.name}' — consider adding a loading guard`,
            line: decl.loc.line,
            column: decl.loc.column,
          });
        } else {
          // Transitive: dep is a comb that transitively reads an async-written signal
          warnings.push({
            message: `CDC: comb '${decl.name}' transitively reads async-written signal through '${dep}' — consider adding a loading guard`,
            line: decl.loc.line,
            column: decl.loc.column,
          });
        }
      }
    }
  }
}

// Helper: collect signal write targets from a list of statements (non-recursive into nested async)
function collectWritesFromStatements(
  stmts: Statement[],
  writes: Set<string>,
  symbols: Map<string, SymbolKind>,
): void {
  for (const stmt of stmts) {
    if (stmt.kind === 'assign') {
      if (stmt.target.kind === 'identifier' && symbols.has(stmt.target.name)) {
        writes.add(stmt.target.name);
      }
    }
    if (stmt.kind === 'if') {
      collectWritesFromStatements(stmt.then, writes, symbols);
      if (stmt.else_) collectWritesFromStatements(stmt.else_, writes, symbols);
    }
    if (stmt.kind === 'try') {
      collectWritesFromStatements(stmt.body, writes, symbols);
      collectWritesFromStatements(stmt.catchBody, writes, symbols);
    }
    if (stmt.kind === 'async') {
      collectWritesFromStatements((stmt as any).body, writes, symbols);
      if ((stmt as any).catchBody) {
        collectWritesFromStatements((stmt as any).catchBody, writes, symbols);
      }
    }
  }
}

// Walk all sub-expressions
function walkExpr(expr: Expr, fn: (e: Expr) => void): void {
  fn(expr);
  switch (expr.kind) {
    case 'binary': walkExpr(expr.left, fn); walkExpr(expr.right, fn); break;
    case 'unary': walkExpr(expr.operand, fn); break;
    case 'ternary': walkExpr(expr.condition, fn); walkExpr(expr.then, fn); walkExpr(expr.else_, fn); break;
    case 'call': walkExpr(expr.callee, fn); expr.args.forEach(a => walkExpr(a, fn)); break;
    case 'member': walkExpr(expr.object, fn); break;
    case 'index': walkExpr(expr.object, fn); walkExpr(expr.index, fn); break;
    case 'array': expr.elements.forEach(e => walkExpr(e, fn)); break;
    case 'spread': walkExpr(expr.expr, fn); break;
    case 'lambda': walkExpr(expr.body, fn); break;
    case 'range': walkExpr(expr.start, fn); walkExpr(expr.end, fn); break;
    case 'object': expr.properties.forEach(p => walkExpr(p.value, fn)); break;
    case 'template': expr.parts.forEach(p => { if (typeof p !== 'string') walkExpr(p, fn); }); break;
    case 'await': walkExpr(expr.expr, fn); break;
  }
}
