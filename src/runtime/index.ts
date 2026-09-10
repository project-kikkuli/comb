// index.ts — Runtime re-exports

export { createSignal, createComb, createEffect, batch, deferredBatch, untrack, createScope, createCell, createPropagator, onMount, onDestroy, createEdgeEffect, createEdgeCounter, createChangeCounter, createTemporalAssert, X } from './signals.js';
export type { XValue } from './signals.js';
export { circuit, CircuitGraph } from './circuit.js';
export type { GraphNode, GraphEdge, GraphEvent, NodeType, VerifyIssue, GraphDiff } from './circuit.js';
export { rgbToHsv, hsvToRgb, rgbToHex } from './color.js';
export { reconcileKeyed } from './reconcile.js';
export type { KeyedState } from './reconcile.js';
export { renderToString } from './ssr.js';
export { createRouter } from './router.js';
export type { Route } from './router.js';
export { coverage, CoverageCollector } from './coverage.js';
export type { CoverageReport, ToggleCoverage, TransitionCoverage, CrossCoverage } from './coverage.js';
export { runAutoTest, renderAutoTestResult } from './autotest.js';
export type { AutoTestResult, AutoTestOptions } from './autotest.js';
