// Shape-graph primitive — public exports.
//
// See `types.ts` for the API contract + `ShapeEditor.tsx` for the
// top-level component. Force-layout + canvas + toolbar internals
// are intentionally not re-exported — consumers go through the
// top-level `<ShapeEditor>`.

export { ShapeEditor } from './ShapeEditor';
export { formatPropertyType } from './format';
export type {
  Shape,
  ShapePropertyType,
  ShapeEdge,
  ShapeConstraints,
  ShapeSelection,
  ShapeEditorProps,
  ShapeInspectorRenderer,
  ShapeInspectorRenderProps,
} from './types';
