import { notNull, notUndefined } from '../nullability';
import { setIndex } from './edge';
import {
  DataMapType,
  deserialiseObject,
  EdgeIndex,
  EdgeSubIndex,
  HEdge,
  HNode,
  HObject,
  serialiseObject,
} from './types';

// NEW PLAN
// An in-memory graph database
// unique id for each node but with a preconfigured data schema
// different types of edges between each node
class Graph<DataMap extends DataMapType> {
  idIndex: Map<string, HObject<DataMap>> = new Map();
  identifierIndex: Map<string, HNode<DataMap>> = new Map();
  fromIndex: EdgeIndex<DataMap> = new Map();
  toIndex: EdgeIndex<DataMap> = new Map();
  symmetricIndex: EdgeIndex<DataMap> = new Map();

  generateIndices: <T extends keyof DataMap['node'] & string>(
    node: DataMap['node'][T],
    modelName: T,
  ) => string[];
  merge: <T extends keyof DataMap['node'] & string>(
    modelName: T,
    target: DataMap['node'][T],
    others: DataMap['node'][T][],
  ) => DataMap['node'][T];
  mergeEdges: <T extends keyof DataMap['edge'] & string>(
    modelName: T,
    target: DataMap['edge'][T],
    others: DataMap['edge'][T][],
  ) => DataMap['edge'][T];
  sortNodes: (a: HNode<DataMap>, b: HNode<DataMap>) => number;
  constructor({
    generateIndices,
    merge,
    mergeEdges,
    sortNodes,
  }: {
    generateIndices: <T extends keyof DataMap['node'] & string>(
      node: DataMap['node'][T],
      modelName: T,
    ) => string[];
    merge: <T extends keyof DataMap['node'] & string>(
      modelName: T,
      target: DataMap['node'][T],
      others: DataMap['node'][T][],
    ) => DataMap['node'][T];
    mergeEdges: <T extends keyof DataMap['edge'] & string>(
      modelName: T,
      target: DataMap['edge'][T],
      others: DataMap['edge'][T][],
    ) => DataMap['edge'][T];
    sortNodes: (a: HNode<DataMap>, b: HNode<DataMap>) => number;
  }) {
    this.generateIndices = generateIndices;
    this.merge = merge;
    this.mergeEdges = mergeEdges;
    this.sortNodes = sortNodes;
  }

  addEdgeToIndex(
    index: EdgeIndex<DataMap>,
    [source, target, edgeId]: [string, string, string],
    edge: HEdge<DataMap>,
  ) {
    const existing = [...(index.get(source)?.get(target)?.values() ?? [])].find(
      (e) => e.modelName === edge.modelName,
    );
    if (existing) {
      existing.data = this.merge(edge.modelName, existing.data, [edge.data]);
      return;
    }

    return setIndex(index, [source, target, edgeId], edge);
  }

  addEdge(edge: HEdge<DataMap>) {
    this.idIndex.set(edge.id, edge);
    if (edge.isSymmetric) {
      this.addEdgeToIndex(this.symmetricIndex, [edge.from, edge.to, edge.id], edge);
      this.addEdgeToIndex(this.symmetricIndex, [edge.to, edge.from, edge.id], edge);
    } else {
      this.addEdgeToIndex(this.fromIndex, [edge.from, edge.to, edge.id], edge);
      this.addEdgeToIndex(this.toIndex, [edge.to, edge.from, edge.id], edge);
    }
  }

  addNode<T extends keyof DataMap['node'] & string>(
    data: DataMap['node'][T],
    modelName: T,
    meta: DataMap['meta'],
    indicesOverride?: string[],
  ): HNode<DataMap, T> {
    const indices = indicesOverride ?? this.generateIndices(data, modelName);
    const node: HNode<DataMap, T> = {
      id: data.id,
      modelName,
      type: 'Node',
      data,
      meta,
      indices: new Set(indices),
    };

    const existing = indices
      .reduce(
        (acc, index) => {
          const existing = this.identifierIndex.get(index);
          if (existing && existing.modelName === modelName) {
            acc.push(existing as HNode<DataMap, T>);
          }
          return acc;
        },
        [] as HNode<DataMap, T>[],
      )
      .sort((a, b) => this.sortNodes(a, b));

    const canonExisting = existing.find(notUndefined) ?? null;

    if (!canonExisting) {
      this.idIndex.set(node.id, node);
      for (const index of indices) {
        this.identifierIndex.set(index, node);
      }
      return node;
    }

    const others = existing.filter((n) => n !== canonExisting);
    canonExisting.data = this.merge(modelName, canonExisting.data, [
      node.data,
      ...others.map((n) => n.data),
    ]);

    for (const index of [...indices, ...others.flatMap((n) => [...n.indices])]) {
      this.identifierIndex.set(index, canonExisting);
      canonExisting.indices.add(index);
    }

    // merge any edges
    for (const toRemove of others) {
      for (const edges of this.fromIndex.get(toRemove.id)?.values() ?? []) {
        for (const edge of edges.values()) {
          edge.from = canonExisting.id;
          this.addEdge(edge);
        }
      }

      for (const edges of this.toIndex.get(toRemove.id)?.values() ?? []) {
        for (const edge of edges.values()) {
          edge.to = canonExisting.id;
          this.addEdge(edge);
        }
      }

      for (const edges of this.symmetricIndex.get(toRemove.id)?.values() ?? []) {
        for (const edge of edges.values()) {
          if (toRemove.id === edge.from) {
            edge.from = canonExisting.id;
          } else {
            edge.to = canonExisting.id;
          }

          this.addEdge(edge);
        }
      }

      this.removeNode(toRemove);
    }

    return canonExisting;
  }

  removeAllEdgesForNodeInIndex(
    nodeId: string,
    { index, oppositeIndex }: { index: EdgeIndex<DataMap>; oppositeIndex: EdgeIndex<DataMap> },
  ) {
    // edges are stored in both directions in the indexes
    // so to remove an edge, we need to remove it from both
    const edge = index.get(nodeId);
    if (edge) {
      for (const relatedId of edge.keys()) {
        oppositeIndex.get(relatedId)?.delete(nodeId);
      }

      // this removes _all_ edges indexed under the node ID
      index.delete(nodeId);
    }
  }

  removeAllEdgesForNode(nodeId: string) {
    this.removeAllEdgesForNodeInIndex(nodeId, {
      index: this.fromIndex,
      oppositeIndex: this.toIndex,
    });
    this.removeAllEdgesForNodeInIndex(nodeId, {
      index: this.toIndex,
      oppositeIndex: this.fromIndex,
    });
    this.removeAllEdgesForNodeInIndex(nodeId, {
      index: this.symmetricIndex,
      oppositeIndex: this.symmetricIndex,
    });
  }

  removeNode(node: HNode<DataMap>) {
    this.removeAllEdgesForNode(node.id);

    this.idIndex.delete(node.id);
  }

  *[Symbol.iterator]() {
    for (const node of this.idIndex.values()) {
      yield node;
    }
  }

  getEdgesById(id: string): EdgeSubIndex<DataMap> {
    if (typeof id === 'symbol') {
      throw new Error('Cannot get symbol');
    }

    const from = this.fromIndex.get(id)?.entries() ?? [];
    const to = this.toIndex.get(id)?.entries() ?? [];
    const symmetrical = this.symmetricIndex.get(id)?.entries() ?? [];
    const all = [...from, ...to, ...symmetrical];
    const a: EdgeIndex<DataMap> = new Map();
    for (const [otherNodeId, edges] of all) {
      for (const [edgeId, edge] of edges.entries()) {
        setIndex(a, [id, otherNodeId, edgeId], edge);
      }
    }

    return a.get(id) ?? new Map();
  }

  *getNodes(): IterableIterator<HNode<DataMap>> {
    for (const node of this.idIndex.values()) {
      if (node.type !== 'Node') {
        continue;
      }
      yield node;
    }
  }

  get nodes() {
    return [...this.getNodes()];
  }

  *getEdges(): IterableIterator<HEdge<DataMap>> {
    for (const edge of this.idIndex.values()) {
      if (edge.type !== 'Edge') {
        continue;
      }
      yield edge;
    }
  }

  get edges() {
    return [...this.getEdges()];
  }

  replaceIdInIndex<M extends Map<string, unknown>>(oldId: string, newId: string, index: M) {
    const value = index.get(oldId) as M extends Map<string, infer T> ? T | undefined : never;
    if (value) {
      index.delete(oldId);
      index.set(newId, value);
    }

    return value;
  }

  updateId(oldId: string, newId: string) {
    const node = this.replaceIdInIndex(oldId, newId, this.idIndex);
    if (!node) {
      return;
    }

    node.id = newId;

    // update edges
    const from = this.replaceIdInIndex(oldId, newId, this.fromIndex);
    if (from) {
      from.forEach((edges, relatedId) => {
        const opposite = this.toIndex.get(relatedId);
        if (opposite) {
          this.replaceIdInIndex(oldId, newId, opposite);
        }

        edges.forEach((edge) => {
          edge.from = newId;
        });
      });
    }

    const to = this.replaceIdInIndex(oldId, newId, this.toIndex);
    if (to) {
      to.forEach((edges, relatedId) => {
        const opposite = this.fromIndex.get(relatedId);
        if (opposite) {
          this.replaceIdInIndex(oldId, newId, opposite);
        }

        edges.forEach((edge) => {
          edge.to = newId;
        });
      });
    }

    const symmetric = this.replaceIdInIndex(oldId, newId, this.symmetricIndex);
    if (symmetric) {
      symmetric.forEach((edges) => {
        edges.forEach((edge) => {
          if (edge.from === oldId) {
            edge.from = newId;
          } else if (edge.to === oldId) {
            edge.to = newId;
          }
        });
      });
    }

    return node;
  }

  serialise() {
    return {
      __object: 'Graph',
      data: [...this.idIndex.values()].map(serialiseObject),
    };
  }

  deserialise(serialised: string) {
    const object = JSON.parse(serialised);
    if (object.__object !== 'Graph') {
      throw new Error('Could not deserialise: expected graph');
    }

    const array = object.data;
    if (!Array.isArray(array)) {
      throw new Error('Could not deserialise: expected array');
    }

    for (const uncheckedObject of array) {
      const object = deserialiseObject<DataMap>(uncheckedObject);

      if (object.type === 'Node') {
        this.addNode(object.data, object.modelName, object.meta, [...object.indices]);
      } else if (object.type === 'Edge') {
        this.addEdge(object);
      }
    }

    return this;
  }

  indexValues(index: EdgeIndex<DataMap>, id: string) {
    return [...(index.get(id)?.values() ?? [])];
  }

  allIndexEdges(index: EdgeIndex<DataMap>, id: string) {
    return [...(index.get(id)?.values() ?? [])].flatMap((v) => [...v.values()]);
  }

  getConnectedNodesById<
    EdgeModelName extends keyof DataMap['edge'] & string = keyof DataMap['edge'] & string,
    NodeModelName extends keyof DataMap['node'] & string = keyof DataMap['node'] & string,
  >(
    id: string,
    {
      edgeModelName,
      nodeModelName,
    }: { edgeModelName?: EdgeModelName; nodeModelName?: NodeModelName },
  ): {
    edge: HEdge<DataMap, EdgeModelName>;
    otherNode: HNode<DataMap, NodeModelName>;
  }[] {
    const fromValues = this.allIndexEdges(this.fromIndex, id);
    const toValues = this.allIndexEdges(this.toIndex, id);
    const symmetricValues = this.allIndexEdges(this.symmetricIndex, id);

    return [...fromValues, ...toValues, ...symmetricValues]
      .filter((edge): edge is HEdge<DataMap, EdgeModelName> =>
        edgeModelName ? edge.modelName === edgeModelName : true,
      )
      .map((edge) => {
        const otherId = edge.from === id ? edge.to : edge.from; // this should still handle self-referencing edges
        const otherNode = this.idIndex.get(otherId);
        if (
          otherNode?.type !== 'Node' ||
          (nodeModelName && otherNode.modelName !== nodeModelName)
        ) {
          return null;
        }
        return {
          edge,
          otherNode: otherNode as HNode<DataMap, NodeModelName>,
        };
      })
      .filter(notNull);
  }
}

export { Graph, HNode };
