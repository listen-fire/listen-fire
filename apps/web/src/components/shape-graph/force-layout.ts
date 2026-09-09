// Force-directed layout for the shape-graph canvas.
//
// Distilled from the ontology editor's d3-force pattern at
// `apps/web/src/components/ontology/graph.tsx` — same simulation
// recipe (link + manyBody + collide + edge-node repulsion + edge
// uncrossing) but parameterised over node width / height and the
// node "row" classifier so consumers with messages-on-top
// affordances (the ontology) can opt in.
//
// The simulation produces one tick of fixed positions per shape
// edit; downstream re-layouts happen when the consumer hands in a
// new shape (the primitive recomputes positions in a `useMemo`
// keyed on shape identity).

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';

export interface LayoutNode {
  id: string;
  /** Optional band assignment — nodes sharing a band gravitate
   *  to the same Y line. Generic shapes leave it undefined
   *  (single band); ontology surfaces use it to keep messages
   *  visually separated from objects. */
  band?: string;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  /** Band-Y mapping — nodes with `band === key` get pulled toward
   *  `value`. Bands not in the map fall back to 0 (origin). */
  bandY?: Record<string, number>;
  /** Simulation iteration count. Defaults to 500 — the ontology
   *  graph's empirically-tuned value. */
  ticks?: number;
}

export interface PositionedNode {
  id: string;
  position: { x: number; y: number };
}

interface ForceNode extends SimulationNodeDatum {
  id: string;
  band: string;
}

function closestTOnSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
) {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return 0;
  return Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2));
}

function segmentsCross(
  a1x: number,
  a1y: number,
  a2x: number,
  a2y: number,
  b1x: number,
  b1y: number,
  b2x: number,
  b2y: number,
) {
  const d1x = a2x - a1x;
  const d1y = a2y - a1y;
  const d2x = b2x - b1x;
  const d2y = b2y - b1y;
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-8) return false;
  const t = ((b1x - a1x) * d2y - (b1y - a1y) * d2x) / cross;
  const u = ((b1x - a1x) * d1y - (b1y - a1y) * d1x) / cross;
  return t > 0.05 && t < 0.95 && u > 0.05 && u < 0.95;
}

function forceEdgeNodeRepulsion(
  links: SimulationLinkDatum<ForceNode>[],
  strength: number,
  radius: number,
) {
  let nodes: ForceNode[] = [];

  function force(alpha: number) {
    for (const link of links) {
      const src = link.source as ForceNode;
      const tgt = link.target as ForceNode;
      if (src.x == null || src.y == null || tgt.x == null || tgt.y == null)
        continue;

      for (const node of nodes) {
        if (node === src || node === tgt) continue;
        if (node.x == null || node.y == null) continue;

        const t = closestTOnSegment(src.x, src.y, tgt.x, tgt.y, node.x, node.y);
        const cx = src.x + t * (tgt.x - src.x);
        const cy = src.y + t * (tgt.y - src.y);
        const dx = node.x - cx;
        const dy = node.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        if (dist > radius) continue;

        const push = (alpha * strength * (1 - dist / radius)) / dist;
        node.vx = (node.vx ?? 0) + dx * push;
        node.vy = (node.vy ?? 0) + dy * push;
      }
    }
  }

  force.initialize = (n: ForceNode[]) => {
    nodes = n;
  };
  return force;
}

function forceEdgeUncross(
  links: SimulationLinkDatum<ForceNode>[],
  strength: number,
) {
  function force(alpha: number) {
    for (let i = 0; i < links.length; i++) {
      const a = links[i];
      const a1 = a.source as ForceNode;
      const a2 = a.target as ForceNode;
      if (a1.x == null || a1.y == null || a2.x == null || a2.y == null)
        continue;

      for (let j = i + 1; j < links.length; j++) {
        const b = links[j];
        const b1 = b.source as ForceNode;
        const b2 = b.target as ForceNode;
        if (b1.x == null || b1.y == null || b2.x == null || b2.y == null)
          continue;
        if (a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2) continue;
        if (
          !segmentsCross(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y, b2.x, b2.y)
        )
          continue;

        const amx = (a1.x + a2.x) / 2;
        const amy = (a1.y + a2.y) / 2;
        const bmx = (b1.x + b2.x) / 2;
        const bmy = (b1.y + b2.y) / 2;
        let dx = amx - bmx;
        let dy = amy - bmy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        dx /= dist;
        dy /= dist;

        const push = alpha * strength;
        a1.vx = (a1.vx ?? 0) + dx * push;
        a1.vy = (a1.vy ?? 0) + dy * push;
        a2.vx = (a2.vx ?? 0) + dx * push;
        a2.vy = (a2.vy ?? 0) + dy * push;
        b1.vx = (b1.vx ?? 0) - dx * push;
        b1.vy = (b1.vy ?? 0) - dy * push;
        b2.vx = (b2.vx ?? 0) - dx * push;
        b2.vy = (b2.vy ?? 0) - dy * push;
      }
    }
  }

  force.initialize = () => {};
  return force;
}

/**
 * Run one full layout pass. Pure: given the same inputs, produces
 * the same positions (deterministic seed via angle * 2.399 +
 * radius ramp — matches the ontology graph's seeding so visual
 * stability across surfaces is preserved).
 */
export function layoutShapeGraph(
  nodes: ReadonlyArray<LayoutNode>,
  edges: ReadonlyArray<LayoutEdge>,
  options: LayoutOptions,
): PositionedNode[] {
  if (nodes.length === 0) return [];

  const forceNodes: ForceNode[] = nodes.map((n, i) => {
    const angle = i * 2.399;
    const radius = 80 + i * 30;
    return {
      id: n.id,
      band: n.band ?? '__default__',
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
  });
  const nodeById = new Map(forceNodes.map((n) => [n.id, n]));

  const forceLinks: SimulationLinkDatum<ForceNode>[] = edges
    .map((e) => ({
      source: nodeById.get(e.source)!,
      target: nodeById.get(e.target)!,
    }))
    .filter((l) => l.source && l.target);

  const sim = forceSimulation(forceNodes)
    .force('link', forceLink(forceLinks).distance(220).strength(0.35))
    .force('charge', forceManyBody().strength(-800))
    .force('collide', forceCollide(options.nodeWidth))
    .force('edgeNodeRepulsion', forceEdgeNodeRepulsion(forceLinks, 120, 160))
    .force('edgeUncross', forceEdgeUncross(forceLinks, 50))
    .force('centerX', forceX<ForceNode>(0).strength(0.04));

  if (options.bandY) {
    const bandY = options.bandY;
    sim.force(
      'bandY',
      forceY<ForceNode>((d) => bandY[d.band] ?? 0).strength((d) =>
        bandY[d.band] !== undefined ? 0.12 : 0.02,
      ),
    );
  }

  sim.alphaDecay(0.01).stop();

  for (let i = 0; i < (options.ticks ?? 500); i++) sim.tick();

  return forceNodes.map((fn) => ({
    id: fn.id,
    position: {
      x: (fn.x ?? 0) - options.nodeWidth / 2,
      y: (fn.y ?? 0) - options.nodeHeight / 2,
    },
  }));
}

/**
 * Geometry helper — closest point on a node's bounding rectangle
 * to a line from its centre toward `(ox, oy)`. The custom edge
 * component uses this to clip edges at the node border instead
 * of overlapping the node body.
 */
export function clipLineToRect(
  cx: number,
  cy: number,
  w: number,
  h: number,
  ox: number,
  oy: number,
): { x: number; y: number } {
  const dx = ox - cx;
  const dy = oy - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = w / 2;
  const hh = h / 2;
  const t =
    Math.abs(dx) * hh > Math.abs(dy) * hw
      ? hw / Math.abs(dx)
      : hh / Math.abs(dy);
  return { x: cx + dx * t, y: cy + dy * t };
}
