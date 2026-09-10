# Comb

**A discrete event simulator for user interfaces.**

Comb is an experimental UI framework whose runtime is a discrete event simulation kernel — not a virtual DOM diffing engine, not a microtask-based signal graph, but a simulator with formal time, delta cycles, and edge-triggered sensitivity. You write `.comb` files; the compiler extracts a static circuit topology (`__graph`) and emits JavaScript targeting the simulation runtime.

The question Comb asks is not "what should the UI look like?" but **"what are the signals, what are the dependencies between them, and what events drive state transitions?"** — the same question a chip designer asks about a circuit.

> **Status:** Research prototype. The compiler, runtime, DES execution model (delta cycles), edge-triggered sensitivity, type system (warnings), and temporal assertions are all implemented and working. See [Roadmap](#roadmap) for details.

## Quick Start

```bash
npm install
npm run dev        # Landing page + demos at localhost:3000
```

Playground at [localhost:3000/playground.html](http://localhost:3000/playground.html) — compiles `.comb` in the browser, no server round-trips.

## The Language

```sv
module Counter {
  signal count: int = 0;

  comb label = "Count: " + str(count);
  comb doubled = count * 2;

  always @(increment) {
    count <= count + 1;
  }

  always @(reset) {
    count <= 0;
  }

  view {
    <div class="counter">
      <h1>Comb Counter</h1>
      <p class="display">{label}</p>
      <p class="detail">doubled = {doubled}</p>
      <div class="controls">
        <button @click=increment>+</button>
        <button @click=reset>reset</button>
      </div>
    </div>
  }
}
```

### SystemVerilog Heritage

The syntax borrows from SystemVerilog intentionally — not as decoration, but because the HDL execution model maps onto UI problems in ways that standard reactive frameworks don't.

| Comb | SystemVerilog | What it means |
|------|---------------|---------------|
| `signal` | `reg` | Mutable state that persists across events |
| `comb` | `always_comb` / `assign` | Derived value — pure function of signals, auto-recomputes |
| `always @(event)` | `always_ff @(posedge clk)` | Event-triggered state transition |
| `<=` | Non-blocking assign | Scheduled for end of current delta — batched, deterministic |
| `cell` | Latch | Merge-semantic value for propagator networks |
| `constraint` | Bidirectional wire | Propagator clause: information flows in any direction |
| `view { }` | Module ports | DOM output with fine-grained reactive bindings |
| `input` / `output` | Port | Directional module composition |

### Edge-triggered sensitivity

```sv
// Fires on transition, not on value
always @(posedge loading) { showSpinner(); }
always @(negedge loading) { fadeInContent(); }
```

### Temporal assertions

```sv
// SVA-inspired invariants over time
assert temporal @(posedge submitted)
  eventually(showSuccess || showError) within 5;
```

Temporal deadlines count settled simulation turns, not seconds. Rising and
falling triggers, overlapping obligations, inclusive deadlines, and `next` are
covered by `npm run test:temporal`. The CLI exits 1 on an observed assertion
failure and 2 when temporal checks remain pending or unexercised. See the
[temporal semantics and verification commands](docs/language.md#temporal-assertions).

### Planned syntax (not yet implemented)

```sv
// Unknown state — signal starts unresolved, compiler forces handling
signal data: X | User;
```

## Demos

- **Counter / Traffic Light / Minesweeper / Chat** — standard interactive demos
- **Pipeline Proof** — side-by-side DES vs naive JS showing delta cycle correctness (both implementations, same pipeline, only DES gets the right answer)
- **Ring Counter** — feedback loop demo exercising multi-pass delta cycle stabilization
- **Interactive Benchmarks** — live DES vs topological sort performance comparison

## What's Genuinely Novel

We did the research. Here's what holds up, what doesn't, and what we're building toward.

### Novel (no prior art found)

**Discrete event simulation as UI execution model.** No web framework uses a formal DES loop with delta cycles and simulation time. DES libraries exist (SIM.JS, SimScript) but for simulation workloads, not UI rendering. Jane Street's Bonsai is the most sophisticated graph-based reactive UI engine, but it's incremental computation, not DES. This is the core thesis.

**Static `__graph` artifact as compile output.** The compiler emits a JSON dependency graph alongside the JS. No framework does this. Marko does cross-file reactive analysis internally but doesn't expose it. Svelte builds an internal dep graph but doesn't emit it. Angular's Signal Graph is runtime-only. The `__graph` enables topology diffing, static analysis, and CI integration that runtime-only graphs can't.

### Novel in formulation (prior art for mechanism, not for DSL integration)

**Edge-triggered sensitivity as language syntax.** The mechanism exists — MobX's `when()` fires once when a predicate becomes true, RxJS's `pairwise()` detects transitions, Vue's `watch()` gives `(newValue, oldValue)`. But no framework offers `@(posedge x)` / `@(negedge x)` as a first-class compiled language construct. Comb compiles and runs edge-triggered blocks end-to-end. The value is in making edge detection declarative and compiler-verified, not in inventing edge detection.

**Propagator networks compiled from DSL.** David Thompson (Spritely project) built a working propagator-based FRP for web UI, presented at FOSDEM 2026. Sussman and Radul's 2009 work is the theoretical foundation. Cassowary.js handles layout constraints. What doesn't exist: a framework that compiles `constraint { }` blocks from a DSL into propagator networks with static analysis and graph artifact integration.

**Temporal assertions embedded in component model.** Quickstrom (Wickstrom, PLDI 2022) applies LTL to web application testing — it's real, published, peer-reviewed. The difference: Quickstrom is an external testing tool that observes the DOM from outside. Comb's temporal assertions live inside the component as graph nodes, running as development-time invariants with three operators (`eventually`, `always`, `next`) — closer to SystemVerilog Assertions (SVA) than to property-based testing.

**Universal unknown state with propagation.** Solid's `createResource` returns `T | undefined` until resolved. Leptos uses `Option<T>`. React Suspense makes loading implicit. What's different: applying X-state to *all* signals (not just async resources) with HDL-style propagation semantics — if any input is unknown, the output is unknown, and the compiler forces you to handle it.

### Not novel (stop claiming these)

- **Fine-grained reactivity** — SolidJS, Preact Signals
- **Compiler-verified dependencies** — Svelte, React Compiler, Marko
- **Reactive graph visualization** — Angular DevTools Signal Graph, SolidJS devtools, NoFlo
- **Directional ports** — Angular `@Input`/`@Output` since 2016, Elm ports
- **Waveform debugging** — Redux DevTools with a different skin (though Comb's waveform debugger now has zoom, pan, signal filtering, and auto-scroll)

## The DES Execution Model

When an event fires (user click, fetch response, timer), the simulator runs a deterministic loop:

```
Event enters → Delta 0: combinational logic (combs) settles
             → Delta 1: non-blocking assignments (<=) applied
             → Delta 2: if new combinational changes, settle again
             → ...repeat until quiescent...
             → DOM commit: only after full stabilization
```

The runtime implements this via the `SimulationEngine` in `src/runtime/signals.ts`, using real delta cycles. This gives formal guarantees that microtask-based frameworks can't:
- **Combs always see consistent state** — no reading a half-updated signal graph
- **Concurrent always blocks execute deterministically** — no surprises from effect ordering
- **DOM updates only after stabilization** — no partial renders, no glitch frames

Engine improvements:
- **Re-entrancy guard** — fixes multi-block delta cycle correctness
- **Single-computation fast path** — collapses feed-forward chains (no deferred writes when no conflict possible)
- **Verilator-style oscillation reporting** — names the oscillating signals with recent values when delta cycle limit is hit
- **Static cycle detection for always blocks** — not just combs

The practical difference from topological sorting (what Solid/Preact do): topological sort is a single pass. Delta cycles allow multi-pass stabilization where sequential logic (`<=`) creates new combinational dependencies that need another settle pass.

### Benchmark Results

Pipeline performance is ~1:1 with topological sort — the DES overhead is negligible for realistic dependency graphs. Linear chains are 3-8x slower (reactive system overhead, not delta cycles). See the Interactive Benchmarks demo for live comparisons.

## Features (Implemented)

- **DES execution model** — `SimulationEngine` with delta cycles for deterministic multi-pass stabilization
- **Edge-triggered sensitivity** — `@(posedge x)` / `@(negedge x)` compiles and runs end-to-end
- **Type system** — type checking with warnings (not errors) via `verify.ts`
- **Temporal assertions** — `assert temporal @(trigger) eventually/always/next(prop) within duration`
- **Static `__graph` artifact** — circuit topology extracted at compile time
- **Circuit topology diffing** — diff two `__graph`s to see what changed between versions
- **Auto-derived testing** — `__test()` export gives headless signal/comb access
- **Propagator networks** — bidirectional constraints via cells + propagators
- **Compiler-verified sensitivity lists** — wrong deps = compile error
- **Assertions as graph nodes** — `assert valid: condition;` visible in circuit
- **Design tokens** — `token accent: color = "#4a9eff"` → CSS custom property in the graph
- **Module composition** — directional ports with `input`/`output`
- **Scoped styles** — per-module CSS with auto-generated scope hashes
- **Browser-portable compiler** — runs entirely in the browser for the playground
- **Readable generated code** — inspect exactly what your `.comb` compiles to
- **Reactive edge counting** — `edgeCount(expr)` derives alert counts from event history, no manual counters
- **Change counting** — `changeCount(signal)` counts every value change (not just boolean edges like `edgeCount`)
- **Optional type annotations** — `signal x = 0;` works, types inferred from initial values
- **Syntax sugar** — `++`, `--`, `+=`, `-=` for concise signal updates
- **Custom functions** — `fn clamp(x, min, max) -> int { ... }`
- **Async blocks** — `async { await fetch(url); } catch { ... }`
- **String templates** — `` `Hello ${name}!` ``
- **Destructuring** — `const { a, b } = obj;`
- **Component slots** — `<slot />` for child content composition
- **Form elements** — select, textarea, checkbox, radio with `@bind`
- **Keyed lists** — `@for item in items key=item.id { ... }` with efficient reconciliation
- **SSR** — `renderToString(ModuleFactory)` for server-side rendering
- **Source maps** — `.js.map` emitted alongside compiled output
- **Router** — `createRouter(routes)` with hash-based reactive routing
- **CLI** — `comb compile`, `comb init <name>`, `comb dev`, `comb diff <a.comb> <b.comb>` (diffs reactive topology between two versions — shows added/removed/changed nodes and edges)

## Roadmap

### Implemented
- [x] Compiler pipeline (lexer, parser, verifier, codegen)
- [x] Reactive runtime (signals, combs, effects, cells, propagators)
- [x] Static `__graph` artifact + circuit visualization
- [x] Circuit topology diffing
- [x] Module composition with directional ports
- [x] Assertions as graph nodes
- [x] Design tokens as reactive CSS custom properties
- [x] Live playground with in-browser compilation
- [x] `__test()` auto-derived testing export
- [x] All demos compile from `.comb` (stock ticker, color picker, resizable layout, pipeline proof, ring counter, interactive benchmarks)
- [x] `constraint` blocks compile end-to-end through the compiler
- [x] Type checking (warnings on type mismatches via `verify.ts`)
- [x] Edge-triggered sensitivity: `@(posedge x)`, `@(negedge x)`
- [x] DES execution model with delta cycles (`SimulationEngine`)
- [x] Temporal assertions (SVA-lite): `assert temporal @(event) eventually/always/next(condition) within duration`
- [x] Re-entrancy guard + single-computation fast path in simulation engine
- [x] Verilator-style oscillation reporting
- [x] Static cycle detection for always blocks
- [x] `changeCount(signal)` builtin
- [x] `comb diff` CLI command for reactive topology diffing
- [x] Waveform debugger: zoom, pan, signal filtering, auto-scroll

### Planned
- [ ] Type system: range types, port compatibility, exhaustive enum matching
- [ ] X-value / unknown signal state with propagation semantics

## Architecture

### Compiler (`src/core/`)

Pure TypeScript, zero dependencies, runs in the browser. `compile(source) → { js, graph, errors }`.

- **Lexer** — Hand-written tokenizer with JSX-mode switching for `view {}` blocks
- **Parser** — Recursive descent + Pratt expression parsing. Context-sensitive `<=`
- **Verify** — Symbol table, undefined reference detection, circular dep detection, sensitivity list validation
- **CodeGen** — Emits readable JS targeting the runtime API
- **Graph Builder** — Extracts `__graph` with typed nodes, edges, and view-effect metadata

### Runtime (`src/runtime/`)

- **Signals** — Push-pull reactivity (signals push dirty flags, combs pull on read)
- **Cells** — Merge-semantic values for propagator networks
- **Propagators** — Directional constraint clauses
- **CircuitGraph** — Queryable data structure. Static graph loaded from `__graph`, runtime overlays live values
- **Effects** — Auto-tracking side effects for DOM updates
- **Batch** — Non-blocking assignment scheduling
- **DOM** — Fine-grained patching, no virtual DOM

### The `__graph` Pipeline

```
.comb → Compiler → __graph (JSON) → Circuit Visualizer
                                   → Topology Differ
                                   → Test Harness
                                   → Runtime (merges static + live values)
```

The `__graph` is the single data structure that every tool shares. The visualizer doesn't scrape the DOM — it reads `__graph`. The differ doesn't compare JS output — it compares `__graph`s. The test harness walks the `__graph` to find signals and combs.

## Theoretical Foundations

- **SystemVerilog** — Execution model and mental model: signals, combinational logic, non-blocking assignment, sensitivity lists, assertions
- **Sussman & Radul (2009)** — Propagator networks: cells + propagators = bidirectional constraint solving
- **SolidJS** — Fine-grained signal primitives and dependency tracking
- **Bonsai (Jane Street)** — Two-phase architecture: static graph construction + runtime execution
- **Svelte** — Compiler-based reactivity: shift work from runtime to build time
- **Esterel** — Synchronous reactive language proving the same model targets both UI and hardware
- **Quickstrom (PLDI 2022)** — LTL applied to web application testing (prior art for temporal assertions)
- **dthompson / Spritely (FOSDEM 2026)** — Propagator-based FRP for web UI (prior art for propagator UI)

## Known Limitations

- Type system emits warnings, not errors
- No npm package published yet
- No production build optimization

## Project Structure

```
comb/
├── src/
│   ├── core/           # Browser-portable compiler
│   ├── runtime/        # Reactive runtime + circuit graph
│   ├── demos/          # Interactive demos
│   ├── playground/     # Live editor
│   ├── cli/            # Node.js CLI wrapper
│   ├── generated/      # Compiled .comb → .js output
│   ├── visualizer.ts   # Canvas circuit graph renderer
│   └── waveform.ts     # Signal waveform debugger
├── examples/           # .comb source files
├── docs/
│   ├── language.md     # Language reference
│   └── research/       # Prior art, architecture, specs
└── playground.html     # Playground entry point
```

## License

Barbarian States License v1.0 — see [LICENSE](./LICENSE)
