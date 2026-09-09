import { Graph } from '../index';

type NodeTypeA = { id: string; name: string; age: number };
type NodeTypeB = { id: string; value: number };
type EdgeType = { id: string; description: string };

type Schema = {
  node: {
    A: NodeTypeA;
    B: NodeTypeB;
  };
  edge: {
    'A-B': EdgeType;
  };
  meta: Record<string, unknown>;
};

describe('Graph', () => {
  let graph: Graph<Schema>;

  beforeEach(() => {
    graph = new Graph({
      generateIndices: (node, modelName) =>
        modelName === 'A' ? [`${(node as NodeTypeA).age}`, (node as NodeTypeA).name] : [],
      merge: (modelName, target, others) => {
        if (modelName === 'A') {
          return {
            ...(target as NodeTypeA),
            name: (others as NodeTypeA[]).map((o) => o.name).join(', '),
          } as Schema['node'][typeof modelName];
        }
        return target;
      },
      mergeEdges: (_modelName, target) => {
        return target;
      },
      sortNodes: () => 0,
    });
  });

  it('should add and retrieve nodes of different types', () => {
    const nodeA: NodeTypeA = { id: '1', name: 'NodeA', age: 42 };
    const nodeB: NodeTypeB = { id: '2', value: 42 };

    const addedNodeA = graph.addNode(nodeA, 'A', {});
    const addedNodeB = graph.addNode(nodeB, 'B', {});

    expect(graph.idIndex.get('1')).toBe(addedNodeA);
    expect(graph.idIndex.get('2')).toBe(addedNodeB);
  });

  it('should add and retrieve edges between nodes', () => {
    const nodeA: NodeTypeA = { id: '1', name: 'NodeA', age: 42 };
    const nodeB: NodeTypeB = { id: '2', value: 42 };
    const addedNodeA = graph.addNode(nodeA, 'A', {});
    const addedNodeB = graph.addNode(nodeB, 'B', {});

    const edge: EdgeType = { id: 'edge1', description: 'A to B' };
    graph.addEdge({
      id: edge.id,
      type: 'Edge',
      modelName: 'A-B',
      from: addedNodeA.id,
      to: addedNodeB.id,
      data: edge,
      isSymmetric: false,
    });

    const fromIndex = graph.fromIndex.get('1');
    const toIndex = graph.toIndex.get('2');

    expect(fromIndex?.get('2')?.get('edge1')).toBeDefined();
    expect(toIndex?.get('1')?.get('edge1')).toBeDefined();
  });

  it('should update node ids', () => {
    const nodeA: NodeTypeA = { id: '1', name: 'NodeA', age: 42 };
    const nodeB: NodeTypeB = { id: '2', value: 42 };

    const addedNodeA = graph.addNode(nodeA, 'A', {});
    const addedNodeB = graph.addNode(nodeB, 'B', {});

    const edge: EdgeType = { id: 'edge1', description: 'A to B' };
    graph.addEdge({
      id: edge.id,
      type: 'Edge',
      modelName: 'A-B',
      from: addedNodeA.id,
      to: addedNodeB.id,
      data: edge,
      isSymmetric: false,
    });

    graph.updateId('1', 'newId1');
    graph.updateId('2', 'newId2');

    expect(graph.idIndex.get('newId1')).toBe(addedNodeA);
    expect(graph.idIndex.get('newId2')).toBe(addedNodeB);

    expect(graph.fromIndex.get('newId1')?.get('newId2')?.get('edge1')).toBeDefined();
    expect(graph.toIndex.get('newId2')?.get('newId1')?.get('edge1')).toBeDefined();

    expect(graph.fromIndex.get('1')).toBeUndefined();
    expect(graph.toIndex.get('2')).toBeUndefined();
  });

  it('should merge nodes that match indices', () => {
    const nodeA1: NodeTypeA = { id: '1', name: 'NodeA', age: 42 };
    const nodeA2: NodeTypeA = { id: '2', name: 'NodeB', age: 34 };
    const nodeB: NodeTypeB = { id: 'Z', value: 42 };

    const addedNodeA1 = graph.addNode(nodeA1, 'A', {});
    const addedNodeA2 = graph.addNode(nodeA2, 'A', {});
    const addedNodeB = graph.addNode(nodeB, 'B', {});

    graph.addEdge({
      id: 'edge1',
      type: 'Edge',
      modelName: 'A-B',
      from: addedNodeA2.id,
      to: addedNodeB.id,
      data: { id: 'edge1', description: 'A to B' },
      isSymmetric: false,
    });

    const addedNodeC = graph.addNode({ id: '3', name: 'NodeB', age: 42 }, 'A', {});

    // this should have merged them all into one
    expect(graph.idIndex.get('1')).toBe(addedNodeA1);
    expect(addedNodeC).toBe(addedNodeA1);
    expect(graph.idIndex.get('2')).toBeUndefined();
    expect(graph.idIndex.get('3')).toBeUndefined();
    expect(graph.nodes.length).toBe(2);

    expect(graph.fromIndex.get('1')?.get('Z')?.get('edge1')).toBeDefined();
    expect(graph.toIndex.get('Z')?.get('1')?.get('edge1')).toBeDefined();
    expect(graph.fromIndex.get('1')?.get('Z')?.get('edge1')?.to).toBe(addedNodeB.id);
    expect(graph.fromIndex.get('1')?.get('Z')?.get('edge1')?.from).toBe(addedNodeA1.id);
    expect([...graph.idIndex.keys()].join(',')).toBe('1,Z,edge1');
    expect(graph.fromIndex.size).toBe(1);
    expect(graph.toIndex.size).toBe(1);
  });
});
