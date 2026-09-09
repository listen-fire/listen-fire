'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  Background,
  BackgroundVariant,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useInternalNode,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
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
import { trpc } from '@/lib/trpc';
import { TemplateGallery } from './template-gallery';

import type { SummaryNodeType, SummaryEdgeType, SummaryPropertyType, GraphSelection } from './types';

const NODE_WIDTH = 180;
const NODE_HEIGHT = 56;

const CATEGORY_STYLES: Record<string, { bg: string; border: string; text: string; badge: string; accent: string; icon: string }> = {
  message: { bg: 'bg-white', border: 'border-orange-400', text: 'text-orange-700', badge: 'bg-orange-100 text-orange-700', accent: 'bg-orange-400', icon: 'text-orange-400' },
  object: { bg: 'bg-white', border: 'border-blue-400', text: 'text-blue-700', badge: 'bg-blue-100 text-blue-700', accent: 'bg-blue-400', icon: 'text-blue-400' },
  scoped_object: { bg: 'bg-white', border: 'border-blue-400', text: 'text-blue-700', badge: 'bg-blue-100 text-blue-700', accent: 'bg-blue-400', icon: 'text-blue-400' },
  property: { bg: 'bg-white', border: 'border-purple-400', text: 'text-purple-700', badge: 'bg-purple-100 text-purple-700', accent: 'bg-purple-400', icon: 'text-purple-400' },
};

const CATEGORY_LABEL: Record<string, string> = {
  message: 'message',
  object: 'object',
  scoped_object: 'object',
  property: 'property',
};

// -- Force layout --

type ForceNode = SimulationNodeDatum & { id: string; category: string };

/** Closest point on segment (ax,ay)→(bx,by) to point (px,py), returned as t in [0,1]. */
function closestTOnSegment(ax: number, ay: number, bx: number, by: number, px: number, py: number) {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return 0;
  return Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2));
}

/** Do segments (a1→a2) and (b1→b2) cross? */
function segmentsCross(
  a1x: number, a1y: number, a2x: number, a2y: number,
  b1x: number, b1y: number, b2x: number, b2y: number,
) {
  const d1x = a2x - a1x, d1y = a2y - a1y;
  const d2x = b2x - b1x, d2y = b2y - b1y;
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-8) return false;
  const t = ((b1x - a1x) * d2y - (b1y - a1y) * d2x) / cross;
  const u = ((b1x - a1x) * d1y - (b1y - a1y) * d1x) / cross;
  return t > 0.05 && t < 0.95 && u > 0.05 && u < 0.95;
}

/**
 * Repels nodes away from nearby edge bodies (not just midpoints).
 * Projects each node onto the closest point on every non-incident edge.
 */
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
      if (src.x == null || src.y == null || tgt.x == null || tgt.y == null) continue;

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

  force.initialize = (n: ForceNode[]) => { nodes = n; };
  return force;
}

/**
 * Detects crossing edges and pushes their non-shared endpoints apart
 * to untangle the layout.
 */
function forceEdgeUncross(links: SimulationLinkDatum<ForceNode>[], strength: number) {
  function force(alpha: number) {
    for (let i = 0; i < links.length; i++) {
      const a = links[i];
      const a1 = a.source as ForceNode, a2 = a.target as ForceNode;
      if (a1.x == null || a1.y == null || a2.x == null || a2.y == null) continue;

      for (let j = i + 1; j < links.length; j++) {
        const b = links[j];
        const b1 = b.source as ForceNode, b2 = b.target as ForceNode;
        if (b1.x == null || b1.y == null || b2.x == null || b2.y == null) continue;

        // Skip if edges share a node — those can't really uncross
        if (a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2) continue;

        if (!segmentsCross(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y, b2.x, b2.y)) continue;

        // Push non-shared endpoints perpendicular to each other
        // Strategy: rotate edge A's midpoint→edgeB's midpoint vector as push direction
        const amx = (a1.x + a2.x) / 2, amy = (a1.y + a2.y) / 2;
        const bmx = (b1.x + b2.x) / 2, bmy = (b1.y + b2.y) / 2;
        let dx = amx - bmx, dy = amy - bmy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        dx /= dist; dy /= dist;

        const push = alpha * strength;
        // Push edge A's endpoints in one direction, edge B's in the other
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

function getForceLayoutedElements(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  if (nodes.length === 0) return { nodes: [], edges: [] };

  const forceNodes: ForceNode[] = nodes.map((n, i) => {
    const category = (n.data as OntologyNodeData).category;
    const angle = i * 2.399;
    const radius = 80 + i * 30;
    return {
      id: n.id,
      category,
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

  const simulation = forceSimulation(forceNodes)
    .force('link', forceLink(forceLinks).distance(250).strength(0.35))
    .force('charge', forceManyBody().strength(-900))
    .force('collide', forceCollide(NODE_WIDTH))
    .force('edgeNodeRepulsion', forceEdgeNodeRepulsion(forceLinks, 120, 180))
    .force('edgeUncross', forceEdgeUncross(forceLinks, 60))
    .force('centerX', forceX<ForceNode>(0).strength(0.03))
    .force('messageY', forceY<ForceNode>((d) => d.category === 'message' ? -300 : 100).strength((d) => d.category === 'message' ? 0.12 : 0.02))
    .alphaDecay(0.01)
    .stop();

  for (let i = 0; i < 500; i++) simulation.tick();

  const layoutedNodes = nodes.map((node) => {
    const fn = nodeById.get(node.id)!;
    return {
      ...node,
      position: {
        x: (fn.x ?? 0) - NODE_WIDTH / 2,
        y: (fn.y ?? 0) - NODE_HEIGHT / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}

// -- Geometry helpers --

function clipLineToRect(cx: number, cy: number, w: number, h: number, ox: number, oy: number) {
  const dx = ox - cx;
  const dy = oy - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = w / 2;
  const hh = h / 2;
  const t = Math.abs(dx) * hh > Math.abs(dy) * hw ? hw / Math.abs(dx) : hh / Math.abs(dy);
  return { x: cx + dx * t, y: cy + dy * t };
}

// -- Custom Edge --

type OntologyEdgeData = {
  curveOffset?: number;
  scopes?: boolean;
  edgeGroup?: string | null;
  isBundled?: boolean;
  bundleCount?: number;
  bundledEdgeIds?: string[];
};

function OntologyEdgeComponent(props: EdgeProps) {
  const { id, source, target, markerEnd, style, data, label, labelStyle } = props;
  const edgeData = data as OntologyEdgeData | undefined;
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  if (!sourceNode || !targetNode) return null;

  const sw = sourceNode.measured.width ?? NODE_WIDTH;
  const sh = sourceNode.measured.height ?? NODE_HEIGHT;
  const tw = targetNode.measured.width ?? NODE_WIDTH;
  const th = targetNode.measured.height ?? NODE_HEIGHT;

  const sCx = sourceNode.internals.positionAbsolute.x + sw / 2;
  const sCy = sourceNode.internals.positionAbsolute.y + sh / 2;
  const tCx = targetNode.internals.positionAbsolute.x + tw / 2;
  const tCy = targetNode.internals.positionAbsolute.y + th / 2;

  const s = clipLineToRect(sCx, sCy, sw, sh, tCx, tCy);
  const t = clipLineToRect(tCx, tCy, tw, th, sCx, sCy);

  const curveOffset = edgeData?.curveOffset ?? 0;

  let path: string;
  let labelX: number;
  let labelY: number;

  if (curveOffset === 0) {
    path = `M ${s.x} ${s.y} L ${t.x} ${t.y}`;
    labelX = (s.x + t.x) / 2;
    labelY = (s.y + t.y) / 2;
  } else {
    const mx = (s.x + t.x) / 2;
    const my = (s.y + t.y) / 2;
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const cx = mx + nx * curveOffset;
    const cy = my + ny * curveOffset;
    path = `M ${s.x} ${s.y} Q ${cx} ${cy} ${t.x} ${t.y}`;
    labelX = (s.x + 2 * cx + t.x) / 4;
    labelY = (s.y + 2 * cy + t.y) / 4;
  }

  const isBundled = edgeData?.isBundled;

  return (
    <g className="react-flow__edge-interaction">
      <path d={path} fill="none" stroke="transparent" strokeWidth={20} style={{ cursor: 'pointer' }} />
      <path id={id} d={path} fill="none" markerEnd={markerEnd as string} style={{ ...style, pointerEvents: 'none', transition: 'stroke 200ms, stroke-width 200ms, opacity 200ms' }} />
      {isBundled && edgeData?.bundleCount ? (
        <>
          <circle
            cx={labelX}
            cy={labelY}
            r={10}
            fill="white"
            stroke={(style as React.CSSProperties)?.stroke as string ?? '#D4DBE5'}
            strokeWidth={1.5}
            style={{ cursor: 'pointer', pointerEvents: 'none', transition: 'opacity 200ms', opacity: (style as React.CSSProperties)?.opacity ?? 1 }}
          />
          <text
            x={labelX}
            y={labelY}
            textAnchor="middle"
            dominantBaseline="central"
            style={{ fontSize: 9, fontWeight: 600, fill: (labelStyle as React.CSSProperties)?.fill ?? '#94A3B8', pointerEvents: 'none', transition: 'opacity 200ms', opacity: (labelStyle as React.CSSProperties)?.opacity ?? 1 }}
          >
            {edgeData.bundleCount}
          </text>
        </>
      ) : label ? (
        <>
          <rect
            x={labelX - 30}
            y={labelY - 8}
            width={60}
            height={16}
            fill="white"
            fillOpacity={0.9}
            rx={3}
            style={{ pointerEvents: 'none', transition: 'opacity 200ms', opacity: (labelStyle as React.CSSProperties)?.opacity ?? 1 }}
          />
          <text
            x={labelX}
            y={labelY}
            textAnchor="middle"
            dominantBaseline="central"
            style={{ ...(labelStyle as React.CSSProperties), pointerEvents: 'none', transition: 'opacity 200ms' }}
          >
            {label}
          </text>
        </>
      ) : null}
    </g>
  );
}

// -- Custom Node --

type OntologyNodeData = {
  label: string;
  category: string;
  propertyCount: number;
  emphasis: 'normal' | 'active' | 'faded';
  nodeTypeId: string;
  iconSvg: string | null;
};

function OntologyNodeComponent({ data, selected }: NodeProps<Node<OntologyNodeData>>) {
  const style = CATEGORY_STYLES[data.category] ?? CATEGORY_STYLES.object;
  const isFaded = data.emphasis === 'faded';

  return (
    <div
      className={`
        flex overflow-hidden rounded-lg cursor-pointer
        transition-[opacity,border-color,box-shadow] duration-200
        ${style.bg} border
        ${selected ? `${style.border} shadow-lg ring-1 ring-black/5` : 'border-gray-200 shadow-sm hover:shadow-md hover:border-gray-300'}
        ${isFaded ? 'opacity-30' : ''}
      `}
      style={{ minWidth: NODE_WIDTH }}
    >
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ width: 0, height: 0, background: 'transparent', border: 'none', opacity: 0, pointerEvents: 'none' }}
      />
      <div className={`w-1 shrink-0 ${style.accent}`} />
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span className="flex-1 truncate text-[13px] font-medium text-gray-800">{data.label}</span>
        {data.propertyCount > 0 && (
          <span className="rounded-full bg-gray-100 px-1.5 text-[9px] font-medium text-gray-500">
            {data.propertyCount}
          </span>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        style={{ width: 0, height: 0, background: 'transparent', border: 'none', opacity: 0, pointerEvents: 'none' }}
      />
    </div>
  );
}

const nodeTypes = { ontologyNode: OntologyNodeComponent };
const edgeTypes = { ontologyEdge: OntologyEdgeComponent };

// -- Data conversion --

function ontologyToFlowElements(
  nodeTypesList: SummaryNodeType[],
  edgeTypesList: SummaryEdgeType[],
  propertyTypesList: SummaryPropertyType[],
): { nodes: Node[]; edges: Edge[] } {
  const propertyCountByParent = new Map<string, number>();
  for (const pt of propertyTypesList) {
    const ownerId = pt.node_type_id ?? pt.edge_type_id;
    if (ownerId) propertyCountByParent.set(ownerId, (propertyCountByParent.get(ownerId) ?? 0) + 1);
  }

  const nodes: Node[] = nodeTypesList.map((nt) => ({
    id: nt.id,
    type: 'ontologyNode',
    position: { x: 0, y: 0 },
    data: {
      label: nt.name,
      category: nt.category,
      propertyCount: propertyCountByParent.get(nt.id) ?? 0,
      emphasis: 'normal' as const,
      nodeTypeId: nt.id,
      iconSvg: nt.icon_svg,
    },
  }));

  const pairCounts = new Map<string, number>();
  const pairIndex = new Map<string, number>();
  for (const et of edgeTypesList) {
    const key = [et.source_node_type_id, et.target_node_type_id].sort().join('::');
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }

  const groupLabelRendered = new Set<string>();
  const totalEdges = edgeTypesList.length;

  const edges: Edge[] = edgeTypesList.map((et, globalIdx) => {
    const key = [et.source_node_type_id, et.target_node_type_id].sort().join('::');
    const pairCount = pairCounts.get(key) ?? 1;
    const pIdx = pairIndex.get(key) ?? 0;
    pairIndex.set(key, pIdx + 1);

    const parallelOffset = pairCount > 1 ? (pIdx - (pairCount - 1) / 2) * 25 : 0;
    const baselineOffset = (globalIdx - (totalEdges - 1) / 2) * 3;
    const curveOffset = parallelOffset + baselineOffset;

    const group = et.edge_group;
    const isGrouped = !!group;
    let label: string | undefined;
    if (isGrouped) {
      if (!groupLabelRendered.has(group!)) {
        label = et.outbound_name.replace(/_(?:org|person)$/, '').replace(/_/g, ' ');
        groupLabelRendered.add(group!);
      }
    } else {
      label = et.outbound_name.replace(/_/g, ' ');
    }

    return {
      id: et.id,
      source: et.source_node_type_id,
      target: et.target_node_type_id,
      type: 'ontologyEdge',
      label,
      labelStyle: { fontSize: 10, fill: '#CBD5E1' },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#D4DBE5', width: 14, height: 14 },
      style: { stroke: '#D4DBE5', strokeWidth: 1 },
      data: { curveOffset, scopes: et.scopes, edgeGroup: group ?? null },
    };
  });

  if (nodes.length === 0) return { nodes: [], edges: [] };
  return getForceLayoutedElements(nodes, edges);
}

// -- Edge bundling --

function bundleEdges(edges: Edge[], expandedPairs: Set<string>): Edge[] {
  const groups = new Map<string, Edge[]>();
  for (const edge of edges) {
    const key = [edge.source, edge.target].sort().join('::');
    const group = groups.get(key) ?? [];
    group.push(edge);
    groups.set(key, group);
  }

  const result: Edge[] = [];
  for (const [key, group] of groups) {
    if (group.length <= 1 || expandedPairs.has(key)) {
      result.push(...group);
    } else {
      result.push({
        id: `bundle:${key}`,
        source: group[0].source,
        target: group[0].target,
        type: 'ontologyEdge',
        labelStyle: { fontSize: 10, fill: '#94A3B8' },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#D4DBE5', width: 14, height: 14 },
        style: { stroke: '#D4DBE5', strokeWidth: 1.5 },
        data: {
          curveOffset: 0,
          isBundled: true,
          bundleCount: group.length,
          bundledEdgeIds: group.map((e) => e.id),
          edgeGroup: null,
        } satisfies OntologyEdgeData,
      });
    }
  }
  return result;
}

// -- Selection emphasis --

function applySelectionEmphasis(
  nodes: Node[],
  edges: Edge[],
  selection: GraphSelection,
  hoveredNodeId: string | null,
  searchFilter?: string,
): { nodes: Node[]; edges: Edge[] } {
  // Search filter mode: highlight matching nodes, fade others
  if (searchFilter) {
    const query = searchFilter.toLowerCase();
    const matchingIds = new Set(
      nodes
        .filter((n) => (n.data as OntologyNodeData).label.toLowerCase().includes(query))
        .map((n) => n.id),
    );
    const activeEdgeIds = new Set<string>();
    for (const edge of edges) {
      if (matchingIds.has(edge.source) || matchingIds.has(edge.target)) {
        activeEdgeIds.add(edge.id);
      }
    }
    const updatedNodes = nodes.map((n) => ({
      ...n,
      data: {
        ...(n.data as OntologyNodeData),
        emphasis: matchingIds.has(n.id) ? 'active' as const : 'faded' as const,
      },
    }));
    const updatedEdges = edges.map((edge) => {
      if (activeEdgeIds.has(edge.id)) {
        return {
          ...edge,
          zIndex: 10,
          style: { stroke: '#8778F7', strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#8778F7', width: 16, height: 16 },
          labelStyle: { fontSize: 10, fill: '#6B5BD4', fontWeight: 600 },
        };
      }
      return {
        ...edge,
        zIndex: 0,
        style: { stroke: '#E5E7EB', strokeWidth: 0.75, opacity: 0.3 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#E5E7EB', width: 10, height: 10, opacity: 0.3 },
        labelStyle: { fontSize: 10, fill: '#D1D5DB', opacity: 0.3 },
      };
    });
    return { nodes: updatedNodes, edges: updatedEdges };
  }
  // Resting state: edges hidden, nodes normal
  if (!selection && !hoveredNodeId) {
    const resetNodes = nodes.map((n) => ({
      ...n,
      data: { ...(n.data as OntologyNodeData), emphasis: 'normal' as const },
    }));
    const hiddenEdges = edges.map((edge) => ({
      ...edge,
      zIndex: 0,
      style: { stroke: '#D4DBE5', strokeWidth: 1, opacity: 0 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#D4DBE5', width: 14, height: 14, opacity: 0 },
      labelStyle: { fontSize: 10, fill: '#CBD5E1', opacity: 0 },
    }));
    return { nodes: resetNodes, edges: hiddenEdges };
  }

  // Hover state (no click selection): show connected edges at normal weight
  if (!selection && hoveredNodeId) {
    const activeEdgeIds = new Set<string>();
    const activeNodeIds = new Set<string>();
    activeNodeIds.add(hoveredNodeId);
    for (const edge of edges) {
      if (edge.source === hoveredNodeId || edge.target === hoveredNodeId) {
        activeEdgeIds.add(edge.id);
        activeNodeIds.add(edge.source);
        activeNodeIds.add(edge.target);
      }
    }
    const updatedNodes = nodes.map((n) => ({
      ...n,
      data: { ...(n.data as OntologyNodeData), emphasis: 'normal' as const },
    }));
    const updatedEdges = edges.map((edge) => {
      if (activeEdgeIds.has(edge.id)) {
        return {
          ...edge,
          zIndex: 10,
          style: { stroke: '#94A3B8', strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#94A3B8', width: 14, height: 14 },
          labelStyle: { fontSize: 10, fill: '#94A3B8' },
        };
      }
      return {
        ...edge,
        zIndex: 0,
        style: { stroke: '#D4DBE5', strokeWidth: 1, opacity: 0 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#D4DBE5', width: 14, height: 14, opacity: 0 },
        labelStyle: { fontSize: 10, fill: '#CBD5E1', opacity: 0 },
      };
    });
    return { nodes: updatedNodes, edges: updatedEdges };
  }

  // Click selection active — highlight connected edges
  if (!selection) return { nodes, edges }; // unreachable, satisfies narrowing

  let selectedGroup: string | null = null;
  if (selection.type === 'edge') {
    const selectedEdge = edges.find((e) => e.id === selection.id);
    selectedGroup = (selectedEdge?.data as { edgeGroup?: string | null } | undefined)?.edgeGroup ?? null;
  }

  // Collect active edges and nodes
  const activeEdgeIds = new Set<string>();
  const activeNodeIds = new Set<string>();

  if (selection.type === 'node') {
    activeNodeIds.add(selection.id);
    for (const edge of edges) {
      if (edge.source === selection.id || edge.target === selection.id) {
        activeEdgeIds.add(edge.id);
        activeNodeIds.add(edge.source);
        activeNodeIds.add(edge.target);
      }
    }
  } else if (selection.type === 'edge') {
    for (const edge of edges) {
      const edgeGroup = (edge.data as { edgeGroup?: string | null } | undefined)?.edgeGroup ?? null;
      if (edge.id === selection.id || (selectedGroup && edgeGroup === selectedGroup)) {
        activeEdgeIds.add(edge.id);
        activeNodeIds.add(edge.source);
        activeNodeIds.add(edge.target);
      }
    }
  }

  const updatedNodes = nodes.map((n) => ({
    ...n,
    data: {
      ...(n.data as OntologyNodeData),
      emphasis: activeNodeIds.has(n.id) ? 'active' as const : 'faded' as const,
    },
  }));

  const updatedEdges = edges.map((edge) => {
    if (activeEdgeIds.has(edge.id)) {
      return {
        ...edge,
        zIndex: 10,
        style: { stroke: '#8778F7', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#8778F7', width: 16, height: 16 },
        labelStyle: { fontSize: 10, fill: '#6B5BD4', fontWeight: 600 },
      };
    }
    return {
      ...edge,
      zIndex: 0,
      style: { stroke: '#E5E7EB', strokeWidth: 0.75 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#E5E7EB', width: 10, height: 10 },
      labelStyle: { fontSize: 10, fill: '#D1D5DB' },
    };
  });

  return { nodes: updatedNodes, edges: updatedEdges };
}

// -- Canvas Flow --

function OntologyCanvasFlow({
  summary,
  onNodeClick,
  onEdgeClick: onEdgeClickProp,
  onNodeDoubleClick: onNodeDoubleClickProp,
  searchFilter,
}: {
  summary: { nodeTypes: SummaryNodeType[]; edgeTypes: SummaryEdgeType[]; propertyTypes: SummaryPropertyType[] };
  onNodeClick: (nodeId: string) => void;
  onEdgeClick: (edgeId: string) => void;
  onNodeDoubleClick?: (nodeId: string, category: string) => void;
  searchFilter?: string;
}) {
  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () => ontologyToFlowElements(summary.nodeTypes, summary.edgeTypes, summary.propertyTypes),
    [summary],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selection, setSelection] = useState<GraphSelection>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const rafRef = useRef<number>(0);
  const [expandedPairs, setExpandedPairs] = useState<Set<string>>(new Set());
  const { fitView } = useReactFlow();

  const bundledEdges = useMemo(
    () => bundleEdges(initialEdges, expandedPairs),
    [initialEdges, expandedPairs],
  );

  const onInit = useCallback(() => {
    setTimeout(() => fitView({ padding: 0.2 }), 50);
  }, [fitView]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelection({ type: 'node', id: node.id });
      setHoveredNodeId(null);
      onNodeClick(node.id);
    },
    [onNodeClick],
  );

  const handleEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      const edgeData = edge.data as OntologyEdgeData | undefined;
      if (edgeData?.isBundled) {
        const pairKey = edge.id.slice('bundle:'.length);
        setExpandedPairs((prev) => {
          const next = new Set(prev);
          next.add(pairKey);
          return next;
        });
        return;
      }
      setSelection((prev) => (prev?.type === 'edge' && prev.id === edge.id ? null : { type: 'edge', id: edge.id }));
      onEdgeClickProp(edge.id);
    },
    [onEdgeClickProp],
  );

  const handleNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const category = (node.data as OntologyNodeData).category;
      onNodeDoubleClickProp?.(node.id, category);
    },
    [onNodeDoubleClickProp],
  );

  const handlePaneClick = useCallback(() => {
    setSelection(null);
    setExpandedPairs(new Set());
  }, []);

  const handleNodeMouseEnter = useCallback(
    (_: React.MouseEvent, node: Node) => {
      hoveredRef.current = node.id;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        setHoveredNodeId(hoveredRef.current);
      });
    },
    [],
  );

  const handleNodeMouseLeave = useCallback(() => {
    hoveredRef.current = null;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setHoveredNodeId(hoveredRef.current);
    });
  }, []);

  const prevEmphasisRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const { nodes: updatedNodes, edges: updatedEdges } = applySelectionEmphasis(initialNodes, bundledEdges, selection, hoveredNodeId, searchFilter);

    // Only update nodes when emphasis actually changed to avoid re-render flicker at node edges
    const newEmphasis = new Map(updatedNodes.map((n) => [n.id, (n.data as OntologyNodeData).emphasis]));
    let nodesChanged = newEmphasis.size !== prevEmphasisRef.current.size;
    if (!nodesChanged) {
      for (const [id, emphasis] of newEmphasis) {
        if (prevEmphasisRef.current.get(id) !== emphasis) { nodesChanged = true; break; }
      }
    }
    if (nodesChanged) {
      prevEmphasisRef.current = newEmphasis;
      setNodes(updatedNodes);
    }

    setEdges(updatedEdges);
  }, [selection, hoveredNodeId, initialNodes, bundledEdges, setNodes, setEdges, searchFilter]);

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onInit={onInit}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
        onEdgeClick={handleEdgeClick}
        onPaneClick={handlePaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        nodesConnectable={false}
        connectOnClick={false}
        proOptions={{ hideAttribution: true }}
        style={{ background: '#FAFAFA' }}
        minZoom={0.3}
        maxZoom={2}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#E5E7EB" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </>
  );
}

// -- Main Graph Component --

export function OntologyGraph({
  onNodeClick,
  onEdgeClick,
  onNodeDoubleClick,
  searchFilter,
}: {
  onNodeClick: (nodeId: string) => void;
  onEdgeClick: (edgeId: string) => void;
  onNodeDoubleClick?: (nodeId: string, category: string) => void;
  searchFilter?: string;
}) {
  const { data: summary, isLoading } = trpc.views.knowledge.ontology.getOntologySummary.useQuery();

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative h-40 w-56">
            <div className="absolute left-1/2 top-0 h-10 w-28 -translate-x-1/2 animate-pulse rounded-lg border border-gray-100 bg-gray-50" />
            <div className="absolute bottom-0 left-0 h-10 w-24 animate-pulse rounded-lg border border-gray-100 bg-gray-50" style={{ animationDelay: '100ms' }} />
            <div className="absolute right-0 bottom-0 h-10 w-24 animate-pulse rounded-lg border border-gray-100 bg-gray-50" style={{ animationDelay: '200ms' }} />
            {/* Fake edges */}
            <div className="absolute left-1/2 top-10 h-16 w-px -translate-x-4 rotate-[25deg] bg-gray-100" />
            <div className="absolute left-1/2 top-10 h-16 w-px translate-x-3 -rotate-[25deg] bg-gray-100" />
          </div>
        </div>
      </div>
    );
  }

  if (!summary || summary.nodeTypes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 px-8">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gray-100">
          <svg className="h-6 w-6 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="5" r="2" />
            <circle cx="5" cy="19" r="2" />
            <circle cx="19" cy="19" r="2" />
            <line x1="12" y1="7" x2="5" y2="17" />
            <line x1="12" y1="7" x2="19" y2="17" />
          </svg>
        </div>
        <div className="text-center">
          <p className="text-[15px] font-medium text-gray-900">No ontology defined yet</p>
          <p className="mt-1 max-w-sm text-[13px] text-gray-500">
            Start from a template to quickly set up your knowledge model, or create node types and edges manually.
          </p>
        </div>
        <TemplateGallery />
      </div>
    );
  }

  const dataKey =
    summary.nodeTypes.map((nt) => nt.id).join(',') +
    '|' +
    summary.edgeTypes.map((et) => et.id).join(',') +
    '|' +
    summary.propertyTypes.map((pt) => pt.id).join(',');

  return (
    <ReactFlowProvider key={dataKey}>
      <OntologyCanvasFlow summary={summary} onNodeClick={onNodeClick} onEdgeClick={onEdgeClick} onNodeDoubleClick={onNodeDoubleClick} searchFilter={searchFilter} />
    </ReactFlowProvider>
  );
}
