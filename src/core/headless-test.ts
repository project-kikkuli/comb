import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from './compiler.js';
import { circuit } from '../runtime/circuit.js';

async function instantiate(source: string) {
  const result = compile(source);
  assert.deepEqual(result.errors, []);
  const runtime = new URL('../runtime/index.ts', import.meta.url).href;
  const js = result.js!.replace(/from ['"]\.\.\/runtime\/index\.js['"]/g, `from '${runtime}'`);
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

test('headless clocked pipeline matches the mounted circuit and disposes its effects', async () => {
  const mod = await instantiate(`module Pipeline {
    signal clk: bool = false;
    signal data: int = 0;
    signal first: int = 0;
    signal second: int = 0;
    always @(posedge clk) { first <= data; second <= first; }
  }`);
  const observed: number[][][] = [];
  for (const factory of [() => mod.Pipeline(null), () => mod.__test()]) {
    circuit.reset();
    const instance = factory();
    const node = (name: string) => circuit.getNode(`Pipeline.${name}`)!;
    const values: number[][] = [];
    for (const value of [7, 9]) {
      node('clk').setValue!(false);
      node('data').setValue!(value);
      node('clk').setValue!(true);
      values.push([node('first').getValue!(), node('second').getValue!()]);
    }
    instance.dispose();
    node('clk').setValue!(false);
    node('data').setValue!(100);
    node('clk').setValue!(true);
    assert.equal(node('first').getValue!(), values[1][0]);
    observed.push(values);
  }
  assert.deepEqual(observed[0], [[7, 0], [9, 7]]);
  assert.deepEqual(observed[1], observed[0]);
});

test('headless event handlers retain arguments and nonblocking assignments', async () => {
  const mod = await instantiate(`module Counter {
    signal count: int = 0;
    signal previous: int = 0;
    always @(increment(amount)) { previous <= count; count <= count + amount; }
    always @(reset) { count <= 0; }
  }`);
  circuit.reset();
  const instance = mod.__test();
  try {
    instance.events.increment(3);
    instance.events.increment(4);
    assert.equal(instance.signals.count.get(), 7);
    assert.equal(instance.signals.previous.get(), 3);
    instance.events.reset();
    assert.equal(instance.signals.count.get(), 0);
  } finally {
    instance.dispose();
  }
});

test('the real bus protocol example completes transfers through its headless clock', async () => {
  const { readFileSync } = await import('node:fs');
  const mod = await instantiate(readFileSync(new URL('../../examples/bus-protocol.comb', import.meta.url), 'utf8'));
  circuit.reset();
  const instance = mod.__test();
  try {
    for (let tick = 0; tick < 64; tick++) {
      instance.signals.clk.set(true);
      instance.signals.clk.set(false);
    }
    assert.equal(instance.signals.cycle.get(), 64);
    assert.ok(instance.signals.tx_count.get() > 0, 'master must complete a transfer');
    assert.ok(instance.signals.rx_count.get() > 0, 'slave must receive a transfer');
  } finally {
    instance.dispose();
  }
});
