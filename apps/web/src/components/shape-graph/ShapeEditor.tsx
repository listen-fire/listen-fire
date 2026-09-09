'use client';

// Top-level shape-graph primitive. Frames the canvas + toolbar + a
// sidebar inspector frame whose body comes from the consumer's
// `renderInspector` render-prop.
//
// The primitive owns: selection state, canvas layout, toolbar
// affordances. The consumer owns: the underlying `Shape` (and
// constraint annotations when relevant), the inspector body.

import { useState } from 'react';
import { ShapeCanvas } from './canvas';
import { ShapeToolbar } from './toolbar';
import type {
  Shape,
  ShapeConstraints,
  ShapeEditorProps,
  ShapeSelection,
} from './types';

export function ShapeEditor({
  shape,
  onChange,
  constraints,
  onConstraintsChange,
  renderInspector,
  heading,
  subheading,
}: ShapeEditorProps) {
  const [selection, setSelection] = useState<ShapeSelection>({ kind: 'none' });

  const safeConstraints: ShapeConstraints = constraints ?? {};
  const noopConstraints = () => {
    /* consumer didn't pass a writer — constraints are read-only */
  };

  // Defensive: if the consumer drops the selected property/edge
  // out from under us (e.g. via undo), reset selection.
  const selectionStillValid =
    selection.kind === 'none' ||
    (selection.kind === 'property' && shape.properties[selection.name] !== undefined) ||
    (selection.kind === 'edge' && shape.edges[selection.name] !== undefined) ||
    (selection.kind === 'edge-target-field' && shape.edges[selection.edgeName] !== undefined);
  const effectiveSelection: ShapeSelection = selectionStillValid
    ? selection
    : { kind: 'none' };
  if (!selectionStillValid) {
    // Selection's referent went away — reconcile state without an
    // explicit useEffect. The next render uses `none`; the
    // microtask batches the update so we don't loop.
    queueMicrotask(() => setSelection({ kind: 'none' }));
  }

  return (
    <div className="flex h-full flex-col">
      {(heading || subheading) && (
        <div className="border-b border-gray-100 bg-white px-4 py-2.5">
          {heading && (
            <p className="text-[13px] font-semibold text-gray-800">{heading}</p>
          )}
          {subheading && (
            <p className="mt-0.5 text-[11px] text-gray-500">{subheading}</p>
          )}
        </div>
      )}
      <ShapeToolbar
        shape={shape}
        selection={effectiveSelection}
        applyShape={onChange}
        onSelectionChange={setSelection}
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex-1 min-w-0">
          <ShapeCanvas
            shape={shape}
            selection={effectiveSelection}
            heading={heading ?? 'Shape'}
            onSelectionChange={setSelection}
          />
        </div>
        <aside className="w-[320px] shrink-0 overflow-y-auto border-l border-gray-200 bg-white">
          <div className="p-3">
            {renderInspector({
              shape,
              selection: effectiveSelection,
              constraints: safeConstraints,
              applyShape: onChange,
              applyConstraints: onConstraintsChange ?? noopConstraints,
            })}
          </div>
        </aside>
      </div>
    </div>
  );
}
