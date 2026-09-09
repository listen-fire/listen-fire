'use client';

// Shape-graph canvas — ReactFlow + d3-force, parameterised over a
// generic `Shape`. Renders one node per property and one node per
// edge (the edge node represents the record destination); selection
// state lifts to the consumer through `onSelectionChange`.
//
// Force-layout helpers and geometry come from `force-layout.ts`,
// distilled from the ontology editor's graph at
// `apps/web/src/components/ontology/graph.tsx`. The custom edge
// component is generic — same rectangle-clipping + parallel-curve
// offset pattern, no ontology-specific bundling.

import { useCallback, useMemo, useEffect } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useInternalNode,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { clipLineToRect, layoutShapeGraph } from './force-layout';
import { KIND_PALETTE, KindIcon, formatPropertyType } from './icons';
import type { Shape, ShapeSelection } from './types';

const NODE_WIDTH = 200;
const NODE_HEIGHT = 56;

// ── Node data + custom node component ──

type ShapeNodeData = {
  label: string;
  /** What this node represents on the underlying shape. */
  role: 'property' | 'edge';
  /** For property nodes: the property's kind (used for icon + colour).
   *  For edge nodes: the kind of the edge's `target` ExpressionType. */
  kind: import('./types').ShapePropertyType['kind'];
  /** Short sub-label — e.g. `list<record>`, `enum(3)` — derived
   *  from the property type. */
  typeLabel: string;
  /** True when the node corresponds to the current selection. */
  isSelected: boolean;
};

function ShapeNodeComponent({ data }: NodeProps<Node<ShapeNodeData>>) {
  const palette = KIND_PALETTE[data.kind];
  return (
    <div
      className={`flex overflow-hidden rounded-lg border bg-white cursor-pointer transition-[box-shadow,border-color] duration-200
        ${data.isSelected ? 'border-gray-800 shadow-md ring-1 ring-black/5' : 'border-gray-200 shadow-sm hover:shadow-md hover:border-gray-300'}`}
      style={{ minWidth: NODE_WIDTH }}
    >
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ width: 0, height: 0, background: 'transparent', border: 'none', opacity: 0, pointerEvents: 'none' }}
      />
      <div className={`w-1 shrink-0 ${palette.accent}`} />
      <div className="flex flex-1 items-center gap-2.5 px-3 py-2.5">
        <span className={`${palette.text}`}>
          <KindIcon kind={data.kind} />
        </span>
        <span className="flex flex-1 flex-col">
          <span className="truncate text-[13px] font-medium text-gray-800">
            {data.label}
          </span>
          <span className="truncate text-[10px] text-gray-400">
            {data.role === 'edge' ? `→ ${data.typeLabel}` : data.typeLabel}
          </span>
        </span>
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

// Root marker: a small pill rendered at the shape origin so users
// have a visual anchor connecting properties + edges back to the
// shape they're authoring.
function ShapeRootNodeComponent({ data }: NodeProps<Node<{ heading: string }>>) {
  return (
    <div
      className="flex items-center gap-2 rounded-full border border-gray-300 bg-white px-3 py-1.5 shadow-sm"
      style={{ minWidth: 80 }}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} style={{ width: 0, height: 0, opacity: 0, pointerEvents: 'none' }} />
      <span className="text-[11px] font-medium text-gray-700">{data.heading}</span>
      <Handle type="source" position={Position.Bottom} isConnectable={false} style={{ width: 0, height: 0, opacity: 0, pointerEvents: 'none' }} />
    </div>
  );
}

// ── Custom edge component ──

type ShapeEdgeData = { curveOffset?: number };

function ShapeEdgeComponent(props: EdgeProps) {
  const { id, source, target, markerEnd, style, data, label, labelStyle } = props;
  const edgeData = data as ShapeEdgeData | undefined;
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

  return (
    <g className="react-flow__edge-interaction">
      <path d={path} fill="none" stroke="transparent" strokeWidth={20} style={{ cursor: 'pointer' }} />
      <path id={id} d={path} fill="none" markerEnd={markerEnd as string} style={{ ...style, pointerEvents: 'none' }} />
      {label ? (
        <>
          <rect
            x={labelX - 32}
            y={labelY - 8}
            width={64}
            height={16}
            fill="white"
            fillOpacity={0.92}
            rx={3}
            style={{ pointerEvents: 'none' }}
          />
          <text
            x={labelX}
            y={labelY}
            textAnchor="middle"
            dominantBaseline="central"
            style={{ ...(labelStyle as React.CSSProperties), pointerEvents: 'none' }}
          >
            {label}
          </text>
        </>
      ) : null}
    </g>
  );
}

const nodeTypes = {
  shapeNode: ShapeNodeComponent,
  shapeRoot: ShapeRootNodeComponent,
};
const edgeTypes = { shapeEdge: ShapeEdgeComponent };

// ── Shape → ReactFlow elements ──

const ROOT_ID = '__shape_root__';

function shapeToFlowElements(
  shape: Shape,
  selection: ShapeSelection,
  heading: string,
): { nodes: Node[]; edges: Edge[] } {
  const propertyEntries = Object.entries(shape.properties);
  const edgeEntries = Object.entries(shape.edges);

  const rootNode: Node = {
    id: ROOT_ID,
    type: 'shapeRoot',
    position: { x: 0, y: 0 },
    data: { heading } as Record<string, unknown>,
  };

  const propertyNodes: Node[] = propertyEntries.map(([name, type]) => ({
    id: `prop:${name}`,
    type: 'shapeNode',
    position: { x: 0, y: 0 },
    data: {
      label: name,
      role: 'property',
      kind: type.kind,
      typeLabel: formatPropertyType(type),
      isSelected: selection.kind === 'property' && selection.name === name,
    } as ShapeNodeData,
  }));

  const edgeNodes: Node[] = edgeEntries.map(([name, edge]) => ({
    id: `edge:${name}`,
    type: 'shapeNode',
    position: { x: 0, y: 0 },
    data: {
      label: name,
      role: 'edge',
      kind: edge.target.kind,
      typeLabel: formatPropertyType(edge.target),
      isSelected: selection.kind === 'edge' && selection.name === name,
    } as ShapeNodeData,
  }));

  const nodes = [rootNode, ...propertyNodes, ...edgeNodes];

  const flowEdges: Edge[] = [
    ...propertyEntries.map(([name], i) => {
      const offset = (i - (propertyEntries.length - 1) / 2) * 4;
      return {
        id: `e-prop:${name}`,
        source: ROOT_ID,
        target: `prop:${name}`,
        type: 'shapeEdge',
        markerEnd: { type: MarkerType.ArrowClosed, color: '#D4DBE5', width: 12, height: 12 },
        style: { stroke: '#D4DBE5', strokeWidth: 1 },
        data: { curveOffset: offset } satisfies ShapeEdgeData,
      } as Edge;
    }),
    ...edgeEntries.map(([name], i) => {
      const offset = (i - (edgeEntries.length - 1) / 2) * 4;
      return {
        id: `e-edge:${name}`,
        source: ROOT_ID,
        target: `edge:${name}`,
        type: 'shapeEdge',
        label: name,
        labelStyle: { fontSize: 10, fill: '#475569', fontWeight: 500 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#94A3B8', width: 14, height: 14 },
        style: { stroke: '#94A3B8', strokeWidth: 1.25 },
        data: { curveOffset: offset } satisfies ShapeEdgeData,
      } as Edge;
    }),
  ];

  const positions = layoutShapeGraph(
    nodes.map((n) => ({ id: n.id })),
    flowEdges.map((e) => ({ source: e.source, target: e.target })),
    { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT },
  );
  const positionById = new Map(positions.map((p) => [p.id, p.position]));
  const positioned = nodes.map((n) => ({
    ...n,
    position: positionById.get(n.id) ?? n.position,
  }));

  return { nodes: positioned, edges: flowEdges };
}

// ── Public canvas ──

export interface ShapeCanvasProps {
  shape: Shape;
  selection: ShapeSelection;
  heading: string;
  onSelectionChange: (next: ShapeSelection) => void;
}

function ShapeCanvasInner({
  shape,
  selection,
  heading,
  onSelectionChange,
}: ShapeCanvasProps) {
  // Layout key — recompute positions when the structural shape
  // changes (property/edge add/remove/rename/type-change). We use
  // the entry-key set rather than deep-equality on the values so
  // simple type tweaks within a property don't reshuffle the
  // canvas.
  const layoutKey = useMemo(
    () =>
      Object.keys(shape.properties).join(',') +
      '|' +
      Object.keys(shape.edges).join(','),
    [shape.properties, shape.edges],
  );

  const elements = useMemo(
    () => shapeToFlowElements(shape, selection, heading),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- layoutKey covers structural changes
    [layoutKey, selection, heading],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(elements.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(elements.edges);
  const { fitView } = useReactFlow();

  // Hydrate when the structural shape changes — preserve positions
  // through small edits (selection only) so the canvas doesn't
  // jitter every keystroke.
  useEffect(() => {
    setNodes(elements.nodes);
    setEdges(elements.edges);
  }, [elements, setNodes, setEdges]);

  const handleInit = useCallback(() => {
    setTimeout(() => fitView({ padding: 0.2 }), 50);
  }, [fitView]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.id === ROOT_ID) {
        onSelectionChange({ kind: 'none' });
        return;
      }
      if (node.id.startsWith('prop:')) {
        onSelectionChange({ kind: 'property', name: node.id.slice('prop:'.length) });
        return;
      }
      if (node.id.startsWith('edge:')) {
        onSelectionChange({ kind: 'edge', name: node.id.slice('edge:'.length) });
        return;
      }
    },
    [onSelectionChange],
  );

  const handlePaneClick = useCallback(() => {
    onSelectionChange({ kind: 'none' });
  }, [onSelectionChange]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onInit={handleInit}
      onNodeClick={handleNodeClick}
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
  );
}

export function ShapeCanvas(props: ShapeCanvasProps) {
  // Provider keyed by structural identity — same pattern the
  // ontology graph uses to make sure ReactFlow remounts cleanly
  // when the underlying shape's identity changes (e.g. a
  // saved-then-reloaded shape).
  const providerKey = useMemo(
    () =>
      Object.keys(props.shape.properties).join(',') +
      '|' +
      Object.keys(props.shape.edges).join(','),
    [props.shape.properties, props.shape.edges],
  );
  return (
    <ReactFlowProvider key={providerKey}>
      <ShapeCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
