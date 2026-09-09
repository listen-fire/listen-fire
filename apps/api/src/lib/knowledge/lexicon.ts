export interface LexiconEntry {
  /** The thing being named. */
  concept: string;
  /** What to call it in user/agent-facing prose. */
  userFacing: string;
  /** Literal system vocabulary both consumers must use verbatim (e.g.
   *  EXTRACT_VALUE); never softened. */
  loadBearing?: boolean;
  /** Internal shorthand that must NOT appear in prose. */
  avoid?: string[];
}

export const LEXICON: LexiconEntry[] = [
  { concept: 'translation graph', userFacing: 'Translation', avoid: ['TG'] },
  { concept: 'knowledge graph', userFacing: 'knowledge graph', avoid: ['KG'] },
  { concept: 'schema reference', userFacing: "the source's / target's shape", avoid: ['schemaRef', 'schema_ref'] },
  { concept: 'extract value', userFacing: 'EXTRACT_VALUE', loadBearing: true },
  { concept: 'extract traversal', userFacing: '#extract', loadBearing: true },
  { concept: 'AI expression', userFacing: 'AI()', loadBearing: true },
];
