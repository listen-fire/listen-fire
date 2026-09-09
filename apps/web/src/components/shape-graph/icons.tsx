// Inline SVG icons for the shape-graph property kinds. Kept inline
// (no lucide imports) so the icon vocabulary stays in one place
// and the file primitive gets a distinct visual affordance the
// editor can lean on per the wave-2 E5 file-mapping work.
//
// `formatPropertyType` lives in `./format.ts` (JSX-free) so the
// node-env jest runner can import it without dragging in the
// component tree. Re-exported here for convenience.

import type { ShapePropertyType } from './types';
export { formatPropertyType } from './format';

export const KIND_PALETTE: Record<
  ShapePropertyType['kind'],
  { accent: string; bg: string; text: string }
> = {
  string: { accent: 'bg-blue-400', bg: 'bg-blue-50', text: 'text-blue-700' },
  number: { accent: 'bg-emerald-400', bg: 'bg-emerald-50', text: 'text-emerald-700' },
  boolean: { accent: 'bg-amber-400', bg: 'bg-amber-50', text: 'text-amber-700' },
  date: { accent: 'bg-pink-400', bg: 'bg-pink-50', text: 'text-pink-700' },
  timestamp: { accent: 'bg-pink-400', bg: 'bg-pink-50', text: 'text-pink-700' },
  json: { accent: 'bg-gray-400', bg: 'bg-gray-50', text: 'text-gray-700' },
  file: { accent: 'bg-purple-400', bg: 'bg-purple-50', text: 'text-purple-700' },
  enum: { accent: 'bg-indigo-400', bg: 'bg-indigo-50', text: 'text-indigo-700' },
  list: { accent: 'bg-cyan-400', bg: 'bg-cyan-50', text: 'text-cyan-700' },
  record: { accent: 'bg-violet-400', bg: 'bg-violet-50', text: 'text-violet-700' },
};

export function KindIcon({
  kind,
  className,
}: {
  kind: ShapePropertyType['kind'];
  className?: string;
}) {
  const c = className ?? 'h-3.5 w-3.5';
  switch (kind) {
    case 'string':
      return (
        <svg viewBox="0 0 16 16" className={c} fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 4h10M5 4v8M11 4v8M3 12h4M9 12h4" strokeLinecap="round" />
        </svg>
      );
    case 'number':
      return (
        <svg viewBox="0 0 16 16" className={c} fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 6h10M3 10h10M6 3l-1 10M11 3l-1 10" strokeLinecap="round" />
        </svg>
      );
    case 'boolean':
      return (
        <svg viewBox="0 0 16 16" className={c} fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="5" width="12" height="6" rx="3" />
          <circle cx="10" cy="8" r="2" fill="currentColor" />
        </svg>
      );
    case 'date':
    case 'timestamp':
      return (
        <svg viewBox="0 0 16 16" className={c} fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="3" width="12" height="11" rx="1.5" />
          <path d="M5 2v3M11 2v3M2 7h12" strokeLinecap="round" />
        </svg>
      );
    case 'json':
      return (
        <svg viewBox="0 0 16 16" className={c} fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M5 3c-1.5 0-2 1-2 2v2c0 1-.5 1.5-1.5 1.5C2.5 8.5 3 9 3 10v2c0 1 .5 2 2 2M11 3c1.5 0 2 1 2 2v2c0 1 .5 1.5 1.5 1.5-1 0-1.5.5-1.5 1.5v2c0 1-.5 2-2 2" strokeLinecap="round" />
        </svg>
      );
    case 'file':
      return (
        <svg viewBox="0 0 16 16" className={c} fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 2h5l3 3v9H4z" strokeLinejoin="round" />
          <path d="M9 2v3h3" strokeLinejoin="round" />
        </svg>
      );
    case 'enum':
      return (
        <svg viewBox="0 0 16 16" className={c} fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="5" cy="5" r="1.5" />
          <circle cx="5" cy="11" r="1.5" />
          <path d="M8 5h6M8 11h6" strokeLinecap="round" />
        </svg>
      );
    case 'list':
      return (
        <svg viewBox="0 0 16 16" className={c} fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 4h10M3 8h10M3 12h10" strokeLinecap="round" />
        </svg>
      );
    case 'record':
      return (
        <svg viewBox="0 0 16 16" className={c} fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <path d="M2 7h12M6 3v10" strokeLinecap="round" />
        </svg>
      );
  }
}

