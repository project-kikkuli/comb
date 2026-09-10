# Comb Language Reference

Comb is a UI framework built on a discrete event simulation execution model. `.comb` files declare signals, derived values, state transitions, and views — the compiler extracts a static dependency graph (`__graph`), verifies it, and emits readable JavaScript.

---

## Primitives

### signal — mutable state

```sv
signal count = 0;
signal name = "";
signal price: float = 9.99;
```

Type annotations are optional — the type is inferred from the initial value. Explicit types (`signal x: int = 0;`) are still supported and enable compile-time type checking (warnings).

Signals can only be written inside `always` blocks using `<=`, `++`, `--`, `+=`, or `-=`:

```sv
always @(increment) {
  count++;           // sugar for count <= count + 1
  score += 10;       // sugar for score <= score + 10
}
```

### comb — derived value

```sv
comb doubled = count * 2;
comb label = "Count: " + str(count);
comb isValid = len(name) >= 3 && contains(email, "@");
```

Combs are pure derivations. The compiler statically extracts all dependencies and verifies they exist. All branches are tracked (static union semantics) — even inside ternaries, both sides are registered as deps.

### always @(event) — event-triggered block

```sv
always @(increment) {
  count <= count + 1;
}

always @(reset) {
  count <= 0;
  name <= "";
}
```

Fires when the named event is triggered (e.g. from a button `@click`). Writes use `<=` (non-blocking assignment — scheduled for end of current delta). Multiple writes in one block are atomic via `batch()`.

### always @(signal, ...) — sensitivity-triggered block

```sv
always @(celsius) {
  fahrenheit <= celsius * 9 / 5 + 32;
}

always @(width, height) {
  area <= width * height;
}
```

Auto-fires when any declared signal changes. The compiler **verifies** the sensitivity list: every signal read inside the block must be declared in the `@(...)` list. An undeclared read is a compile error. Self-triggering writes (writing to a signal you're sensitive to) are also caught.

### always @(posedge/negedge) — edge-triggered block

```sv
// Fires ONCE when loading transitions false → true
always @(posedge loading) {
  showSpinner();
}

// Fires ONCE when loading transitions true → false
always @(negedge loading) {
  fadeInContent();
}

// Fires when error count transitions from 0 to >0
always @(posedge len(errors) > 0) {
  showToast("Errors detected");
}
```

Edge-triggered sensitivity fires on *transitions*, not values. `@(posedge x)` fires when `x` becomes true (rising edge). `@(negedge x)` fires when `x` becomes false (falling edge). This is a common UI need ("do something when X *becomes* true") that's awkward with standard reactivity — React's `useEffect` is level-triggered, requiring manual `usePrevious` patterns.

Edge-triggered blocks compile end-to-end. The mechanism exists in other frameworks (MobX `when()`, RxJS `pairwise()`), but not as a compiled, compiler-verified language construct.

### edgeCount / negedgeCount — reactive event counting

```sv
comb alertCount = edgeCount(cpuHigh) + edgeCount(memHigh);
```

`edgeCount(expr)` returns a reactive value that automatically increments each time `expr` transitions false→true. No manual counter signal needed — the count is derived from event history. `negedgeCount(expr)` counts true→false transitions.

### changeCount — reactive value-change counting

```sv
comb completed = changeCount(writeback_out);
comb totalMoves = changeCount(selectedCell);
```

`changeCount(signal)` returns a reactive value that increments each time `signal`'s value changes to a *different* value. Unlike `edgeCount` which only counts boolean false→true transitions, `changeCount` counts every value change — integers, strings, objects, etc. Useful for counting events in pipelines, state machine transitions, or any case where you need to know how many times a value was updated.

### view — reactive DOM

```sv
view {
  <div class="counter">
    <h1>{label}</h1>
    <p class={isValid ? "valid" : "invalid"}>{message}</p>
    <button @click=increment>+</button>
    <input @bind=name />
    @if (count > 10) { <p>High!</p> }
    @for item in items { <li>{item}</li> }
  </div>
}
```

`{expr}` — reactive text interpolation. `@click=event` — event binding. `@bind=signal` — two-way input binding. `@if`/`@for` — conditional and list rendering. `class={expr}` — dynamic attributes. No virtual DOM — effects directly patch DOM nodes.

Keyed list rendering with efficient reconciliation:
```sv
@for item in items key=item.id {
  <div>{item.name}</div>
}
```

---

## Assertions

```sv
assert always (count >= 0);
assert canSubmit == (usernameValid && emailValid);
```

Runtime invariants registered as nodes in the `__graph`. The test harness auto-evaluates assertions across generated input combinations.

### Temporal assertions

Inspired by SystemVerilog Assertions (SVA). Prior art: Quickstrom (PLDI 2022) applies LTL to web app testing externally; Comb's temporal assertions are embedded in the component model as graph nodes, with three operators: `eventually`, `always`, and `next`.

`within N` counts **settled simulation turns**, not wall-clock time or trigger
reevaluations. One outer `batch` (including an empty batch) or a changed standalone
signal write advances a turn after the reactive graph settles. Nested batches
and internal delta cycles do not add turns. The triggering turn arms an obligation
without consuming its deadline. `eventually` may succeed immediately or on the
Nth subsequent turn; `always` checks the triggering state and every turn through
that inclusive deadline. `next` checks exactly the next settled turn.

Both rising and falling triggers are supported. Each edge creates its own
obligation; later edges cannot postpone earlier deadlines. Predicates are sampled
at settled boundaries, so intermediate states inside one batch are not temporal
observations. No wall-clock timers are used. Use `advanceTemporalTick()` to advance
verification with unchanged inputs; disposal or `circuit.reset()` cancels pending
obligations and removes their observers.

```sv
// "after request rises, grant must follow within 5 ticks"
assert temporal @(posedge bus_request)
  eventually(bus_grant) within 5;

// "bus_grant must stay true for 3 ticks after bus_busy rises"
assert temporal @(posedge bus_busy)
  always(bus_grant) within 3;

// "after submit, show result on next tick"
assert temporal @(posedge submitted)
  next(showResult);
```

`eventually` and `always` require a positive integer `within N`. `next` needs no
duration; `within 0` and `within 1` are accepted for compatibility and both mean
the next settled turn. Fractions, unknown identifiers, and missing bounded
deadlines are compile errors.

`circuit.getTemporalAssertions(module?)` returns triggered, passed, failed and
pending counts per assertion. Zero triggers means **unexercised**, not passed.
Counts describe the current instance lifetime. Logical deadlines do not pretend
to be wall-clock timestamps in waveform overlays.

Assertion lifecycle events (armed, passed, failed) are recorded in the waveform viewer as colored overlays — green for passed, red for failed, amber for pending.

---

## Module Composition

```sv
module Child {
  input label: string = "hello";
  output clicks: int = 0;

  always @(click) {
    clicks <= clicks + 1;
  }

  view {
    <button @click=click>{label} ({clicks})</button>
  }
}

module App {
  signal childClicks: int = 0;

  view {
    <Child label="Click me" clicks:={childClicks} />
    <p>Total: {childClicks}</p>
  }
}
```

`input` — read-only inside the child, set by the parent via attributes. `output` — writable by the child, readable by the parent. `:=` binds an output back to a parent signal (bidirectional wiring). Multiple modules compile together — the compiler builds a cross-module registry for verification.

Note: directional ports have prior art (Angular `@Input`/`@Output` since 2016, Elm ports). The value here is the integration with the `__graph` artifact for static analysis, not the ports themselves.

---

## Design Tokens

```sv
token primary: color = "#0052CC";
token radius: length = "8px";
```

A token is simultaneously a reactive signal and a CSS custom property (`--primary`, `--radius`). Changing the signal value at runtime updates the custom property. Use in styles via `var(--primary)`.

---

## Scoped Styles

```sv
style {
  .btn { background: var(--primary); padding: 8px; border-radius: var(--radius); }
  .label { font-weight: 600; }
}
```

Class names are auto-scoped per module using a deterministic hash (e.g. `.btn` becomes `.btn_a1b2c`). Styles are injected as a `<style>` element at mount time.

---

## Propagator Networks

Bidirectional constraints using cells and propagators.

### Cells

```sv
cell r: int = 255;
cell g: int = 0;
cell b: int = 128;
cell hex: string = "#ff0080";
```

Cells are like signals but support merge semantics — multiple writers converge rather than conflict.

### Constraints *(partially implemented)*

> The `constraint` keyword parses and compiles, but end-to-end compilation is being hardened. The runtime API (`createCell`, `createPropagator`) is fully functional.

```sv
constraint rgbToHex {
  (r, g, b) => { hex <= rgbToHex(r, g, b); }
  (hex) => { r <= hexToR(hex); g <= hexToG(hex); b <= hexToB(hex); }
}
```

Information flows in any direction — edit RGB, hex updates; edit hex, RGB updates. The propagator network resolves without infinite loops.

Prior art: Sussman & Radul (2009) is the theoretical foundation. dthompson/Spritely (FOSDEM 2026) built a working propagator-based FRP for web UI in Scheme/WASM. Comb's contribution is compiling constraint blocks from a DSL with static analysis and `__graph` integration.

---

## Enums

```sv
enum Phase { Red, Green, Yellow }
```

Used for FSM states. Enum values are available as `Phase.Red`, `Phase.Green`, etc.

---

## Type System

Type annotations are parsed and checked by `verify.ts`. Type mismatches produce **warnings** (not errors), allowing incremental adoption. The checker infers expression types (`inferExprType`) and validates compatibility (`typeCompatible`).

```sv
// Basic type annotations — checked at compile time (warnings on mismatch)
signal count: int = 0;
signal name: string = "";
signal active: bool = true;
signal price: float = 9.99;
```

### Planned type system extensions

The following extensions are domain-specific and not yet implemented:

```sv
// Range types
signal opacity: float(0.0..1.0) = 1.0;
signal temperature: int(-40..125) = 20;

// Unknown state (HDL-inspired X-value)
signal data: X | User;  // starts unresolved, compiler forces handling

// Exhaustive enum matching
match phase {
  Phase.Red => { ... }
  Phase.Green => { ... }
  Phase.Yellow => { ... }
  // compile error if not exhaustive
}
```

Prior art for unknown state: Solid's `createResource` handles async `T | undefined`, Leptos uses `Option<T>`. What's different: X-state applied to all signals with propagation semantics (X in any input → X output).

---

## Functions

### Built-in Functions

| Function | Description |
|---|---|
| `str(x)` | Convert to string |
| `int(x)` | Convert to integer |
| `len(x)` | Length of string or array |
| `contains(s, sub)` | Check if string contains substring |
| `append(arr, item)` | Append item to array |
| `floor(x)` | Round down (`Math.floor`) |
| `round(x)` | Round to nearest (`Math.round`) |
| `min(a, b)` | Minimum of two values |
| `max(a, b)` | Maximum of two values |
| `abs(x)` | Absolute value |
| `reduce(arr, fn, init)` | Array reduce |
| `slice(arr, start)` | Array slice |
| `edgeCount(expr)` | Reactive count of posedge firings (no manual counter needed) |
| `negedgeCount(expr)` | Reactive count of negedge firings |
| `changeCount(signal)` | Reactive count of value changes (any value, not just boolean) |

Browser globals are also available: `fetch`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `console.log`, `JSON.parse`, `JSON.stringify`, `Object.keys`, `Object.values`, `Math.random`.

### Custom Functions

```sv
fn clamp(value: int, min: int, max: int) -> int {
  value < min ? min : value > max ? max : value;
}

fn formatPrice(amount: float) -> string {
  "$" + str(round(amount * 100) / 100);
}
```

Functions are defined with `fn name(params) -> returnType { body }`. The return type is optional. The last expression in the body is the implicit return value (like Rust). Explicit `return expr;` is also supported.

### Method Calls

Array and string methods work as method calls:

```sv
comb names = users.map(|u| u.name);
comb active = users.filter(|u| u.active);
comb found = items.find(|item| item.id == targetId);
comb csv = names.join(", ");
comb hasAdmin = users.some(|u| u.role == "admin");
```

Supported methods include: `map`, `filter`, `find`, `findIndex`, `some`, `every`, `includes`, `indexOf`, `join`, `flat`, `sort`, `reverse`, `push`, `pop`, `trim`, `split`, `replace`, `startsWith`, `endsWith`, `toUpperCase`, `toLowerCase`, `substring`, `charAt`.

---

## String Templates

```sv
comb greeting = `Hello, ${name}! You have ${count} items.`;
comb statusMsg = `Price: $${str(round(price * 100) / 100)}`;
```

Backtick strings with `${expr}` interpolation, compiled to JS template literals.

---

## Destructuring

```sv
always @(processData) {
  const { name, email } = userData;
  const [first, ...rest] = items;
  displayName <= name;
}
```

Object and array destructuring with `const`. Supports aliases (`{ key: alias }`) and rest patterns (`...rest`).

---

## Try/Catch

```sv
always @(submit) {
  try {
    result <= processForm(data);
  } catch (e) {
    error <= "Something went wrong";
  }
}
```

---

## Async Blocks

```sv
always @(loadUsers) {
  loading <= true;
  async {
    const response = await fetch("/api/users");
    const data = await response.json();
    users <= data;
    loading <= false;
  } catch {
    error <= "Failed to load";
    loading <= false;
  }
}
```

`async { }` blocks run asynchronously — the always block returns immediately and the async body executes in the background. Signal writes inside async blocks trigger new simulation cycles when they resolve. `await` is only valid inside async blocks.

### CDC Async Boundary Analysis

The compiler performs static analysis on async blocks, inspired by Clock Domain Crossing (CDC) analysis in hardware design. Three warnings:

| Warning | What it catches |
|---|---|
| Unsynchronized async write | Signal written in `async {}` but read synchronously by a comb without a loading guard |
| Race condition | Two or more `async {}` blocks write the same signal |
| Missing error handling | `async {}` block writes signals but has no `catch` block |

Taint propagation is **transitive** — if comb B reads async-tainted signal A, and comb C reads B, then C is also flagged. The analysis uses fixed-point iteration over the comb dependency graph.

---

## Component Children / Slots

```sv
module Card {
  input title: string = "";
  view {
    <div class="card">
      <h3>{title}</h3>
      <div class="card-body">
        <slot />
      </div>
    </div>
  }
}

module App {
  view {
    <Card title="My Card">
      <p>Child content goes here</p>
    </Card>
  }
}
```

Components accept child content via `<slot />`. Parent content between `<Component>` tags is passed to the child and rendered at the slot position.

---

## Form Elements

All form elements support `@bind` for two-way binding:

```sv
<input @bind=name />
<textarea @bind=description></textarea>
<select @bind=category>
  <option value="a">Option A</option>
  <option value="b">Option B</option>
</select>
<input type="checkbox" @bind=agreed />
<input type="radio" name="size" value="small" @bind=selectedSize />
```

The compiler detects the element type and uses the appropriate property (`value` vs `checked`) and event (`input` vs `change`).

---

## The `__graph` Artifact

Every `.comb` file compiles to JavaScript that exports `__graph` — a JSON-serializable static dependency graph containing every node (signal, comb, event, view binding, assertion) and every edge (data flow, trigger, write).

No other framework emits this as a build artifact (see docs/research/honest-prior-art.md for details).

Each node carries metadata:
- `valueType` — `'bool'`, `'int'`, `'float'`, `'string'`, or enum name
- `states` — finite state space when bounded (e.g. `['true','false']` for bool, `['Phase.Red','Phase.Green','Phase.Yellow']` for enum, `['0','1','2','3']` for bounded int with guard analysis)
- `expr` — assertion expression text for assert nodes

The graph also includes an `enums` map with all enum definitions and their variants.

This single data structure powers:

- **Circuit Visualization** — render the reactive topology as a live diagram
- **Circuit Diff** — compare `__graph` across two versions to detect topology changes
- **Graph-Directed Auto-Testing** — `runAutoTest()` reads the graph to discover inputs, drive state coverage, and track results
- **State Space Inference** — compiler analyzes write patterns and guard conditions to compute bounded state spaces
- **Waveform Debugger** — signal hierarchy, assertion overlays, cross-signal search
- **Runtime Overlay** — static graph merged with live signal values via `loadStaticGraph()`

---

## The DES Execution Model

The runtime uses a `SimulationEngine` with delta cycles (implemented in `src/runtime/signals.ts`).

```
Event enters → Delta 0: combinational logic (combs) settles
             → Delta 1: non-blocking assignments (<=) applied
             → Delta 2: new combinational changes settle
             → ...repeat until quiescent...
             → DOM commit: only after full stabilization
```

Delta cycles give formal guarantees: combs always see consistent state, concurrent always blocks execute deterministically, DOM updates only after stabilization. Standard topological sorting (Solid, Preact) is a single pass; delta cycles are multi-pass.

**Non-blocking assignment (`<=`):** Inside `always @(posedge/negedge)` blocks, all `<=` writes are deferred until the block completes. This means all reads see **pre-update values** — you don't need manual snapshots. The compiler emits `deferredBatch()` which sets `engine.evaluating = true` during execution, causing all signal writes to be queued for the next delta cycle instead of applying immediately.

**Fast path optimization:** When the dependency graph is a pure feed-forward chain (no feedback edges), the engine detects this statically and collapses the multi-pass delta cycle into a single topological pass — identical cost to Solid/Preact for the common case. The full delta cycle machinery only activates when feedback edges are present.

**Oscillation detection:** The compiler statically warns when an `always` block's sensitivity list creates a circular dependency (writing to a signal that feeds back into the same block's inputs). At runtime, if a delta cycle exceeds the iteration limit, the engine reports which signals are oscillating — listing their names and alternating values — rather than silently diverging or throwing an opaque error.

---

## Testing

### __test() — Headless signal access

Every compiled module exports `__test()` for headless testing without a DOM:

```javascript
const t = __test();
t.signals.username.set("alice");
assert(t.combs.usernameValid() === true);
t.dispose();
```

The headless factory also installs signal-sensitive and edge-triggered
`always` blocks. Driving a clock signal therefore executes the same state
transitions as the mounted component. Named event handlers are available through
`events`, with their declared arguments:

```javascript
// For: always @(increment(amount)) { count <= count + amount; }
const t = __test();
try {
  t.events.increment(3);
  assert(t.signals.count.get() === 3);
} finally {
  t.dispose();
}
```

`__test()` omits the view and styles. It does not synthesize DOM event objects,
invoke named handlers automatically, or replace external services used by a
handler. Supply any event arguments and test doubles your module requires.
Disposing the instance removes its reactive effects.

Run the compiler-to-runtime regression suite with `npm run test:headless`.

### runAutoTest() — Bounded input exploration

Use a disposable headless instance to sweep finite input domains through the
compiled runtime. Named-event-owned state can be driven directly; sequential
outputs are observed while their root clocks are pulsed.

```javascript
import { circuit, runAutoTest, renderAutoTestResult } from '../runtime/index.js';
import { __test, __graph } from './MyModule.js';

const instance = __test();
try {
  const result = runAutoTest(__graph, circuit, 'MyModule', {
    budget: 1000,
    clockCycles: 5,
  });
  console.log(result.casesExecuted, result.totalCases, result.stoppedByBudget);
  console.log(result.violationCount, result.violations);
  // renderAutoTestResult(result) includes failures, budget status and state coverage.
} finally {
  instance.dispose();
}
```

The driver enumerates combinations without allocating the Cartesian product.
One case assignment and each subsequent clock pulse consume one budget step.
Defaults are 1000 steps and five pulses per clock per case. Each pulse drives
false, true, then false, exercising both edges. Coverage records declared states
actually observed, including intermediate clock states; out-of-domain values do
not count toward the percentage. `unexploredInputs` identifies root inputs with
no finite domain or runtime setter. No random values are invented for them.

`violationCount` counts failures emitted during the sweep; `violations` retains
the first 100 with the input assignment and step. These are direct state writes,
not generated DOM events or a proof of reachable application states. The driver
does not reset sequential state between cases, restore the instance afterward,
await asynchronous handlers, or prove all possible event sequences. After the
input sweep, it uses remaining step budget to advance already-triggered temporal
obligations to their deadlines. `temporalAssertions` reports pending or unexercised
checks explicitly; temporal counts cover the current instance lifetime. It does not collect
failures from before the sweep started. A finished input sweep and 100% per-state
coverage do not establish exhaustive behavior or transition coverage.

Run `npm run test:autotest` for compiled combination, clock, real traffic-light,
coverage-denominator, and budget regressions.

### CoverageCollector — Runtime instrumentation

The runtime automatically tracks:
- **Toggle coverage** — `recordToggle()` for boolean signals, combs, and cells
- **FSM transition coverage** — `recordTransition()` for enum-typed signals

No manual instrumentation needed — the `createSignal` and `createComb` primitives call these automatically when values change.

### CLI test runner

```bash
npx tsx src/cli/test.ts examples/registration.comb
```

Instantiates the module headlessly, generates inputs, evaluates assertions, and
reports observed boolean-comb values. Initialization failures count as failures,
as do failures during the generated input sweep. The process exits with status 1
when it observes an assertion failure or encounters a compile/runtime/argument
error. Temporal incompleteness uses status 2; otherwise it exits with status 0.
This is a random input sweep, not a
proof of reachable-state coverage. Triggered temporal obligations are settled for
up to `--settle-turns N` extra turns (default 1000). Assertion failures take exit
code 1; otherwise pending or unexercised temporal assertions take exit code 2;
only completed, non-failing checks take exit code 0. No asynchronous service is
mocked or awaited by advancing logical turns.

Use `--iterations N` (a positive integer) and `--seed N` (an integer) to reproduce
a run. `--verbose` prints per-comb detail. The public `comb test` command accepts
paths with spaces and can run outside the Comb checkout. Generated test modules
are placed in a disposable temporary directory and removed after the run.

---

## CLI Tools

### Topology Diff

```bash
comb diff old.comb new.comb
```

Compares the `__graph` topology of two `.comb` files and reports added/removed/changed nodes and edges. Useful for reviewing how a refactor affected the reactive dependency graph.
