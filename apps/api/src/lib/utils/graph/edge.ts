import { DataMapType, EdgeIndex, HEdge } from './types';

function ensureIndex<DataMap extends DataMapType>(
  index: EdgeIndex<DataMap>,
  path: [string, string],
) {
  if (!index.has(path[0])) {
    index.set(path[0], new Map());
  }

  const value = index.get(path[0])!;

  if (!value.has(path[1])) {
    value.set(path[1], new Map());
  }

  return value.get(path[1])!;
}

function setIndex<DataMap extends DataMapType>(
  index: EdgeIndex<DataMap>,
  [source, target, edgeId]: [string, string, string],
  edge: HEdge<DataMap, keyof DataMap['edge'] & string>,
) {
  return ensureIndex(index, [source, target]).set(edgeId, edge);
}

export { setIndex };
