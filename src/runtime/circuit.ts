// circuit.ts — CircuitGraph: introspectable reactive dependency graph
// Unifies compile-time static graph and runtime reactive graph

import type { StaticGraph, GraphNode as StaticGraphNode, GraphEdge as StaticGraphEdge } from '../core/graph.js';

export type NodeType = 'signal' | 'comb' | 'effect' | 'cell' | 'propagator';

export interface GraphNode {
  id: string;
  name: string;
  module: string;
  type: NodeType;
  valueType?: string;
  deps: string[];
  getValue: (() => any) | null;
  setValue: ((v: any) => void) | null;
  staticOrigin: boolean;
  runtimeAttached: boolean;
  staticType?: string; // original type from static graph (e.g. 'event', 'view-binding')
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface TemporalAssertionState {
  nodeId: string;
  module: string;
  name: string;
  triggered: number;
  passed: number;
  failed: number;
  pending: number;
}

export interface GraphEvent {
  type: 'signal-change' | 'comb-recompute' | 'effect-run' | 'assertion-failed' | 'assertion-armed' | 'assertion-passed';
  nodeId: string;
  timestamp: number;
  oldValue?: any;
  newValue?: any;
  assertInfo?: { expr: string; module: string; values: Record<string, any>; deadline?: number };
}

export interface VerifyIssue {
  type: 'unregistered' | 'extra';
  nodeId: string;
  message: string;
}

export interface GraphDiff {
  addedNodes: StaticGraphNode[];
  removedNodes: StaticGraphNode[];
  changedNodes: Array<{ id: string; before: StaticGraphNode; after: StaticGraphNode }>;
  addedEdges: StaticGraphEdge[];
  removedEdges: StaticGraphEdge[];
}

const EVENT_BUFFER_SIZE = 256;

export class CircuitGraph {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private events: GraphEvent[] = [];
  private eventWriteIdx = 0;
  private eventsFull = false;
  private listeners = new Set<(event: GraphEvent) => void>();
  private recording = false;
  private waveforms = new Map<string, Array<{ t: number; v: any }>>();
  private temporalAssertions = new Map<string, TemporalAssertionState>();

  private temporalDisposers = new Map<string, () => void>();

  registerTemporalAssertion(state: TemporalAssertionState, dispose: () => void): void {
    this.temporalDisposers.get(state.nodeId)?.();
    this.temporalAssertions.set(state.nodeId, state);
    this.temporalDisposers.set(state.nodeId, dispose);
  }

  getTemporalAssertions(module?: string): TemporalAssertionState[] {
    return [...this.temporalAssertions.values()]
      .filter(state => module === undefined || state.module === module)
      .map(state => ({ ...state }));
  }

  removeTemporalAssertion(nodeId: string): void {
    this.temporalAssertions.delete(nodeId);
    this.temporalDisposers.delete(nodeId);
  }

  private staticGraphs = new Map<string, StaticGraph>(); // module → static graph
  private cachedTimestamp = 0;
  private timestampFrame = -1;

  loadStaticGraph(graph: StaticGraph): void {
    // Detect module name from node IDs or default
    // Static graph node IDs don't have module prefix, so we infer from first registerNode later
    // For now, store the raw graph and pre-populate nodes
    for (const sn of graph.nodes) {
      // Static graph IDs are bare (e.g. "count", "event:increment")
      // We'll store them as-is initially; registerNode will match by name
      const existing = this.nodes.get(sn.id);
      if (!existing) {
        const nodeType: NodeType = sn.type === 'signal' ? 'signal' :
          sn.type === 'comb' ? 'comb' : 'effect';
        this.nodes.set(sn.id, {
          id: sn.id,
          name: sn.name,
          module: '',
          type: nodeType,
          deps: [],
          getValue: null,
          setValue: null,
          staticOrigin: true,
          runtimeAttached: false,
          staticType: sn.type,
        });
      }
    }

    for (const se of graph.edges) {
      const exists = this.edges.some(e => e.from === se.from && e.to === se.to);
      if (!exists) {
        this.edges.push({ from: se.from, to: se.to });
      }
    }
  }

  registerNode(info: { name: string; module: string; type: NodeType; deps?: string[]; valueType?: string }): string {
    const id = `${info.module}.${info.name}`;

    // Check if this node was pre-populated by loadStaticGraph (bare ID without module prefix)
    // Static graph uses bare names like "count", runtime uses "Counter.count"
    const staticNode = this.nodes.get(info.name);

    if (staticNode && staticNode.staticOrigin && !staticNode.runtimeAttached) {
      // Enrich the static node: update its ID to the runtime ID, mark as attached
      this.nodes.delete(info.name);
      staticNode.id = id;
      staticNode.module = info.module;
      staticNode.type = info.type;
      staticNode.valueType = info.valueType;
      staticNode.deps = info.deps ?? [];
      staticNode.runtimeAttached = true;
      this.nodes.set(id, staticNode);

      // Update edges that reference the old bare name
      for (const edge of this.edges) {
        if (edge.from === info.name) edge.from = id;
        if (edge.to === info.name) edge.to = id;
      }

      // Store module for static graph lookup
      if (!this.staticGraphs.has(info.module)) {
        // Will be set when loadStaticGraph stores it
      }

      // Add runtime edges (deduplicating)
      if (info.deps) {
        for (const dep of info.deps) {
          const depId = `${info.module}.${dep}`;
          const exists = this.edges.some(e => e.from === depId && e.to === id);
          if (!exists) this.edges.push({ from: depId, to: id });
        }
      }
    } else {
      // New runtime-only node
      this.nodes.set(id, {
        id,
        name: info.name,
        module: info.module,
        type: info.type,
        valueType: info.valueType,
        deps: info.deps ?? [],
        getValue: null,
        setValue: null,
        staticOrigin: false,
        runtimeAttached: true,
      });
      if (info.deps) {
        for (const dep of info.deps) {
          const depId = `${info.module}.${dep}`;
          this.edges.push({ from: depId, to: id });
        }
      }
    }

    return id;
  }

  setNodeValue(nodeId: string, getter: () => any): void {
    const node = this.nodes.get(nodeId);
    if (node) node.getValue = getter;
  }

  setNodeSetter(nodeId: string, setter: (v: any) => void): void {
    const node = this.nodes.get(nodeId);
    if (node) node.setValue = setter;
  }

  private pendingListenerEvents: GraphEvent[] = [];
  private listenerFlushScheduled = false;

  private scheduleListenerFlush(): void {
    if (this.listenerFlushScheduled) return;
    this.listenerFlushScheduled = true;
    queueMicrotask(() => {
      this.listenerFlushScheduled = false;
      const events = this.pendingListenerEvents.splice(0);
      for (const event of events) {
        for (const listener of this.listeners) listener(event);
      }
    });
  }

  private now(): number {
    // Cache timestamp per microtask frame — avoids repeated system calls during delta cycles
    const frame = this.pendingListenerEvents.length;
    if (frame !== this.timestampFrame) {
      this.cachedTimestamp = performance.now();
      this.timestampFrame = frame;
    }
    return this.cachedTimestamp;
  }

  private pushEvent(event: GraphEvent): void {
    if (this.eventsFull) {
      this.events[this.eventWriteIdx] = event;
    } else {
      this.events.push(event);
    }
    this.eventWriteIdx = (this.eventWriteIdx + 1) % EVENT_BUFFER_SIZE;
    if (!this.eventsFull && this.events.length >= EVENT_BUFFER_SIZE) {
      this.eventsFull = true;
    }
  }

  notifyChange(nodeId: string, oldValue: any, newValue: any): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    const eventType: GraphEvent['type'] =
      node.type === 'signal' || node.type === 'cell' ? 'signal-change' :
      node.type === 'comb' ? 'comb-recompute' : 'effect-run';
    const event: GraphEvent = { type: eventType, nodeId, timestamp: this.now(), oldValue, newValue };
    this.pushEvent(event);
    if (this.recording) this.recordWaveform(nodeId, newValue);
    this.pendingListenerEvents.push(event);
    this.scheduleListenerFlush();
  }

  notifyEffect(nodeId: string): void {
    const event: GraphEvent = { type: 'effect-run', nodeId, timestamp: this.now() };
    this.pushEvent(event);
    this.pendingListenerEvents.push(event);
    this.scheduleListenerFlush();
  }

  assertionArmed(assertId: string, info: { expr: string; module: string; deadline?: number }): void {
    const event: GraphEvent = {
      type: 'assertion-armed',
      nodeId: assertId,
      timestamp: this.now(),
      assertInfo: { ...info, values: {}, deadline: info.deadline },
    };
    this.pushEvent(event);
    if (this.recording) {
      this.recordWaveform(assertId, { status: 'armed', start: event.timestamp, end: info.deadline });
    }
    for (const listener of this.listeners) listener(event);
  }

  assertionPassed(assertId: string, info: { expr: string; module: string }): void {
    const event: GraphEvent = {
      type: 'assertion-passed',
      nodeId: assertId,
      timestamp: this.now(),
      assertInfo: { ...info, values: {} },
    };
    this.pushEvent(event);
    if (this.recording) {
      this.recordWaveform(assertId, { status: 'passed', start: event.timestamp, end: event.timestamp });
    }
    for (const listener of this.listeners) listener(event);
  }

  assertionFailed(assertId: string, info: { expr: string; module: string; values: Record<string, any> }): void {
    const event: GraphEvent = {
      type: 'assertion-failed',
      nodeId: assertId,
      timestamp: this.now(),
      assertInfo: info,
    };
    this.pushEvent(event);
    if (this.recording) {
      this.recordWaveform(assertId, { status: 'failed', start: event.timestamp, end: event.timestamp });
    }
    for (const listener of this.listeners) listener(event);
    console.warn(`[Comb] Assertion failed: ${info.expr}`, info.values);
  }

  subscribe(listener: (event: GraphEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getNodes(): GraphNode[] { return [...this.nodes.values()]; }
  getEdges(): GraphEdge[] { return [...this.edges]; }
  getNode(id: string): GraphNode | undefined { return this.nodes.get(id); }

  getModuleNodes(module: string): GraphNode[] {
    return this.getNodes().filter(n => n.module === module);
  }

  getRecentEvents(n = 50): GraphEvent[] {
    if (!this.eventsFull) return this.events.slice(-n);
    // Ring buffer: read from writeIdx backwards
    const result: GraphEvent[] = [];
    const total = Math.min(n, EVENT_BUFFER_SIZE);
    for (let i = 0; i < total; i++) {
      const idx = (this.eventWriteIdx - 1 - i + EVENT_BUFFER_SIZE) % EVENT_BUFFER_SIZE;
      result.unshift(this.events[idx]);
    }
    return result;
  }

  snapshot(): object {
    return {
      nodes: this.getNodes().map(n => ({
        id: n.id, name: n.name, module: n.module, type: n.type,
        deps: n.deps, valueType: n.valueType,
        staticOrigin: n.staticOrigin, runtimeAttached: n.runtimeAttached,
        value: n.getValue ? n.getValue() : undefined,
      })),
      edges: this.getEdges(),
      recentEvents: this.events.slice(-20),
    };
  }

  // --- Static graph management ---

  verifyGraph(module: string): VerifyIssue[] {
    const issues: VerifyIssue[] = [];
    for (const node of this.nodes.values()) {
      if (node.module === module || (node.module === '' && node.staticOrigin)) {
        if (node.staticOrigin && !node.runtimeAttached) {
          issues.push({
            type: 'unregistered',
            nodeId: node.id,
            message: `Static node '${node.name}' was not registered at runtime`,
          });
        }
      }
      if (node.module === module && !node.staticOrigin) {
        issues.push({
          type: 'extra',
          nodeId: node.id,
          message: `Runtime node '${node.name}' has no static graph entry`,
        });
      }
    }
    return issues;
  }

  getStaticGraph(module: string): StaticGraph {
    const nodes: StaticGraphNode[] = [];
    const edges: StaticGraphEdge[] = [];

    for (const node of this.nodes.values()) {
      if (node.module === module && node.staticOrigin) {
        nodes.push({
          id: node.name,
          name: node.name,
          type: (node.staticType ?? node.type) as StaticGraphNode['type'],
        });
      }
    }

    // Convert runtime edges back to static format
    for (const edge of this.edges) {
      const fromNode = this.nodes.get(edge.from);
      const toNode = this.nodes.get(edge.to);
      if (fromNode?.module === module && toNode?.module === module &&
          fromNode.staticOrigin && toNode.staticOrigin) {
        edges.push({
          from: fromNode.name,
          to: toNode.name,
          type: 'data',
        });
      }
    }

    return { nodes, edges };
  }

  static diffGraphs(a: StaticGraph, b: StaticGraph): GraphDiff {
    const aNodeMap = new Map(a.nodes.map(n => [n.id, n]));
    const bNodeMap = new Map(b.nodes.map(n => [n.id, n]));

    const addedNodes: StaticGraphNode[] = [];
    const removedNodes: StaticGraphNode[] = [];
    const changedNodes: Array<{ id: string; before: StaticGraphNode; after: StaticGraphNode }> = [];

    for (const [id, node] of bNodeMap) {
      if (!aNodeMap.has(id)) addedNodes.push(node);
      else {
        const aNode = aNodeMap.get(id)!;
        if (aNode.type !== node.type) {
          changedNodes.push({ id, before: aNode, after: node });
        }
      }
    }
    for (const [id, node] of aNodeMap) {
      if (!bNodeMap.has(id)) removedNodes.push(node);
    }

    const edgeKey = (e: StaticGraphEdge) => `${e.from}→${e.to}:${e.type}`;
    const aEdgeSet = new Set(a.edges.map(edgeKey));
    const bEdgeSet = new Set(b.edges.map(edgeKey));

    const addedEdges = b.edges.filter(e => !aEdgeSet.has(edgeKey(e)));
    const removedEdges = a.edges.filter(e => !bEdgeSet.has(edgeKey(e)));

    return { addedNodes, removedNodes, changedNodes, addedEdges, removedEdges };
  }

  // --- Waveform recording ---

  startRecording(): void {
    this.recording = true;
    this.waveforms.clear();
    // Seed with current values so unchanged signals show flat lines
    const t = performance.now();
    for (const [id, node] of this.nodes) {
      if (node.getValue && (node.type === 'signal' || node.type === 'cell' || node.type === 'comb')) {
        try {
          const v = node.getValue();
          if (v !== undefined) {
            this.waveforms.set(id, [{ t, v }]);
          }
        } catch (_) { /* getValue may not be ready yet */ }
      }
    }
  }

  stopRecording(): void {
    this.recording = false;
  }

  getWaveformData(): Map<string, Array<{ t: number; v: any }>> {
    return new Map(this.waveforms);
  }

  private recordWaveform(nodeId: string, value: any): void {
    let buf = this.waveforms.get(nodeId);
    if (!buf) { buf = []; this.waveforms.set(nodeId, buf); }
    buf.push({ t: this.now(), v: value });
    if (buf.length > 2000) buf.shift();
  }

  reset(): void {
    this.nodes.clear();
    this.edges = [];
    this.events = [];
    this.eventWriteIdx = 0;
    this.eventsFull = false;
    this.listeners.clear();
    this.recording = false;
    this.waveforms.clear();
    this.staticGraphs.clear();
    for (const dispose of [...this.temporalDisposers.values()]) dispose();
    this.temporalAssertions.clear();
    this.temporalDisposers.clear();
    this.pendingListenerEvents = [];
    this.listenerFlushScheduled = false;
  }
}

export const circuit = new CircuitGraph();
