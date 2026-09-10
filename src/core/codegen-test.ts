// codegen-test.ts — Tests for the codegen output
// Run: npx tsx src/core/codegen-test.ts

import { compile } from './compiler.js';
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

console.log('\nCodegen Tests\n');

// Test 1: counter.comb generates valid-shaped JS
test('counter.comb — generates JS with expected structure', () => {
  const source = fs.readFileSync(path.resolve('examples/counter.comb'), 'utf-8');
  const result = compile(source);
  assert(result.errors.length === 0, `Compile errors: ${result.errors.map(e => e.message)}`);
  assert(result.js !== undefined, 'Expected JS output');

  const js = result.js!;

  // Import from runtime
  assert(js.includes("import { createSignal, createComb, createEffect, batch, createScope, circuit, X } from '../runtime/index.js'"), 'Missing runtime import');

  // Static graph export
  assert(js.includes('export const __graph ='), 'Missing __graph export');

  // Module factory export
  assert(js.includes('export function Counter(root)'), 'Missing Counter factory export');

  // Signal creation with meta
  assert(js.includes('createSignal(0,'), 'Missing createSignal call');
  assert(js.includes("name: 'count'"), 'Missing signal name meta');
  assert(js.includes("module: $m"), 'Missing signal module meta');

  // Comb creation with deps
  assert(js.includes('createComb('), 'Missing createComb call');
  assert(js.includes("name: 'label'"), 'Missing comb name meta');
  assert(js.includes('["count"]'), 'Missing comb deps for label');

  // Event handlers wrapped in batch
  assert(js.includes('function increment()'), 'Missing increment handler');
  assert(js.includes('function decrement()'), 'Missing decrement handler');
  assert(js.includes('function reset()'), 'Missing reset handler');
  assert(js.includes('batch(() => {'), 'Missing batch wrapper');

  // Signal setter
  assert(js.includes('setCount('), 'Missing setCount call');

  // DOM creation
  assert(js.includes("document.createElement('div')"), 'Missing createElement');
  assert(js.includes("document.createTextNode("), 'Missing createTextNode');

  // Reactive text binding
  assert(js.includes('createEffect('), 'Missing createEffect');
  assert(js.includes('.data = String('), 'Missing reactive text binding');

  // Event binding
  assert(js.includes("addEventListener('click'"), 'Missing click event binding');
});

// Test 2: traffic-light.comb generates JS with enum and conditional
test('traffic-light.comb — generates JS with enum and @if', () => {
  const source = fs.readFileSync(path.resolve('examples/traffic-light.comb'), 'utf-8');
  const result = compile(source);
  assert(result.errors.length === 0, `Compile errors: ${result.errors.map(e => e.message)}`);
  const js = result.js!;

  // Enum
  assert(js.includes('const Phase = Object.freeze({'), 'Missing enum');
  assert(js.includes("Red: 'Phase.Red'"), 'Missing enum variant');

  // @if in view
  assert(js.includes("document.createComment('@if')"), 'Missing @if comment anchor');

  // Conditional rendering effect
  assert(js.includes('.remove()'), 'Missing conditional cleanup');
  assert(js.includes("display = 'contents'"), 'Missing contents display');
});

// Test 3: JS output is syntactically valid (no runtime errors during parse)
test('counter.comb — generated JS is parseable', () => {
  const source = fs.readFileSync(path.resolve('examples/counter.comb'), 'utf-8');
  const result = compile(source);
  const js = result.js!;

  // Strip imports and exports (not valid in Function constructor) to test syntax
  const jsStripped = js
    .replace(/^import .*/gm, '// import stripped')
    .replace(/^export /gm, '');
  try {
    new Function(jsStripped);
  } catch (e: any) {
    throw new Error(`Generated JS has syntax error: ${e.message}\n\nGenerated code:\n${jsStripped}`);
  }
});

// Test 4: __graph is valid JSON-serializable
test('__graph is JSON-serializable', () => {
  const source = fs.readFileSync(path.resolve('examples/counter.comb'), 'utf-8');
  const result = compile(source);
  const js = result.js!;

  // Extract __graph value from JS
  const match = js.match(/export const __graph = ([\s\S]*?);$/m);
  assert(match !== null, 'Could not extract __graph');
  try {
    const graph = JSON.parse(match![1]);
    assert(Array.isArray(graph.nodes), '__graph.nodes should be array');
    assert(Array.isArray(graph.edges), '__graph.edges should be array');
    assert(graph.nodes.length > 0, '__graph should have nodes');
    assert(graph.edges.length > 0, '__graph should have edges');
  } catch (e: any) {
    throw new Error(`__graph is not valid JSON: ${e.message}`);
  }
});

// Test 5: signal reads use function call syntax
test('signals and combs read via function call', () => {
  const source = `
module ReadTest {
  signal x: int = 5;
  comb doubled = x * 2;
  view {
    <p>{doubled}</p>
  }
}`;
  const result = compile(source);
  assert(result.errors.length === 0, `Errors: ${result.errors.map(e => e.message)}`);
  const js = result.js!;

  // Inside comb expression: x() not x
  assert(js.includes('x()'), 'Signal should be read as x()');
  // Inside view expression: doubled() not doubled
  assert(js.includes('doubled()'), 'Comb should be read as doubled()');
});

// Test 6: Edge-triggered always block codegen
test('posedge always block — generates createEdgeEffect', () => {
  const source = `
module EdgeGen {
  signal clk: bool = false;
  signal out: int = 0;

  always @(posedge clk) {
    out <= out + 1;
  }
}`;
  const result = compile(source);
  assert(result.errors.length === 0, `Errors: ${result.errors.map(e => e.message)}`);
  const js = result.js!;

  assert(js.includes('createEdgeEffect'), 'Missing createEdgeEffect import/call');
  assert(js.includes("'posedge'"), 'Missing posedge type');
  assert(js.includes('deferredBatch('), 'Edge body must preserve nonblocking assignment semantics');
  assert(js.includes('setOut'), 'Should call setter');
});

// Test 7: Temporal assertion codegen
test('temporal assertion — generates createTemporalAssert', () => {
  const source = `
module TempAssert {
  signal x: bool = false;
  signal y: bool = false;

  assert temporal @(x) eventually(y) within 2000;
}`;
  const result = compile(source);
  assert(result.errors.length === 0, `Errors: ${result.errors.map(e => e.message)}`);
  const js = result.js!;

  assert(js.includes('createTemporalAssert'), 'Missing createTemporalAssert');
  assert(js.includes("'eventually'"), 'Missing operator');
  assert(js.includes('duration: 2000'), 'Missing duration');
});

// Test 8: New builtins in codegen
test('new builtins — generate correct JS', () => {
  const source = `
module Builtins {
  signal arr: int[] = [1, 2, 3];
  signal x: float = 3.14;
  comb f = floor(x);
  comb r = round(x);
  comb mx = max(x, 0);
  comb mn = min(x, 10);
  comb ab = abs(x);
}`;
  const result = compile(source);
  assert(result.errors.length === 0, `Errors: ${result.errors.map(e => e.message)}`);
  const js = result.js!;

  assert(js.includes('Math.floor('), 'floor should emit Math.floor');
  assert(js.includes('Math.round('), 'round should emit Math.round');
  assert(js.includes('Math.max('), 'max should emit Math.max');
  assert(js.includes('Math.min('), 'min should emit Math.min');
  assert(js.includes('Math.abs('), 'abs should emit Math.abs');
});

// Test 10: Constraint locals codegen
test('constraint — uses locals in body', () => {
  const source = `
module ConstraintTest {
  cell celsius: float = 0.0;
  cell fahrenheit: float = 32.0;

  constraint convert {
    (celsius) => {
      fahrenheit <= celsius * 9.0 / 5.0 + 32.0;
    }
    (fahrenheit) => {
      celsius <= (fahrenheit - 32.0) * 5.0 / 9.0;
    }
  }
}`;
  const result = compile(source);
  assert(result.errors.length === 0, `Errors: ${result.errors.map(e => e.message)}`);
  const js = result.js!;

  // Body should use __celsius and __fahrenheit locals
  assert(js.includes('const __celsius = celsius()'), 'Should read celsius into local');
  assert(js.includes('const __fahrenheit = fahrenheit()'), 'Should read fahrenheit into local');
  // Body expressions should use locals not signal calls
  assert(js.includes('__celsius'), 'Body should reference __celsius');
  assert(js.includes('__fahrenheit'), 'Body should reference __fahrenheit');
  // Should include writes metadata
  assert(js.includes("writes:"), 'Should include writes metadata');
});

// =============================================
// Feature: fn declarations codegen
// =============================================

// Test 11: fn generates readable JS function
test('fn declaration — generates readable JS function', () => {
  const source = `
module FnCodegen {
  fn clamp(x: int, min: int, max: int) -> int {
    x < min ? min : x > max ? max : x;
  }

  signal val: int = 15;
  comb clamped = clamp(val, 0, 10);
}`;
  const result = compile(source);
  assert(result.errors.length === 0, `Errors: ${result.errors.map(e => e.message)}`);
  const js = result.js!;

  assert(js.includes('function clamp(x, min, max)'), 'Should emit function with params');
  assert(js.includes('return'), 'Should have return for last expr');
  assert(js.includes('clamp(val()'), 'Should call user function with reactive arg');
});

// =============================================
// Feature: Template literals codegen
// =============================================

// Test 12: Template literal emits JS template literal
test('template literal — emits JS template literal', () => {
  const source = `
module TemplateCodegen {
  signal name: string = "world";
  comb msg = \`hello \${name}\`;
}`;
  const result = compile(source);
  assert(result.errors.length === 0, `Errors: ${result.errors.map(e => e.message)}`);
  const js = result.js!;

  assert(js.includes('`hello ${name()}`'), 'Should emit JS template literal with interpolation');
});

// =============================================
// Feature: Destructuring codegen
// =============================================

// Test 13: Object destructuring emits correct JS
test('destructuring — emits correct JS', () => {
  const source = `
module DestructCodegen {
  signal data: { a: int, b: int } = { a: 1, b: 2 };
  signal out: int = 0;

  always @(process) {
    const { a, b } = data;
    out <= a;
  }
}`;
  const result = compile(source);
  assert(result.errors.length === 0, `Errors: ${result.errors.map(e => e.message)}`);
  const js = result.js!;

  assert(js.includes('const { a, b } = data()'), 'Should emit object destructuring with signal read');
});

// =============================================
// Feature: Try/catch codegen
// =============================================

// Test 14: Try/catch emits correct JS
test('try/catch — emits correct JS', () => {
  const source = `
module TryCatchCodegen {
  signal x: int = 0;
  signal err: string = "";

  always @(doIt) {
    try {
      x <= 1;
    } catch (e) {
      err <= "failed";
    }
  }
}`;
  const result = compile(source);
  assert(result.errors.length === 0, `Errors: ${result.errors.map(e => e.message)}`);
  const js = result.js!;

  assert(js.includes('try {'), 'Should emit try');
  assert(js.includes('} catch (e) {'), 'Should emit catch with param');
  assert(js.includes('setX(1)'), 'Try body should set X');
  assert(js.includes('setErr("failed")'), 'Catch body should set err');
});

// Test 15: Method call codegen — arr.map(|x| x + 1)
test('method call — items.map generates correct JS', () => {
  const source = `
module MethodGen {
  signal items: int[] = [1, 2, 3];
  comb doubled = items.map(|x| x + 1);
}`;
  const result = compile(source);
  assert(result.errors.length === 0, `Errors: ${result.errors.map(e => e.message)}`);
  const js = result.js!;

  assert(js.includes('items().map((x) => (x + 1))'), 'Should emit items().map((x) => (x + 1))');
});

// Test 16: Object.keys codegen
test('Object.keys — generates correct JS', () => {
  const source = `
module GlobalGen {
  signal obj: string = "{}";
  comb keys = Object.keys(obj);
}`;
  const result = compile(source);
  assert(result.errors.length === 0, `Errors: ${result.errors.map(e => e.message)}`);
  const js = result.js!;

  assert(js.includes('Object.keys(obj())'), 'Should emit Object.keys(obj())');
});

// Test 17: Slot codegen
test('slot — generates __children insertion', () => {
  const source = `
module Wrapper {
  input label: string = "";
  view {
    <div>
      <slot />
    </div>
  }
}`;
  const result = compile(source);
  assert(result.errors.length === 0, `Errors: ${result.errors.map(e => e.message)}`);
  const js = result.js!;

  assert(js.includes('__children'), 'Should reference __children');
  assert(js.includes('appendChild(__children)'), 'Should append __children');
});

// Test 18: Select bind codegen
test('select @bind — correct codegen', () => {
  const source = `
module SelectGen {
  signal val: string = "a";
  view {
    <select @bind=val>
      <option value="a">A</option>
    </select>
  }
}`;
  const result = compile(source);
  assert(result.errors.length === 0, `Errors: ${result.errors.map(e => e.message)}`);
  const js = result.js!;

  assert(js.includes("addEventListener('change'"), 'Should use change event for select');
  assert(js.includes('.value = val()'), 'Should set value property');
});

// Test 19: Checkbox bind codegen
test('checkbox @bind — correct codegen', () => {
  const source = `
module CheckGen {
  signal flag: bool = false;
  view {
    <input type="checkbox" @bind=flag />
  }
}`;
  const result = compile(source);
  assert(result.errors.length === 0, `Errors: ${result.errors.map(e => e.message)}`);
  const js = result.js!;

  assert(js.includes('.checked = flag()'), 'Should set checked property');
  assert(js.includes('e.target.checked'), 'Should read checked from event');
  assert(js.includes("addEventListener('change'"), 'Should use change event');
});

// Test 20: Textarea bind codegen
test('textarea @bind — correct codegen', () => {
  const source = `
module TextareaGen {
  signal text: string = "";
  view {
    <textarea @bind=text></textarea>
  }
}`;
  const result = compile(source);
  assert(result.errors.length === 0, `Errors: ${result.errors.map(e => e.message)}`);
  const js = result.js!;

  assert(js.includes('.value = text()'), 'Should set value property');
  assert(js.includes("addEventListener('input'"), 'Should use input event for textarea');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
