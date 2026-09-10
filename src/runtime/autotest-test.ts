import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../core/compiler.js';
import { circuit, CircuitGraph } from './circuit.js';
import { runAutoTest } from './autotest.js';
import type { StaticGraph } from '../core/graph.js';

async function compiled(source: string) {
  const result = compile(source);
  assert.deepEqual(result.errors, []);
  const runtime = new URL('./index.ts', import.meta.url).href;
  const js = result.js!.replace(/from ['"]\.\.\/runtime\/index\.js['"]/g, `from '${runtime}'`);
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

test('explores combinations of event-controlled inputs and reports the violated assertion', async () => {
  const mod = await compiled(`module Choices {
    signal left: bool = false;
    signal right: bool = false;
    always @(toggleLeft) { left <= !left; }
    always @(toggleRight) { right <= !right; }
    assert !(left && right);
  }`);
  circuit.reset();
  const instance = mod.__test();
  try {
    const result = runAutoTest(mod.__graph, circuit, 'Choices');
    assert.deepEqual(result.inputsDriven.sort(), ['left', 'right']);
    assert.equal(result.percentage, 100);
    assert.equal(result.casesExecuted, 4);
    assert.equal(result.totalCases, 4);
    assert.equal(result.stoppedByBudget, false);
    assert.ok(result.violations.some(v => v.values.left === true && v.values.right === true));
  } finally { instance.dispose(); }
});

test('coverage counts declared states, not arbitrary distinct observations', () => {
  const graph: StaticGraph = { nodes: [{ id: 'state', name: 'state', type: 'comb', states: ['a', 'b'] }], edges: [] };
  const runtime = new CircuitGraph();
  const id = runtime.registerNode({ name: 'state', module: 'Coverage', type: 'comb' });
  runtime.setNodeValue(id, () => 'outside-domain');
  const result = runAutoTest(graph, runtime, 'Coverage');
  assert.equal(result.percentage, 0);
});

test('a large state space is bounded without materializing all combinations', () => {
  const graph: StaticGraph = { nodes: [], edges: [] };
  const runtime = new CircuitGraph();
  for (let i = 0; i < 20; i++) {
    const name = `input${i}`;
    graph.nodes.push({ id: name, name, type: 'signal', valueType: 'bool', states: ['false', 'true'] });
    const id = runtime.registerNode({ name, module: 'Bounded', type: 'signal' });
    let value = false;
    runtime.setNodeValue(id, () => value);
    runtime.setNodeSetter(id, next => { value = next; });
  }
  const result = runAutoTest(graph, runtime, 'Bounded', { budget: 3 });
  assert.equal(result.totalCases, 2 ** 20);
  assert.equal(result.casesExecuted, 3);
  assert.equal(result.steps, 3);
  assert.equal(result.stoppedByBudget, true);
});

test('the real traffic-light module visits its enum and boolean input combinations', async () => {
  const { readFileSync } = await import('node:fs');
  const mod = await compiled(readFileSync(new URL('../../examples/traffic-light.comb', import.meta.url), 'utf8'));
  circuit.reset();
  const instance = mod.__test();
  try {
    const result = runAutoTest(mod.__graph, circuit, 'TrafficLight');
    assert.equal(result.totalCases, 12);
    assert.equal(result.casesExecuted, 12);
    assert.equal(result.percentage, 100);
    assert.equal(result.violationCount, 0);
    assert.deepEqual(result.signalCoverage.find(entry => entry.id === 'phase')!.visited,
      new Set(['Phase.Red', 'Phase.Green', 'Phase.Yellow']));
    assert.deepEqual(result.signalCoverage.find(entry => entry.id === 'can_walk')!.visited,
      new Set(['true', 'false']));
  } finally { instance.dispose(); }
});

test('clock pulses propagate state without driving sequential outputs directly', async () => {
  const mod = await compiled(`module Clocked {
    signal clk: bool = false;
    signal source: bool = false;
    signal first: bool = false;
    signal second: bool = false;
    always @(posedge clk) { first <= source; second <= first; }
  }`);
  circuit.reset();
  const instance = mod.__test();
  try {
    const result = runAutoTest(mod.__graph, circuit, 'Clocked', { clockCycles: 2 });
    assert.deepEqual(result.inputsDriven, ['source']);
    assert.deepEqual(result.clocksDriven, ['clk']);
    assert.equal(result.steps, 6);
    assert.equal(instance.signals.first.get(), false);
    assert.equal(instance.signals.second.get(), false);
    assert.deepEqual(result.signalCoverage.find(entry => entry.id === 'second')!.visited, new Set(['true', 'false']));
  } finally { instance.dispose(); }
});

test('autotest completes temporal deadlines or reports budget-limited pending obligations', async () => {
  const mod = await compiled(`module TimedSweep {
    signal trigger: bool = false;
    assert temporal @(trigger) eventually(false) within 2;
  }`);
  for (const budget of [1, 10]) {
    circuit.reset();
    const instance = mod.__test();
    try {
      const result = runAutoTest(mod.__graph, circuit, 'TimedSweep', { budget });
      const temporal = result.temporalAssertions[0];
      assert.equal(temporal.triggered, 1);
      if (budget === 1) {
        assert.equal(temporal.pending, 1);
        assert.equal(result.stoppedByBudget, true);
      } else {
        assert.equal(temporal.pending, 0);
        assert.equal(temporal.failed, 1);
        assert.equal(result.violationCount, 1);
      }
    } finally { instance.dispose(); }
  }
});
