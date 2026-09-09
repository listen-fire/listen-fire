// `node.summary` — the derived text an agent reads, composed by the store that
// owns every fact in it.
//
// This is doc 6 §0b's earmark, finally payable. The summariser used to live on
// the automations side and reach BACKWARDS across the carve line, because half
// of what it composes — excerpts of the source material a node was extracted
// from — sat in `public.resource` → `public.raw_text`. D43(a) settled that by
// persisting the excerpt on `node_resource` when the link is made, so
// everything the summary quotes is now knowledge's own row, and the last
// backwards read on the write path is gone.
//
// The text format is UNCHANGED and that is deliberate: `v.summary` is an
// exposed meta field, so an already-linked node must regenerate to the same
// string it had. The only difference is where the quoted text is read from.
//
// One thing did get pinned rather than moved: the resource order. The old query
// had no ORDER BY, so a node with several sources composed its summary in
// whatever order the planner returned — stable in practice, guaranteed by
// nothing. It is ordered by link time here.

import type { KnowledgeWriteDb } from './write';
import type { NodeId } from '../../../generated/kysely/knowledge/Node';

/** A node as the summariser sees it: its type, its properties, and the source
 *  text its links quote. */
interface SummarisableNode {
  id: NodeId;
  nodeTypeName: string;
  properties: Array<[string, unknown]>;
  excerpts: string[];
}

export function serializeNodeAsText(node: SummarisableNode): string {
  const lines = [`## ${node.nodeTypeName}`];
  for (const [key, value] of node.properties) {
    if (value != null) lines.push(`${key}: ${value}`);
  }
  if (node.excerpts.length > 0) {
    lines.push('');
    lines.push('### Source Material');
    for (const text of node.excerpts) lines.push(text);
  }
  return lines.join('\n');
}

async function loadSummarisable(
  db: KnowledgeWriteDb,
  input: { teamId: string; nodeIds: NodeId[] },
): Promise<SummarisableNode[]> {
  const nodes = await db
    .selectFrom('node')
    .innerJoin('node_type', 'node_type.id', 'node.node_type_id')
    .where('node.id', 'in', input.nodeIds)
    .where('node.team_id', '=', input.teamId)
    .select(['node.id', 'node_type.name as node_type_name'])
    .execute();
  if (!nodes.length) return [];

  const nodeIds = nodes.map((n) => n.id);

  // NODE-anchored properties only. `property.node_id` is nullable because a
  // property can hang off an EDGE instead, and an edge's property is a fact
  // about a relationship rather than about either end — it was never in the
  // summary and must not become part of it.
  const properties = await db
    .selectFrom('property')
    .innerJoin('property_type', 'property_type.id', 'property.property_type_id')
    .where('property.node_id', 'in', nodeIds)
    .where('property.node_id', 'is not', null)
    .where('property.team_id', '=', input.teamId)
    .select([
      'property.node_id',
      'property_type.name',
      'property.value_text',
      'property.value_number',
      'property.value_boolean',
    ])
    .execute();

  const excerptRows = await db
    .selectFrom('node_resource')
    .where('node_resource.node_id', 'in', nodeIds)
    .where('node_resource.team_id', '=', input.teamId)
    .where('node_resource.excerpt', 'is not', null)
    .orderBy('node_resource.created_at', 'asc')
    .orderBy('node_resource.id', 'asc')
    .select(['node_resource.node_id', 'node_resource.excerpt'])
    .execute();

  const propsByNode = new Map<string, Array<[string, unknown]>>();
  for (const p of properties) {
    if (p.node_id === null) continue;
    const list = propsByNode.get(p.node_id) ?? [];
    list.push([p.name, p.value_text ?? p.value_number ?? p.value_boolean]);
    propsByNode.set(p.node_id, list);
  }

  const excerptsByNode = new Map<string, string[]>();
  for (const row of excerptRows) {
    // An empty or whitespace-only excerpt contributes nothing but a blank line,
    // which is why the old loader skipped it too.
    if (!row.excerpt || !row.excerpt.trim()) continue;
    const list = excerptsByNode.get(row.node_id) ?? [];
    list.push(row.excerpt);
    excerptsByNode.set(row.node_id, list);
  }

  return nodes.map((n) => ({
    id: n.id,
    nodeTypeName: n.node_type_name,
    properties: propsByNode.get(n.id) ?? [],
    excerpts: excerptsByNode.get(n.id) ?? [],
  }));
}

/**
 * Regenerate `node.summary` for each given node. Idempotent — a re-run
 * overwrites, so it is safe to call after every write that could have changed
 * what a node says about itself.
 */
export async function summarizeNodes(
  db: KnowledgeWriteDb,
  input: { teamId: string; nodeIds: NodeId[] },
): Promise<void> {
  if (!input.nodeIds.length) return;
  for (const node of await loadSummarisable(db, input)) {
    await db
      .updateTable('node')
      .set({ summary: serializeNodeAsText(node) })
      .where('node.id', '=', node.id)
      .execute();
  }
}

export type { SummarisableNode };
