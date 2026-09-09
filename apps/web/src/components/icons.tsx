const defaultClass = 'h-4 w-4';

type IconProps = { className?: string };

export function OntologyIcon({ className = defaultClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="5" r="3" />
      <circle cx="5" cy="19" r="3" />
      <circle cx="19" cy="19" r="3" />
      <path d="M10.5 7.5L7 16.5" />
      <path d="M13.5 7.5L17 16.5" />
    </svg>
  );
}

export function InputsIcon({ className = defaultClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v14" />
      <path d="M5 10l7 7 7-7" />
      <path d="M5 21h14" />
    </svg>
  );
}

export function OutputsIcon({ className = defaultClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 21V7" />
      <path d="M5 14l7-7 7 7" />
      <path d="M5 3h14" />
    </svg>
  );
}

export function PluginsIcon({ className = defaultClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2v5" />
      <path d="M15 2v5" />
      <rect x="5" y="7" width="14" height="5" rx="1.5" />
      <path d="M7 12v2a5 5 0 0 0 10 0v-2" />
      <path d="M12 19v3" />
    </svg>
  );
}

export function IntegrationsIcon({ className = defaultClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 12h12" />
      <path d="M12 6v12" />
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

export function MessageIcon({ className = defaultClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  );
}

export function ObjectIcon({ className = defaultClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M3 9h18" />
      <path d="M9 3v18" />
    </svg>
  );
}

/**
 * The product mark from public/logo.svg, in its native 200×200
 * coordinate space — the two monogram letters as filled outlines, since
 * every surface here fills rather than strokes. The mark is fattened by
 * an 8-unit stroke wherever it renders. Shared by the static
 * AssistantIcon below and the launcher's MorphingAssistantIcon.
 */
export const LISTEN_FIRE_MARK_PATHS = {
  letterL: "M 40,40 L 60,40 L 60,140 L 96,140 L 96,160 L 40,160 Z",
  letterF: "M 102,40 L 160,40 L 160,60 L 122,60 L 122,160 L 102,160 Z",
  letterFBar: "M 102,90 L 150,90 L 150,110 L 102,110 Z",
} as const;

/**
 * The assistant's identity: the bare product mark from public/logo.svg, filled with
 * currentColor — the launcher's morph established that the mark IS the
 * assistant, so the static surfaces show the same mark at rest.
 */
export function AssistantIcon({ className = defaultClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <g
        transform="translate(-1 -0.74) scale(0.13)"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="8"
        strokeLinejoin="miter"
        strokeLinecap="butt"
      >
        <path d={LISTEN_FIRE_MARK_PATHS.letterL} />
        <path d={LISTEN_FIRE_MARK_PATHS.letterF} />
        <path d={LISTEN_FIRE_MARK_PATHS.letterFBar} />
      </g>
    </svg>
  );
}

export function ApiExplorerIcon({ className = defaultClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

export function LibraryIcon({ className = defaultClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

export function SignOutIcon({ className = defaultClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}
