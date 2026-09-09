'use client';

// Shape-graph toolbar — add property / add edge + per-selection
// rename + delete. The toolbar is a thin operator on the
// `Shape` object; the consumer's `applyShape` callback receives
// the new shape on every edit.

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { Shape, ShapePropertyType, ShapeSelection } from './types';
import { KIND_PALETTE } from './icons';

const PROPERTY_KINDS: ShapePropertyType['kind'][] = [
  'string',
  'number',
  'boolean',
  'date',
  'timestamp',
  'json',
  'file',
  'enum',
  'list',
  'record',
];

function defaultPropertyType(kind: ShapePropertyType['kind']): ShapePropertyType {
  switch (kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'date':
    case 'timestamp':
    case 'json':
    case 'file':
      return { kind };
    case 'enum':
      return { kind: 'enum', values: [] };
    case 'list':
      return { kind: 'list', element: { kind: 'string' } };
    case 'record':
      return { kind: 'record', fields: {} };
  }
}

export interface ShapeToolbarProps {
  shape: Shape;
  selection: ShapeSelection;
  applyShape: (next: Shape) => void;
  onSelectionChange: (next: ShapeSelection) => void;
}

const inputClass =
  'rounded-md border border-gray-200 px-2 py-1 text-[12px] focus:border-gray-400 focus:outline-none';

export function ShapeToolbar({
  shape,
  selection,
  applyShape,
  onSelectionChange,
}: ShapeToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 bg-white px-3 py-2">
      <AddPropertyControl shape={shape} applyShape={applyShape} onSelectionChange={onSelectionChange} />
      <AddEdgeControl shape={shape} applyShape={applyShape} onSelectionChange={onSelectionChange} />
      <div className="flex-1" />
      {selection.kind === 'property' && (
        <SelectionActionsProperty
          shape={shape}
          name={selection.name}
          applyShape={applyShape}
          onSelectionChange={onSelectionChange}
        />
      )}
      {selection.kind === 'edge' && (
        <SelectionActionsEdge
          shape={shape}
          name={selection.name}
          applyShape={applyShape}
          onSelectionChange={onSelectionChange}
        />
      )}
    </div>
  );
}

function AddPropertyControl({
  shape,
  applyShape,
  onSelectionChange,
}: {
  shape: Shape;
  applyShape: (next: Shape) => void;
  onSelectionChange: (next: ShapeSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ShapePropertyType['kind']>('string');

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 rounded-md bg-gray-900 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-gray-800"
      >
        <Plus className="h-3 w-3" /> Add property
      </button>
    );
  }
  const exists = shape.properties[name] !== undefined;
  const valid = !!name && !exists;
  return (
    <div className="flex items-center gap-1.5">
      <input
        autoFocus
        className={`${inputClass} max-w-[140px]`}
        placeholder="property name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <select
        className={inputClass}
        value={kind}
        onChange={(e) => setKind(e.target.value as ShapePropertyType['kind'])}
      >
        {PROPERTY_KINDS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!valid}
        onClick={() => {
          applyShape({
            ...shape,
            properties: { ...shape.properties, [name]: defaultPropertyType(kind) },
          });
          onSelectionChange({ kind: 'property', name });
          setName('');
          setKind('string');
          setOpen(false);
        }}
        className="rounded-md bg-gray-900 px-2 py-1 text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        Add
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setName('');
        }}
        className="text-[11px] text-gray-500 hover:text-gray-700"
      >
        Cancel
      </button>
    </div>
  );
}

function AddEdgeControl({
  shape,
  applyShape,
  onSelectionChange,
}: {
  shape: Shape;
  applyShape: (next: Shape) => void;
  onSelectionChange: (next: ShapeSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [cardinality, setCardinality] = useState<'one' | 'many'>('one');

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50"
      >
        <Plus className="h-3 w-3" /> Add link
      </button>
    );
  }
  const exists = shape.edges[name] !== undefined;
  const valid = !!name && !exists;
  return (
    <div className="flex items-center gap-1.5">
      <input
        autoFocus
        className={`${inputClass} max-w-[140px]`}
        placeholder="link name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <select
        className={inputClass}
        value={cardinality}
        onChange={(e) => setCardinality(e.target.value as 'one' | 'many')}
      >
        <option value="one">single</option>
        <option value="many">many</option>
      </select>
      <button
        type="button"
        disabled={!valid}
        onClick={() => {
          const recordTarget: ShapePropertyType = { kind: 'record', fields: {} };
          const target: ShapePropertyType =
            cardinality === 'one'
              ? recordTarget
              : { kind: 'list', element: recordTarget };
          applyShape({
            ...shape,
            edges: { ...shape.edges, [name]: { target } },
          });
          onSelectionChange({ kind: 'edge', name });
          setName('');
          setCardinality('one');
          setOpen(false);
        }}
        className="rounded-md bg-gray-900 px-2 py-1 text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        Add
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setName('');
        }}
        className="text-[11px] text-gray-500 hover:text-gray-700"
      >
        Cancel
      </button>
    </div>
  );
}

function SelectionActionsProperty({
  shape,
  name,
  applyShape,
  onSelectionChange,
}: {
  shape: Shape;
  name: string;
  applyShape: (next: Shape) => void;
  onSelectionChange: (next: ShapeSelection) => void;
}) {
  const palette = KIND_PALETTE[shape.properties[name]?.kind ?? 'string'];
  return (
    <div className="flex items-center gap-1.5">
      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${palette.bg} ${palette.text}`}>
        property
      </span>
      <RenameInput
        value={name}
        rename={(to) => {
          if (!to || to === name || shape.properties[to] !== undefined) return;
          const { [name]: cur, ...rest } = shape.properties;
          applyShape({ ...shape, properties: { ...rest, [to]: cur } });
          onSelectionChange({ kind: 'property', name: to });
        }}
      />
      <button
        type="button"
        onClick={() => {
          const { [name]: _drop, ...rest } = shape.properties;
          applyShape({ ...shape, properties: rest });
          onSelectionChange({ kind: 'none' });
        }}
        className="flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-[11px] text-gray-500 hover:border-red-300 hover:text-red-600"
        title="Remove property"
      >
        <Trash2 className="h-3 w-3" /> Remove
      </button>
    </div>
  );
}

function SelectionActionsEdge({
  shape,
  name,
  applyShape,
  onSelectionChange,
}: {
  shape: Shape;
  name: string;
  applyShape: (next: Shape) => void;
  onSelectionChange: (next: ShapeSelection) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">
        link
      </span>
      <RenameInput
        value={name}
        rename={(to) => {
          if (!to || to === name || shape.edges[to] !== undefined) return;
          const { [name]: cur, ...rest } = shape.edges;
          applyShape({ ...shape, edges: { ...rest, [to]: cur } });
          onSelectionChange({ kind: 'edge', name: to });
        }}
      />
      <button
        type="button"
        onClick={() => {
          const { [name]: _drop, ...rest } = shape.edges;
          applyShape({ ...shape, edges: rest });
          onSelectionChange({ kind: 'none' });
        }}
        className="flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-[11px] text-gray-500 hover:border-red-300 hover:text-red-600"
        title="Remove link"
      >
        <Trash2 className="h-3 w-3" /> Remove
      </button>
    </div>
  );
}

function RenameInput({
  value,
  rename,
}: {
  value: string;
  rename: (to: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Sync external value changes (e.g. selection updated by canvas
  // click) into the draft.
  if (draft !== value && document.activeElement?.tagName !== 'INPUT') {
    setDraft(value);
  }
  return (
    <input
      className={`${inputClass} max-w-[160px]`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => rename(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
