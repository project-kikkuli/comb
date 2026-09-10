#!/usr/bin/env node
// cli.ts — Node.js CLI wrapper for the Comb compiler

import { compile } from '../core/compiler.js';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, basename, resolve } from 'path';
import { execSync } from 'child_process';

const VERSION = '0.1.0';

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  console.log(`
  comb v${VERSION} — SystemVerilog-inspired reactive web framework

  Usage:
    comb compile <file.comb>     Compile a single .comb file
    comb compile --all           Compile all .comb files in examples/
    comb init <project-name>     Scaffold a new Comb project
    comb dev                     Start Vite dev server
    comb test <file.comb>        Run fuzz tests on a .comb file
    comb diff <a.comb> <b.comb>  Diff reactive topology between two .comb files
    comb --help                  Show this help message
    comb --version               Show version
  `);
}

function compileFile(input: string): boolean {
  let source: string;
  try {
    source = readFileSync(input, 'utf-8');
  } catch (e: any) {
    console.error(`Error reading file: ${input}`);
    console.error(e.message);
    return false;
  }

  console.log(`Compiling ${input}...`);

  const result = compile(source);

  if (result.errors.length > 0) {
    for (const err of result.errors) {
      console.error(`Error at ${err.line}:${err.column}: ${err.message}`);
    }
    return false;
  }

  const outDir = 'src/generated';
  mkdirSync(outDir, { recursive: true });

  const outFile = basename(input, '.comb') + '.js';
  writeFileSync(join(outDir, outFile), result.js!);

  const graph = result.graph!;
  const signals = graph.nodes.filter(n => n.type === 'signal');
  const combs = graph.nodes.filter(n => n.type === 'comb');
  const events = graph.nodes.filter(n => n.type === 'event');

  console.log(`  Compiled -> ${join(outDir, outFile)}`);
  console.log(`  Module: ${result.ast!.name}`);
  console.log(`  Signals: ${signals.map(s => s.name).join(', ') || 'none'}`);
  console.log(`  Combs: ${combs.map(c => c.name).join(', ') || 'none'}`);
  console.log(`  Events: ${events.map(e => e.name).join(', ') || 'none'}`);
  console.log(`  Edges: ${graph.edges.length}`);

  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      console.warn(`Warning at ${w.line}:${w.column}: ${w.message}`);
    }
  }

  return true;
}

function compileAll() {
  const examplesDir = 'examples';
  if (!existsSync(examplesDir)) {
    console.error(`Error: examples/ directory not found`);
    process.exit(1);
  }

  const files = readdirSync(examplesDir).filter(f => f.endsWith('.comb'));
  if (files.length === 0) {
    console.log('No .comb files found in examples/');
    return;
  }

  let success = 0;
  let failed = 0;

  for (const file of files) {
    const ok = compileFile(join(examplesDir, file));
    if (ok) success++;
    else failed++;
    console.log('');
  }

  console.log(`Done: ${success} compiled, ${failed} failed out of ${files.length} files.`);
  if (failed > 0) process.exit(1);
}

function initProject(name: string) {
  const dir = resolve(name);
  if (existsSync(dir)) {
    console.error(`Error: directory '${name}' already exists`);
    process.exit(1);
  }

  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'examples'), { recursive: true });

  // package.json
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '0.1.0',
    type: 'module',
    scripts: {
      dev: 'npx vite',
      compile: 'comb compile',
      build: 'npx vite build',
    },
    dependencies: {
      comb: '*',
    },
  }, null, 2) + '\n');

  // index.html
  writeFileSync(join(dir, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${name}</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="./src/main.js"></script>
</body>
</html>
`);

  // starter app.comb
  writeFileSync(join(dir, 'src', 'app.comb'), `module App {
  signal count: int = 0;

  comb doubled = count * 2;

  always @(increment) {
    count <= count + 1;
  }

  always @(decrement) {
    count <= count - 1;
  }

  view {
    <div class="app">
      <h1>Hello from Comb</h1>
      <p>Count: {count} (doubled: {doubled})</p>
      <button @click={increment}>+</button>
      <button @click={decrement}>-</button>
    </div>
  }
}
`);

  console.log(`
  Project '${name}' created!

  Next steps:
    cd ${name}
    npm install
    comb compile src/app.comb
    npm run dev
  `);
}

function runDev() {
  console.log('Starting Vite dev server...');
  try {
    execSync('npx vite', { stdio: 'inherit' });
  } catch {
    // User killed the server, that's fine
  }
}

function diffGraphs(fileA: string, fileB: string) {
  let srcA: string, srcB: string;
  try { srcA = readFileSync(fileA, 'utf-8'); } catch { console.error(`Cannot read: ${fileA}`); process.exit(1); return; }
  try { srcB = readFileSync(fileB, 'utf-8'); } catch { console.error(`Cannot read: ${fileB}`); process.exit(1); return; }

  const resultA = compile(srcA);
  const resultB = compile(srcB);
  if (resultA.errors.length > 0) { console.error(`Errors in ${fileA}:`, resultA.errors.map(e => e.message).join(', ')); process.exit(1); }
  if (resultB.errors.length > 0) { console.error(`Errors in ${fileB}:`, resultB.errors.map(e => e.message).join(', ')); process.exit(1); }

  const graphA = resultA.graph;
  const graphB = resultB.graph;
  if (!graphA || !graphB) { console.error('Could not extract graph metadata.'); process.exit(1); return; }

  // Build diff
  const aNodes = new Map((graphA.nodes || []).map((n: any) => [n.id, n]));
  const bNodes = new Map((graphB.nodes || []).map((n: any) => [n.id, n]));

  const added: any[] = [];
  const removed: any[] = [];
  const changed: any[] = [];

  for (const [id, node] of bNodes) {
    if (!aNodes.has(id)) added.push(node);
    else {
      const a = aNodes.get(id)!;
      if ((a as any).type !== (node as any).type) changed.push({ id, before: a, after: node });
    }
  }
  for (const [id, node] of aNodes) {
    if (!bNodes.has(id)) removed.push(node);
  }

  const edgeKey = (e: any) => `${e.from}→${e.to}:${e.type}`;
  const aEdges = new Set((graphA.edges || []).map(edgeKey));
  const bEdges = new Set((graphB.edges || []).map(edgeKey));
  const addedEdges = (graphB.edges || []).filter((e: any) => !aEdges.has(edgeKey(e)));
  const removedEdges = (graphA.edges || []).filter((e: any) => !bEdges.has(edgeKey(e)));

  // Output
  const noChanges = added.length === 0 && removed.length === 0 && changed.length === 0 && addedEdges.length === 0 && removedEdges.length === 0;

  console.log(`\n  Graph Diff: ${basename(fileA)} → ${basename(fileB)}\n`);

  if (noChanges) {
    console.log('  No topology changes detected.\n');
    return;
  }

  console.log(`  Nodes: ${aNodes.size} → ${bNodes.size}`);
  console.log(`  Edges: ${(graphA.edges || []).length} → ${(graphB.edges || []).length}\n`);

  if (added.length > 0) {
    console.log('  + Added nodes:');
    for (const n of added) console.log(`    + ${n.id} (${n.type})`);
  }
  if (removed.length > 0) {
    console.log('  - Removed nodes:');
    for (const n of removed) console.log(`    - ${n.id} (${n.type})`);
  }
  if (changed.length > 0) {
    console.log('  ~ Changed nodes:');
    for (const c of changed) console.log(`    ~ ${c.id}: ${(c.before as any).type} → ${(c.after as any).type}`);
  }
  if (addedEdges.length > 0) {
    console.log('  + Added edges:');
    for (const e of addedEdges) console.log(`    + ${e.from} → ${e.to} (${e.type})`);
  }
  if (removedEdges.length > 0) {
    console.log('  - Removed edges:');
    for (const e of removedEdges) console.log(`    - ${e.from} → ${e.to} (${e.type})`);
  }
  console.log('');
}

// --- Main dispatch ---

if (!command || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  console.log(`comb v${VERSION}`);
  process.exit(0);
}

if (command === 'compile') {
  const target = args[1];
  if (target === '--all') {
    compileAll();
  } else if (target) {
    const ok = compileFile(target);
    if (!ok) process.exit(1);
  } else {
    console.error('Usage: comb compile <file.comb> | comb compile --all');
    process.exit(1);
  }
} else if (command === 'init') {
  const name = args[1];
  if (!name) {
    console.error('Usage: comb init <project-name>');
    process.exit(1);
  }
  initProject(name);
} else if (command === 'dev') {
  runDev();
} else if (command === 'test') {
  // Keep argument boundaries and resolve the runner relative to this module.
  process.argv = [process.argv[0], process.argv[1], ...args.slice(1)];
  await import('./test.js');
} else if (command === 'diff') {
  const fileA = args[1];
  const fileB = args[2];
  if (!fileA || !fileB) {
    console.error('Usage: comb diff <before.comb> <after.comb>');
    process.exit(1);
  }
  diffGraphs(fileA, fileB);
} else {
  // Legacy mode: treat first arg as a file to compile (backward compat)
  if (command.endsWith('.comb')) {
    const ok = compileFile(command);
    if (!ok) process.exit(1);
  } else {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }
}
