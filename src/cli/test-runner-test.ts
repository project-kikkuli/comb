import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url));
function run(source: string, options: { cli?: boolean; elsewhere?: boolean; args?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'comb runner '));
  try {
    const input = join(dir, "case's input.comb");
    writeFileSync(input, source);
    const entry = fileURLToPath(new URL(options.cli ? './cli.ts' : './test.ts', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', tsx, entry, ...(options.cli ? ['test'] : []), input, ...(options.args ?? ['--iterations', '2', '--seed', '1'])], {
      cwd: options.elsewhere ? dir : repo,
      env: { HOME: dir, TMPDIR: dir, PATH: process.env.PATH },
      encoding: 'utf8', timeout: 15000,
    });
    assert.ifError(result.error);
    assert.equal(existsSync(join(dir, '.comb-test')), false, 'runner must not leave generated files in the consumer directory');
    assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('comb-test-')), [], 'temporary compiled modules must be cleaned up');
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('initial constant assertion failures produce a failing exit code', () => {
  const result = run('module Invalid { assert false; }');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /FAIL:/);
});

test('the public CLI works from another directory with quoted filenames', () => {
  const result = run('module Valid { signal count: int = 0; assert count == count; }', { cli: true, elsewhere: true });
  assert.equal(result.status, 0, result.output);
});

test('invalid iteration counts cannot produce a passing empty run', () => {
  for (const count of ['nope', '-1', '0', '2junk']) {
    const result = run('module InvalidBudget { assert false; }', { args: ['--iterations', count] });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /iterations.*positive integer/i);
  }
});

test('assertion failures during generated cases remain observable', () => {
  const result = run('module Failing { signal value: int = 0; assert value == 0; }');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /FAIL:/);
});

test('CLI distinguishes temporal success, failure, pending and unexercised checks', () => {
  const source = (property: string, duration = 2) => `module TemporalCli {
    signal trigger: bool = false;
    assert temporal @(posedge trigger) eventually(${property}) within ${duration};
  }`;
  const passing = run(source('true'));
  assert.equal(passing.status, 0, passing.output);
  assert.match(passing.output, /1 triggered, 1 passed, 0 failed, 0 pending/);
  const failing = run(source('false'));
  assert.equal(failing.status, 1, failing.output);
  assert.match(failing.output, /1 triggered, 0 passed, 1 failed, 0 pending/);
  const pending = run(source('false', 10), { args: ['--iterations', '2', '--seed', '1', '--settle-turns', '0'] });
  assert.equal(pending.status, 2, pending.output);
  assert.match(pending.output, /1 pending/);
  const unexercised = run('module Unexercised { assert temporal @(false) eventually(true) within 2; }');
  assert.equal(unexercised.status, 2, unexercised.output);
  assert.match(unexercised.output, /unexercised/);
});
