// signals.ts — DES (Discrete Event Simulation) reactive runtime
// Replaces microtask-based reactivity with a proper delta-cycle simulation engine.

import { circuit } from './circuit.js';
import { coverage } from './coverage.js';

// --- X (unknown / uninitialized) sentinel ---

export const X = Symbol.for('comb:X');
export type XValue = typeof X;

// --- Internal types ---

interface Computation {
  execute: () => void;
  dependencies: Set<SignalNode<any>>;
  cleanups: (() => void)[];
  disposed: boolean;
  isDom: boolean;
}

interface SignalNode<T> {
  value: T;
  subscribers: Set<Computation>;
}

interface PendingUpdate<T> {
  signal: SignalNode<T>;
  nodeId: string;
  value: T;
  oldValue: T;
}

// --- Simulation Engine ---

const temporalSamplers = new Set<() => void>();

class SimulationEngine {
  evaluating = false;
  pendingUpdates: PendingUpdate<any>[] = [];
  pendingComputations = new Set<Computation>();
  private deltaCount = 0;
  private maxDeltaCycles = 1000;
  private domEffects: (() => void)[] = [];
  batchDepth = 0;
  private running = false;

  scheduleUpdate<T>(signal: SignalNode<T>, nodeId: string, value: T, oldValue: T): void {
    this.pendingUpdates.push({ signal, nodeId, value, oldValue });
  }

  scheduleComputation(comp: Computation): void {
    if (comp.disposed) return;
    if (comp.isDom) {
      // DOM effects are deferred until after quiescence
      this.scheduleDomEffect(() => {
        if (!comp.disposed) comp.execute();
      });
    } else {
      this.pendingComputations.add(comp);
    }
  }

  runUntilQuiescent(): void {
    if (this.running) return;
    this.running = true;
    this.deltaCount = 0;

    // Track which signals have been updated in this run for oscillation detection
    // Only count delta cycles when the SAME signal is updated again (feedback loop)
    // Feed-forward cascading doesn't count — this collapses linear chains from N delta
    // cycles to effectively 1, matching topological sort performance.
    const updatedSignals = new Map<string, { count: number; values: any[] }>();
    let loopCount = 0;
    const maxLoops = 1000000; // absolute safety limit for feed-forward chains

    while (this.pendingComputations.size > 0 || this.pendingUpdates.length > 0) {
      loopCount++;
      if (loopCount > maxLoops) {
        console.error('[Comb] Loop limit exceeded (' + maxLoops + '). Breaking.');
        this.pendingComputations.clear();
        this.pendingUpdates.length = 0;
        break;
      }

      // FAST PATH: single computation, no pending updates → no conflict possible.
      // Skip deferred writes entirely — apply immediately like topological sort.
      // This collapses linear chains (A→B→C→...→N) from N delta cycles to 1 pass.
      if (this.pendingComputations.size === 1 && this.pendingUpdates.length === 0) {
        const comp = this.pendingComputations.values().next().value!;
        this.pendingComputations.clear();
        // evaluating stays FALSE — writes apply immediately, no deferral
        if (!comp.disposed) comp.execute();
        // Any downstream computations were added to pendingComputations by notify()
        // Loop back and check — if still single-computation, stay on fast path
        continue;
      }

      // FULL DELTA CYCLE: multiple computations — defer writes to prevent conflicts
      this.evaluating = true;
      const batch = [...this.pendingComputations];
      this.pendingComputations.clear();
      for (const comp of batch) {
        if (!comp.disposed) comp.execute();
      }
      this.evaluating = false;

      // UPDATE phase: apply deferred signal writes
      const updates = this.pendingUpdates.splice(0);
      for (const u of updates) {
        if (!Object.is(u.value, u.signal.value)) {
          // Track signal updates for oscillation detection
          const info = updatedSignals.get(u.nodeId);
          if (info) {
            info.count++;
            info.values.push(u.value);
            if (info.values.length > 10) info.values.shift();
            this.deltaCount++;
          } else {
            updatedSignals.set(u.nodeId, { count: 1, values: [u.value] });
          }

          if (this.deltaCount > this.maxDeltaCycles) {
            const oscillating = [...updatedSignals.entries()]
              .filter(([, i]) => i.count > 2)
              .sort((a, b) => b[1].count - a[1].count);

            let msg = `[Comb] Delta cycle limit exceeded (${this.maxDeltaCycles} cycles).`;
            if (oscillating.length > 0) {
              msg += '\n  Oscillating signals:';
              for (const [nodeId, i] of oscillating.slice(0, 10)) {
                const lastVals = i.values.slice(-4).map(v => JSON.stringify(v)).join(' → ');
                msg += `\n    ${nodeId}: updated ${i.count}x, recent: ${lastVals}`;
              }
            }
            console.error(msg);
            this.pendingComputations.clear();
            this.pendingUpdates.length = 0;
            break;
          }

          applyUpdate(u.signal, u.nodeId, u.value, u.oldValue);
        }
      }
    }

    this.running = false;

    for (const sample of [...temporalSamplers]) sample();

    // After quiescence: flush DOM effects
    this.flushDomEffects();
  }

  scheduleDomEffect(fn: () => void): void {
    this.domEffects.push(fn);
  }

  private flushDomEffects(): void {
    const effects = this.domEffects.splice(0);
    for (const fn of effects) fn();
  }

  enterBatch(): void {
    this.batchDepth++;
  }

  exitBatch(): void {
    this.batchDepth--;
    if (this.batchDepth === 0) {
      this.runUntilQuiescent();
    }
  }
}

const engine = new SimulationEngine();

// --- Internal state ---

let currentComputation: Computation | null = null;
let currentScope: Scope | null = null;

// --- Internal helpers ---

function isDomEffectName(name: string): boolean {
  return name.startsWith('view:') || name.startsWith('bind:') || name.startsWith('token:');
}

function track<T>(signal: SignalNode<T>): void {
  if (currentComputation && !currentComputation.disposed) {
    signal.subscribers.add(currentComputation);
    currentComputation.dependencies.add(signal);
  }
}

function notify(signal: SignalNode<any>): void {
  for (const comp of signal.subscribers) {
    if (comp.disposed) continue;
    engine.scheduleComputation(comp);
  }
}

function applyUpdate<T>(signal: SignalNode<T>, nodeId: string, value: T, oldValue: T): void {
  // Coverage: record boolean toggles and enum transitions
  if (coverage.isEnabled()) {
    if (typeof value === 'boolean') {
      coverage.recordToggle(nodeId, value);
    } else {
      const node = circuit.getNode(nodeId);
      if (node?.valueType && node.valueType !== 'int' && node.valueType !== 'float' && node.valueType !== 'string' && node.valueType !== 'bool') {
        coverage.recordTransition(nodeId, String(oldValue), String(value));
      }
    }
  }
  const old = signal.value;
  signal.value = value;
  circuit.notifyChange(nodeId, old, value);
  notify(signal);
}

function cleanupComputation(comp: Computation): void {
  for (const cleanup of comp.cleanups) cleanup();
  comp.cleanups = [];
  for (const dep of comp.dependencies) dep.subscribers.delete(comp);
  comp.dependencies.clear();
}

// --- Scope ---

class Scope {
  private computations: Computation[] = [];
  private children: (() => void)[] = [];
  private destroyCallbacks: (() => void)[] = [];
  private parent: Scope | null;

  constructor() {
    this.parent = currentScope;
  }

  track(comp: Computation): void {
    this.computations.push(comp);
  }

  addChild(disposeFn: () => void): void {
    this.children.push(disposeFn);
  }

  addCleanup(fn: () => void): void {
    this.destroyCallbacks.push(fn);
  }

  dispose(): void {
    // Run destroy callbacks in reverse order (LIFO)
    for (let i = this.destroyCallbacks.length - 1; i >= 0; i--) {
      this.destroyCallbacks[i]();
    }
    this.destroyCallbacks = [];
    // Dispose children (bottom-up)
    for (const child of this.children) child();
    this.children = [];
    for (const comp of this.computations) {
      comp.disposed = true;
      cleanupComputation(comp);
    }
    this.computations = [];
  }
}

// --- Public API ---

export function createSignal<T>(
  initial: T,
  meta: { name: string; module: string; type?: string },
): [get: () => T, set: (v: T | ((prev: T) => T)) => void] {
  const nodeId = circuit.registerNode({ name: meta.name, module: meta.module, type: 'signal', valueType: meta.type });

  const signal: SignalNode<T> = { value: initial, subscribers: new Set() };

  circuit.setNodeValue(nodeId, () => signal.value);

  const read = (): T => {
    track(signal);
    return signal.value;
  };

  const write = (next: T | ((prev: T) => T)): void => {
    const nextVal = typeof next === 'function'
      ? (next as (prev: T) => T)(signal.value)
      : next;
    if (Object.is(nextVal, signal.value)) return;
    // Coverage: record boolean toggles and enum transitions
    if (coverage.isEnabled()) {
      if (typeof nextVal === 'boolean') {
        coverage.recordToggle(nodeId, nextVal);
      } else if (meta.type && meta.type !== 'int' && meta.type !== 'float' && meta.type !== 'string') {
        // Enum-typed signal: record FSM transition
        coverage.recordTransition(nodeId, String(signal.value), String(nextVal));
      }
    }
    const old = signal.value;

    if (engine.evaluating) {
      // Inside evaluation phase: defer to pendingUpdates (apply next delta)
      engine.scheduleUpdate(signal, nodeId, nextVal, old);
    } else {
      // Outside evaluation: apply immediately
      signal.value = nextVal;
      circuit.notifyChange(nodeId, old, nextVal);
      notify(signal);
      // Run simulation to quiescence if not in batch
      if (engine.batchDepth === 0) {
        engine.runUntilQuiescent();
      }
    }
  };

  circuit.setNodeSetter(nodeId, (v: any) => write(v));

  return [read, write];
}

export function createComb<T>(
  fn: () => T,
  meta: { name: string; module: string; deps: string[] },
): () => T {
  const nodeId = circuit.registerNode({ name: meta.name, module: meta.module, type: 'comb', deps: meta.deps });

  let value: T;
  let dirty = true;

  const signal: SignalNode<T> = { value: undefined as T, subscribers: new Set() };

  const comp: Computation = {
    execute: () => {
      // Mark dirty and eagerly recompute. Only notify downstream if value changed.
      dirty = true;
      recompute();
    },
    dependencies: new Set(),
    cleanups: [],
    disposed: false,
    isDom: false,
  };

  if (currentScope) currentScope.track(comp);

  function recompute(): T {
    // Clear old tracking
    for (const dep of comp.dependencies) dep.subscribers.delete(comp);
    comp.dependencies.clear();

    const prev = currentComputation;
    currentComputation = comp;
    const newVal = fn();
    currentComputation = prev;

    dirty = false;

    if (!Object.is(newVal, value)) {
      const old = value;
      value = newVal;
      signal.value = newVal;
      // Coverage: track boolean comb toggles
      if (coverage.isEnabled() && typeof newVal === 'boolean') {
        coverage.recordToggle(nodeId, newVal);
      }
      circuit.notifyChange(nodeId, old, newVal);
      // Notify subscribers through the engine
      notify(signal);
    }
    return value;
  }

  circuit.setNodeValue(nodeId, () => signal.value);

  // Initial computation
  recompute();

  return (): T => {
    if (dirty) recompute();
    track(signal);
    return value;
  };
}

export function createEffect(
  fn: () => void | (() => void),
  meta: { name: string; module: string; [key: string]: any },
): void {
  const nodeId = circuit.registerNode({ name: meta.name, module: meta.module, type: 'effect' });

  const isDom = isDomEffectName(meta.name);

  const comp: Computation = {
    execute: runEffect,
    dependencies: new Set(),
    cleanups: [],
    disposed: false,
    isDom,
  };

  if (currentScope) currentScope.track(comp);

  function runEffect(): void {
    if (comp.disposed) return;

    // Run cleanups from previous execution
    for (const cleanup of comp.cleanups) cleanup();
    comp.cleanups = [];

    // Clear old tracking
    for (const dep of comp.dependencies) dep.subscribers.delete(comp);
    comp.dependencies.clear();

    const prev = currentComputation;
    currentComputation = comp;
    const cleanup = fn();
    currentComputation = prev;

    if (typeof cleanup === 'function') comp.cleanups.push(cleanup);

    circuit.notifyEffect(nodeId);
  }

  // Run initially
  runEffect();
}

export function batch(fn: () => void): void {
  engine.enterBatch();
  try {
    fn();
  } finally {
    engine.exitBatch();
  }
}

/**
 * Deferred batch: runs callback with `evaluating = true`, so all signal writes
 * via `<=` are deferred to the next delta cycle (non-blocking assignment semantics).
 * This is what `always @(posedge/negedge)` blocks need — reads see OLD values,
 * writes apply AFTER the block finishes.
 */
export function deferredBatch(fn: () => void): void {
  const wasEvaluating = engine.evaluating;
  engine.evaluating = true;
  try {
    fn();
  } finally {
    engine.evaluating = wasEvaluating;
    // Apply deferred writes and run to quiescence
    if (!wasEvaluating) {
      engine.runUntilQuiescent();
    }
  }
}

export function untrack<T>(fn: () => T): T {
  const prev = currentComputation;
  currentComputation = null;
  try { return fn(); }
  finally { currentComputation = prev; }
}

export function createScope(): { dispose: () => void } {
  const scope = new Scope();
  const prevScope = currentScope;
  currentScope = scope;

  return {
    dispose: () => {
      scope.dispose();
      currentScope = prevScope;
    },
  };
}

export function createCell<T>(
  initial: T,
  meta: { name: string; module: string; type?: string; merge?: (current: T, incoming: T) => T },
): [get: () => T, set: (v: T) => void] {
  const merge = meta.merge ?? ((_: T, incoming: T) => incoming);
  const nodeId = circuit.registerNode({ name: meta.name, module: meta.module, type: 'cell', valueType: meta.type });

  const signal: SignalNode<T> = { value: initial, subscribers: new Set() };
  circuit.setNodeValue(nodeId, () => signal.value);

  const get = (): T => {
    track(signal);
    return signal.value;
  };

  const set = (incoming: T): void => {
    const merged = merge(signal.value, incoming);
    if (Object.is(merged, signal.value)) return;
    // Coverage: record boolean toggles for cells
    if (coverage.isEnabled() && typeof merged === 'boolean') {
      coverage.recordToggle(nodeId, merged as boolean);
    }
    const old = signal.value;

    if (engine.evaluating) {
      // Inside evaluation phase: defer update
      engine.scheduleUpdate(signal, nodeId, merged, old);
    } else {
      signal.value = merged;
      circuit.notifyChange(nodeId, old, merged);
      notify(signal);
      if (engine.batchDepth === 0) {
        engine.runUntilQuiescent();
      }
    }
  };

  circuit.setNodeSetter(nodeId, (v: any) => set(v));

  return [get, set];
}

export function createPropagator(
  fn: () => void,
  meta: { name: string; module: string; deps?: string[]; writes?: string[] },
): void {
  // Register as propagator node with explicit edges
  const nodeId = circuit.registerNode({ name: meta.name, module: meta.module, type: 'propagator', deps: meta.deps });
  if (meta.writes) {
    for (const w of meta.writes) {
      const targetId = `${meta.module}.${w}`;
      const exists = circuit.getEdges().some(e => e.from === nodeId && e.to === targetId);
      if (!exists) circuit['edges'].push({ from: nodeId, to: targetId });
    }
  }

  // Use raw effect machinery (not createEffect, which would register a second node)
  const comp: Computation = {
    execute: runPropagator,
    dependencies: new Set(),
    cleanups: [],
    disposed: false,
    isDom: false,
  };

  if (currentScope) currentScope.track(comp);

  function runPropagator(): void {
    if (comp.disposed) return;
    for (const cleanup of comp.cleanups) cleanup();
    comp.cleanups = [];
    for (const dep of comp.dependencies) dep.subscribers.delete(comp);
    comp.dependencies.clear();

    const prev = currentComputation;
    currentComputation = comp;
    batch(() => { fn(); });
    currentComputation = prev;

    circuit.notifyEffect(nodeId);
  }

  runPropagator();
}

// --- Edge-triggered effects ---

export function createEdgeEffect(
  valueFn: () => any,
  edge: 'posedge' | 'negedge',
  action: () => void,
  meta: { name: string; module: string },
): void {
  const nodeId = circuit.registerNode({ name: meta.name, module: meta.module, type: 'effect' });

  let previousValue: any = undefined;
  let initialized = false;

  const comp: Computation = {
    execute: runEdgeEffect,
    dependencies: new Set(),
    cleanups: [],
    disposed: false,
    isDom: false,
  };

  if (currentScope) currentScope.track(comp);

  function runEdgeEffect(): void {
    if (comp.disposed) return;

    // Clear old tracking
    for (const dep of comp.dependencies) dep.subscribers.delete(comp);
    comp.dependencies.clear();

    const prev = currentComputation;
    currentComputation = comp;
    const currentValue = valueFn();
    currentComputation = prev;

    if (initialized) {
      const wasTruthy = !!previousValue;
      const isTruthy = !!currentValue;

      if (edge === 'posedge' && !wasTruthy && isTruthy) {
        action();
      } else if (edge === 'negedge' && wasTruthy && !isTruthy) {
        action();
      }
    }

    previousValue = currentValue;
    initialized = true;
    circuit.notifyEffect(nodeId);
  }

  // Run initially to capture baseline
  runEdgeEffect();
}

// --- Edge counter: reactive count of how many times an edge has fired ---

export function createEdgeCounter(
  valueFn: () => any,
  edge: 'posedge' | 'negedge',
  meta: { name: string; module: string },
): () => number {
  const [count, setCount] = createSignal(0, { name: meta.name, module: meta.module, type: 'int' });
  createEdgeEffect(valueFn, edge, () => {
    setCount(count() + 1);
  }, { name: `${edge}:${meta.name}`, module: meta.module });
  return count;
}

// --- Change counter: reactive count of how many times a signal's VALUE changes ---

export function createChangeCounter(
  valueFn: () => any,
  meta: { name: string; module: string },
): () => number {
  const [count, setCount] = createSignal(0, { name: meta.name, module: meta.module, type: 'int' });

  let previousValue: any = undefined;
  let initialized = false;

  const comp: Computation = {
    execute: runChangeCheck,
    dependencies: new Set(),
    cleanups: [],
    disposed: false,
    isDom: false,
  };

  if (currentScope) currentScope.track(comp);

  function runChangeCheck(): void {
    if (comp.disposed) return;
    for (const dep of comp.dependencies) dep.subscribers.delete(comp);
    comp.dependencies.clear();

    const prev = currentComputation;
    currentComputation = comp;
    const currentValue = valueFn();
    currentComputation = prev;

    if (initialized && !Object.is(currentValue, previousValue)) {
      setCount(count() + 1);
    }

    previousValue = currentValue;
    initialized = true;
  }

  runChangeCheck();
  return count;
}

// --- Temporal assertions ---

/** Sample assertions once per settled outer batch or changed standalone write. */
export function createTemporalAssert(
  triggerFn: () => boolean,
  operator: 'eventually' | 'always' | 'next',
  propertyFn: () => boolean,
  meta: { name: string; module: string; duration?: number; edge?: 'posedge' | 'negedge' },
): void {
  const duration = operator === 'next' ? 1 : meta.duration;
  if (duration === undefined || !Number.isSafeInteger(duration) || duration <= 0
    || operator === 'next' && meta.duration !== undefined && ![0, 1].includes(meta.duration)) {
    throw new Error('Temporal duration must be a positive integer number of settled turns');
  }
  const nodeId = circuit.registerNode({ name: meta.name, module: meta.module, type: 'effect' });
  const state = { nodeId, module: meta.module, name: meta.name, triggered: 0, passed: 0, failed: 0, pending: 0 };
  let previous = !!untrack(triggerFn);
  let turn = 0;
  let disposed = false;
  let obligations: Array<{ deadline: number }> = [];
  const expr = `${operator} within ${duration} settled turns`;

  function finish(passed: boolean, error?: unknown) {
    if (passed) {
      state.passed++;
      circuit.assertionPassed(nodeId, { expr, module: meta.module });
    } else {
      state.failed++;
      circuit.assertionFailed(nodeId, {
        expr, module: meta.module,
        values: error === undefined ? { property: false } : { error: String(error) },
      });
    }
  }

  function sample() {
    if (disposed) return;
    turn++;
    const current = !!untrack(triggerFn);
    const triggered = meta.edge === 'negedge' ? previous && !current : !previous && current;
    previous = current;
    if (triggered) {
      state.triggered++;
      obligations.push({ deadline: turn + duration! });
      circuit.assertionArmed(nodeId, { expr, module: meta.module });
    }
    const pending: typeof obligations = [];
    for (const obligation of obligations) {
      if (operator === 'next' && turn < obligation.deadline) {
        pending.push(obligation);
        continue;
      }
      let good: boolean;
      try { good = !!untrack(propertyFn); }
      catch (error) { finish(false, error); continue; }
      if (operator === 'eventually' && good) finish(true);
      else if (operator === 'always' && !good) finish(false);
      else if (turn >= obligation.deadline) finish(good);
      else pending.push(obligation);
    }
    obligations = pending;
    state.pending = pending.length;
  }
  temporalSamplers.add(sample);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    temporalSamplers.delete(sample);
    obligations = [];
    circuit.removeTemporalAssertion(nodeId);
  };
  circuit.registerTemporalAssertion(state, dispose);
  if (currentScope) currentScope.addCleanup(dispose);
}

/** Advance one deterministic verification turn without changing model inputs. */
export function advanceTemporalTick(): void {
  batch(() => {});
}

export function onMount(fn: () => void): void {
  queueMicrotask(fn);
}

export function onDestroy(fn: () => void): void {
  if (currentScope) {
    currentScope.addCleanup(fn);
  }
}

// For test use -- lets tests end the scope after synchronous factory code
export function endScope(): void {
  if (currentScope) {
    const parent = (currentScope as any).parent;
    currentScope = parent;
  }
}
