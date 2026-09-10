// Graph-directed bounded input sweeps through the compiled reactive runtime.

import type { CircuitGraph, TemporalAssertionState } from './circuit.js';
import type { StaticGraph } from '../core/graph.js';
import { batch, advanceTemporalTick } from './signals.js';

export interface AutoTestResult {
  /** Per-signal coverage: which states were visited */
  signalCoverage: Array<{
    id: string;
    runtimeId: string;
    valueType: string;
    states: string[];
    visited: Set<string>;
  }>;
  /** Driven root signals, including state written only by named events */
  inputsDriven: string[];
  /** Clock signals that were ticked */
  clocksDriven: string[];
  /** Total ticks/steps taken */
  steps: number;
  /** Overall coverage percentage */
  percentage: number;
  /** Number of bounded input combinations, not reachable sequential states. */
  totalCases: number;
  casesExecuted: number;
  stoppedByBudget: boolean;
  /** Root inputs lacking a finite domain or a runtime setter. */
  unexploredInputs: string[];
  violations: Array<{ nodeId: string; expr: string; values: Record<string, any>; step: number; inputs: Record<string, any> }>;
  violationCount: number;
  temporalAssertions: TemporalAssertionState[];
}

export interface AutoTestOptions {
  /** Maximum case assignments plus clock pulses. Default: 1000. */
  budget?: number;
  /** Pulses per clock after each input combination. Default: 5. */
  clockCycles?: number;
  onProgress?: (result: AutoTestResult) => void;
}

/**
 * Enumerate bounded input combinations, then pulse clocks through the real runtime.
 * Event-owned state is directly driveable; state written by sequential or
 * combinational logic is observed instead. This is an input sweep, not a proof
 * that every driven state is reachable through the application's event handlers.
 */
export function runAutoTest(
  graph: StaticGraph,
  circuit: CircuitGraph,
  module: string,
  options: AutoTestOptions = {},
): AutoTestResult {
  const budget = options.budget ?? 1000;
  const clockCycles = options.clockCycles ?? 5;
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error('Auto-test budget must be a nonnegative integer');
  if (!Number.isSafeInteger(clockCycles) || clockCycles < 0) throw new Error('Clock cycles must be a nonnegative integer');

  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const incoming = new Map<string, typeof graph.edges>();
  for (const edge of graph.edges) {
    const edges = incoming.get(edge.to) ?? [];
    edges.push(edge);
    incoming.set(edge.to, edges);
  }
  const roots = graph.nodes.filter(node => node.type === 'signal' &&
    (incoming.get(node.id) ?? []).every(edge => edge.type === 'write' && byId.get(edge.from)?.type === 'event'));
  const clockIds = new Set<string>();
  for (const node of graph.nodes) {
    if (node.type !== 'sensitivity' || !/posedge|negedge/.test(node.name)) continue;
    for (const edge of incoming.get(node.id) ?? []) {
      if (roots.some(root => root.id === edge.from)) clockIds.add(edge.from);
    }
  }
  const clocks = [...clockIds].map(id => ({ id, node: circuit.getNode(`${module}.${id}`) }))
    .filter(entry => entry.node?.setValue);
  const inputRoots = roots.filter(node => !clockIds.has(node.id));
  const inputs = inputRoots.map(node => ({
    id: node.id,
    states: node.states ?? [],
    valueType: node.valueType,
    runtime: circuit.getNode(`${module}.${node.id}`),
  })).filter(entry => entry.states.length > 0 && entry.runtime?.setValue);
  const signalCoverage = graph.nodes.filter(node => node.states?.length).map(node => ({
    id: node.id,
    runtimeId: `${module}.${node.id}`,
    valueType: node.valueType ?? 'unknown',
    states: [...new Set(node.states!)],
    visited: new Set<string>(),
  }));
  const result: AutoTestResult = {
    signalCoverage,
    inputsDriven: [],
    clocksDriven: [],
    steps: 0,
    percentage: 0,
    totalCases: inputs.reduce((total, input) => total * input.states.length, 1),
    casesExecuted: 0,
    stoppedByBudget: false,
    unexploredInputs: inputRoots.filter(root => !inputs.some(input => input.id === root.id)).map(root => root.id),
    violations: [],
    violationCount: 0,
    temporalAssertions: [],
  };
  let assignment: Record<string, any> = {};
  const unsubscribe = circuit.subscribe(event => {
    if (event.type !== 'assertion-failed' || event.assertInfo?.module !== module) return;
    result.violationCount++;
    // Keep diagnostics bounded independently of the number of assertion nodes.
    if (result.violations.length < 100) result.violations.push({
      nodeId: event.nodeId,
      expr: event.assertInfo.expr,
      values: { ...event.assertInfo.values },
      step: result.steps,
      inputs: { ...assignment },
    });
  });
  function snapshot() {
    for (const entry of signalCoverage) {
      const node = circuit.getNode(entry.runtimeId);
      if (node?.getValue) entry.visited.add(String(node.getValue()));
    }
  }
  function consumeStep(): boolean {
    if (result.steps >= budget) { result.stoppedByBudget = true; return false; }
    result.steps++;
    return true;
  }
  try {
    snapshot();
    // Mixed-radix enumeration uses O(inputs) memory even for enormous domains.
    for (let index = 0; index < result.totalCases; index++) {
      if (!consumeStep()) break;
      let cursor = index;
      assignment = {};
      for (const input of inputs) {
        const state = input.states[cursor % input.states.length];
        cursor = Math.floor(cursor / input.states.length);
        assignment[input.id] = parseState(state, input.valueType);
      }
      batch(() => {
        for (const input of inputs) input.runtime!.setValue!(assignment[input.id]);
      });
      result.inputsDriven = inputs.map(input => input.id);
      result.casesExecuted++;
      snapshot();
      for (let cycle = 0; cycle < clockCycles; cycle++) {
        for (const clock of clocks) {
          if (!consumeStep()) break;
          if (!result.clocksDriven.includes(clock.id)) result.clocksDriven.push(clock.id);
          clock.node!.setValue!(false);
          snapshot();
          clock.node!.setValue!(true);
          snapshot();
          clock.node!.setValue!(false);
          snapshot();
        }
        if (result.stoppedByBudget) break;
      }
      if (result.stoppedByBudget) break;
    }
    // Complete already-triggered obligations without inventing further inputs.
    while (circuit.getTemporalAssertions(module).some(state => state.pending > 0)) {
      if (!consumeStep()) break;
      advanceTemporalTick();
    }
    result.temporalAssertions = circuit.getTemporalAssertions(module);
  } finally {
    unsubscribe();
  }
  const totalStates = signalCoverage.reduce((sum, entry) => sum + entry.states.length, 0);
  const coveredStates = signalCoverage.reduce((sum, entry) => sum + coveredCount(entry), 0);
  result.percentage = totalStates > 0 ? coveredStates / totalStates * 100 : 0;
  options.onProgress?.(result);
  return result;
}

function parseState(state: string, valueType?: string): any {
  if (valueType === 'bool') return state === 'true';
  if ((valueType === 'int' || valueType === 'float') && Number.isFinite(Number(state))) return Number(state);
  return state;
}

function coveredCount(entry: AutoTestResult['signalCoverage'][number]): number {
  return entry.states.filter(state => entry.visited.has(state)).length;
}

/**
 * Render an AutoTestResult as HTML for display in a coverage panel.
 */
export function renderAutoTestResult(result: AutoTestResult): string {
  const lines: string[] = [];
  lines.push(`<div style="margin-bottom:8px">Input combinations: ${result.casesExecuted}/${result.totalCases}. ${result.stoppedByBudget ? 'Budget reached; sweep incomplete.' : 'Bounded input sweep finished.'}</div>`);
  lines.push(`<div style="margin-bottom:8px">Observed assertion failures: ${result.violationCount}${result.violationCount > result.violations.length ? ` (first ${result.violations.length} shown)` : ''}. This is not a reachable-state proof.</div>`);
  for (const temporal of result.temporalAssertions) {
    lines.push(`<div>Temporal ${escapeHtml(temporal.name)}: ${temporal.triggered} triggered, ${temporal.passed} passed, ${temporal.failed} failed, ${temporal.pending} pending${temporal.triggered === 0 ? ' (unexercised)' : ''}</div>`);
  }
  if (result.unexploredInputs.length) lines.push(`<div>Inputs without a usable finite domain: ${result.unexploredInputs.map(escapeHtml).join(', ')}</div>`);
  for (const violation of result.violations) {
    lines.push(`<div style="color:var(--warning)">Step ${violation.step}: ${escapeHtml(violation.expr)}; inputs ${escapeHtml(JSON.stringify(violation.inputs))}</div>`);
  }

  for (const sig of result.signalCoverage) {
    const covered = coveredCount(sig);
    const total = sig.states.length;
    const pct = ((covered / total) * 100).toFixed(0);
    const pctColor = covered === total ? 'var(--success)' : 'var(--warning)';

    lines.push(`<div style="margin-bottom:6px;">`);
    lines.push(`<div style="display:flex; justify-content:space-between;"><span style="color:var(--accent); font-weight:600;">${escapeHtml(sig.id)}</span><span style="color:${pctColor};">${covered}/${total} (${pct}%)</span></div>`);

    // State chips
    const chips = sig.states.map(s => {
      const short = s.includes('.') ? s.split('.').pop()! : s;
      const hit = sig.visited.has(s);
      return `<span style="display:inline-block; padding:1px 5px; border-radius:2px; margin:1px; font-size:0.6rem; background:${hit ? 'rgba(114,241,184,0.15)' : 'var(--bg-elevated)'}; border:1px solid ${hit ? 'var(--success)' : 'var(--border)'}; color:${hit ? 'var(--success)' : 'var(--text-faint)'};">${escapeHtml(short)}</span>`;
    }).join('');
    lines.push(`<div>${chips}</div>`);
    lines.push(`</div>`);
  }

  return lines.join('');
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
