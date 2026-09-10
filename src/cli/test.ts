// test.ts — Fuzz-test runner for .comb modules

import { compile } from '../core/compiler.js';
import { circuit } from '../runtime/circuit.js';
import { batch, advanceTemporalTick } from '../runtime/signals.js';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

// --- Deterministic PRNG (mulberry32) ---
function mulberry32(a: number) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// --- CLI arg parsing ---
const args = process.argv.slice(2);
const flags: Record<string, string> = {};
let inputFile = '';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--verbose') {
    flags.verbose = 'true';
  } else if (arg === '--iterations' || arg === '--seed' || arg === '--settle-turns') {
    const value = args[++i];
    if (value === undefined) {
      console.error(`Error: ${arg} requires a value`);
      process.exit(1);
    }
    flags[arg.slice(2)] = value;
  } else if (arg.startsWith('--') || inputFile) {
    console.error(`Error: unexpected argument ${arg}`);
    process.exit(1);
  } else {
    inputFile = arg;
  }
}

if (!inputFile) {
  console.error('Usage: comb test <file.comb> [--iterations N] [--seed N] [--settle-turns N] [--verbose]');
  process.exit(1);
}

const iterations = Number(flags.iterations ?? '1000');
const seed = Number(flags.seed ?? String(Date.now()));
const verbose = 'verbose' in flags;
const settleTurns = Number(flags['settle-turns'] ?? '1000');
if (!Number.isSafeInteger(settleTurns) || settleTurns < 0) {
  console.error('Error: settle-turns must be a nonnegative integer');
  process.exit(1);
}
if (!Number.isSafeInteger(iterations) || iterations <= 0) {
  console.error('Error: iterations must be a positive integer');
  process.exit(1);
}
if (!Number.isSafeInteger(seed)) {
  console.error('Error: seed must be an integer');
  process.exit(1);
}

// --- Compile ---
let source: string;
try {
  source = readFileSync(inputFile, 'utf-8');
} catch {
  console.error(`Error: cannot read ${inputFile}`);
  process.exit(1);
}

const result = compile(source);
if (result.errors.length > 0) {
  for (const err of result.errors) console.error(`  Error ${err.line}:${err.column}: ${err.message}`);
  process.exit(1);
}

// --- Write temp file with corrected import path ---
const tmpDir = mkdtempSync(join(tmpdir(), 'comb-test-'));

const runtimePath = new URL('../runtime/index.ts', import.meta.url).href;
const js = result.js!.replace(
  /from\s+['"]\.\.\/runtime\/index\.js['"]/g,
  `from '${runtimePath}'`
);

const tmpFile = join(tmpDir, basename(inputFile, '.comb') + '.test.mjs');
writeFileSync(tmpFile, js);

// --- Dynamic import and run ---
async function run() {
  circuit.reset();

  const mod = await import(pathToFileURL(tmpFile).href);
  const { __test, __graph } = mod;

  if (typeof __test !== 'function') {
    throw new Error('compiled module has no __test() export');
  }

  // Track assertion failures
  let assertionFailures: Array<{ expr: string; values: Record<string, any> }> = [];
  const unsub = circuit.subscribe((event) => {
    if (event.type === 'assertion-failed' && event.assertInfo) {
      assertionFailures.push({ expr: event.assertInfo.expr, values: event.assertInfo.values });
    }
  });

  const instance = __test();
  const { signals, combs, dispose } = instance;

  // Build type map from circuit nodes (runtime has valueType from createSignal meta)
  const signalTypes: Record<string, string> = {};
  for (const node of circuit.getNodes()) {
    if (node.type === 'signal' && node.valueType) {
      signalTypes[node.name] = node.valueType;
    }
  }

  // Fallback: infer from __graph static nodes
  for (const name of Object.keys(signals)) {
    if (!signalTypes[name]) signalTypes[name] = 'string';
  }

  const rand = mulberry32(seed);
  const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789@.';

  function randomString(): string {
    const len = Math.floor(rand() * 16);
    let s = '';
    for (let i = 0; i < len; i++) s += CHARS[Math.floor(rand() * CHARS.length)];
    return s;
  }

  function randomValue(type: string): any {
    switch (type) {
      case 'string': return randomString();
      case 'int': return Math.floor(rand() * 300) - 100;
      case 'float': return rand() * 300 - 100;
      case 'bool': return rand() < 0.5;
      default: return randomString();
    }
  }

  // Track comb coverage (distinct values)
  const combCoverage = new Map<string, Set<string>>();
  for (const name of Object.keys(combs)) {
    combCoverage.set(name, new Set());
  }

  // --- Run iterations ---
  for (let i = 0; i < iterations; i++) {
    batch(() => {
      for (const [name, sig] of Object.entries(signals) as [string, { get: () => any; set: (v: any) => void }][]) {
        sig.set(randomValue(signalTypes[name]));
      }
    });

    // Read all combs to track coverage
    for (const [name, getter] of Object.entries(combs) as [string, () => any][]) {
      const val = getter();
      combCoverage.get(name)!.add(String(val));
    }
  }

  let settled = 0;
  while (circuit.getTemporalAssertions().some(state => state.pending > 0) && settled < settleTurns) {
    advanceTemporalTick();
    settled++;
  }
  const temporal = circuit.getTemporalAssertions();
  const incomplete = temporal.some(state => state.pending > 0 || state.triggered === 0);
  unsub();

  // --- Report ---
  const fileName = basename(inputFile);
  console.log(`\n  comb test — ${fileName}`);
  console.log(`  seed: ${seed}  iterations: ${iterations}\n`);

  if (assertionFailures.length === 0) {
    console.log('  assertions: no failures observed in this input sweep');
  } else {
    console.log(`  assertions: ✗ ${assertionFailures.length} failures`);
    const unique = new Set(assertionFailures.map(f => f.expr));
    for (const expr of unique) {
      console.log(`    FAIL: ${expr}`);
    }
  }

  for (const state of temporal) {
    console.log(`  temporal ${state.name}: ${state.triggered} triggered, ${state.passed} passed, ${state.failed} failed, ${state.pending} pending${state.triggered === 0 ? ' (unexercised)' : ''}`);
  }
  if (incomplete) console.log('  temporal verification incomplete (exit 2): pending or unexercised assertions');

  // Boolean coverage: combs that only produced true/false values
  const boolCombs: string[] = [];
  for (const [name, values] of combCoverage) {
    const strs = [...values];
    const isBool = strs.every(v => v === 'true' || v === 'false');
    if (isBool) boolCombs.push(name);
  }

  const coveredBoth = boolCombs.filter(name => {
    const vals = combCoverage.get(name)!;
    return vals.has('true') && vals.has('false');
  });

  if (boolCombs.length > 0) {
    const pct = Math.round((coveredBoth.length / boolCombs.length) * 100);
    console.log(`  coverage:   ${pct}% (${coveredBoth.length}/${boolCombs.length} boolean combs hit both branches)`);
  } else {
    console.log('  coverage:   no boolean combs');
  }

  if (verbose) {
    console.log('\n  per-comb detail:');
    for (const [name, values] of combCoverage) {
      const strs = [...values];
      const isBool = strs.every(v => v === 'true' || v === 'false');
      const covered = isBool ? (values.has('true') && values.has('false') ? '✓' : '✗') : '-';
      console.log(`    ${covered} ${name}: ${strs.length} distinct values [${strs.slice(0, 5).join(', ')}${strs.length > 5 ? ', ...' : ''}]`);
    }
  }

  dispose();
  console.log('');

  process.exitCode = assertionFailures.length > 0 ? 1 : incomplete ? 2 : 0;
}

run().catch((err) => {
  console.error('Test runner error:', err);
  process.exitCode = 1;
}).finally(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});
