import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../core/compiler.js';
import { circuit } from './circuit.js';
import { batch } from './signals.js';

async function fixture(edge: string, operator: string, duration = 2) {
  const result = compile(`module Timing {
    signal trigger: bool = ${edge === 'negedge' ? 'true' : 'false'};
    signal good: bool = false;
    signal unrelated: int = 0;
    assert temporal @(${edge} trigger) ${operator}(good) within ${duration};
  }`);
  assert.deepEqual(result.errors, []);
  const runtime = new URL('./index.ts', import.meta.url).href;
  const js = result.js!.replace(/from ['"]\.\.\/runtime\/index\.js['"]/g, `from '${runtime}'`);
  const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  circuit.reset();
  const events: string[] = [];
  const lifecycle: string[] = [];
  const stop = circuit.subscribe(event => {
    if (event.type.startsWith('assertion-')) lifecycle.push(event.type);
    if (event.type === 'assertion-failed') events.push(event.type);
  });
  const instance = mod.__test();
  return { ...instance, failures: events, lifecycle, dispose() { instance.dispose(); stop(); } };
}

test('eventually expires while its trigger remains high', async () => {
  const t = await fixture('posedge', 'eventually');
  try {
    t.signals.trigger.set(true);
    assert.equal(t.failures.length, 0);
    t.signals.unrelated.set(1);
    assert.equal(t.failures.length, 0);
    t.signals.unrelated.set(2);
    assert.equal(t.failures.length, 1);
  } finally { t.dispose(); }
});

test('compiled negedge assertions arm on falling edges', async () => {
  const t = await fixture('negedge', 'eventually', 1);
  try {
    t.signals.trigger.set(false);
    batch(() => {});
    assert.equal(t.failures.length, 1);
  } finally { t.dispose(); }
});

test('next checks the next settled turn, before a later synchronous write repairs it', async () => {
  const t = await fixture('posedge', 'next', 1);
  try {
    t.signals.trigger.set(true);
    t.signals.unrelated.set(1);
    t.signals.good.set(true);
    assert.equal(t.failures.length, 1);
  } finally { t.dispose(); }
});

test('a new trigger does not replace an older outstanding deadline', async () => {
  const t = await fixture('posedge', 'eventually', 3);
  try {
    t.signals.trigger.set(true);
    t.signals.trigger.set(false);
    t.signals.trigger.set(true);
    batch(() => {});
    assert.equal(t.failures.length, 1);
  } finally { t.dispose(); }
});

test('eventually accepts the deadline boundary and always observes the whole window', async () => {
  for (const operator of ['eventually', 'always']) {
    const t = await fixture('posedge', operator, 2);
    try {
      if (operator === 'always') t.signals.good.set(true);
      t.signals.trigger.set(true);
      batch(() => {});
      batch(() => { t.signals.good.set(true); });
      const state = circuit.getTemporalAssertions('Timing')[0];
      assert.equal(state.passed, 1);
      assert.equal(state.pending, 0);
      t.signals.good.set(false);
      assert.equal(t.failures.length, 0, 'completed obligations must not keep observing');
    } finally { t.dispose(); }
  }
});

test('always fails on its final turn and dispose cancels pending next checks', async () => {
  const t = await fixture('posedge', 'always', 2);
  try {
    t.signals.good.set(true);
    t.signals.trigger.set(true);
    batch(() => {});
    t.signals.good.set(false);
    assert.equal(t.failures.length, 1);
  } finally { t.dispose(); }
  const next = await fixture('posedge', 'next', 1);
  next.signals.trigger.set(true);
  next.dispose();
  batch(() => {});
  assert.equal(circuit.getTemporalAssertions().length, 0);
  assert.equal(next.failures.length, 0);
});

test('one outer batch is one temporal turn and reset removes samplers', async () => {
  const t = await fixture('posedge', 'eventually', 2);
  try {
    batch(() => { t.signals.trigger.set(true); t.signals.unrelated.set(1); });
    batch(() => { t.signals.unrelated.set(2); t.signals.unrelated.set(3); });
    assert.equal(t.failures.length, 0);
    circuit.reset();
    batch(() => {});
    assert.equal(t.failures.length, 0);
    assert.deepEqual(circuit.getTemporalAssertions(), []);
  } finally { t.dispose(); }
});

test('rejects missing/fractional deadlines and unknown temporal references', () => {
  for (const assertion of ['eventually(good);', 'always(good) within 1.5;', 'next(good) within 3;', 'eventually(missing) within 2;']) {
    const result = compile(`module Invalid { signal trigger: bool = false; signal good: bool = false; assert temporal @(trigger) ${assertion} }`);
    assert.ok(result.errors.length > 0, assertion);
  }
  assert.deepEqual(compile('module ValidNext { signal trigger: bool = false; assert temporal @(trigger) next(true) within 0; }').errors, []);
});


test('observers receive armed before terminal events, including immediate success', async () => {
  for (const good of [false, true]) {
    const t = await fixture('posedge', 'eventually', 1);
    try {
      t.signals.good.set(good);
      t.signals.trigger.set(true);
      batch(() => {});
      assert.deepEqual(t.lifecycle, ['assertion-armed', good ? 'assertion-passed' : 'assertion-failed']);
    } finally { t.dispose(); }
  }
});
