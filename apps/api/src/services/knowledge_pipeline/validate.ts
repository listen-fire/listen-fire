import type { ExtractedSubgraph, Changeset, ApplyResult } from './types';

interface ValidationResult {
  pass: boolean;
  message: string;
}

function validateExtraction(subgraph: ExtractedSubgraph): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Every edge references valid source and target nodes
  const nodeIds = new Set(subgraph.nodes.map((n) => n.tempId));
  nodeIds.add(subgraph.messageNode.tempId);

  for (const edge of subgraph.edges) {
    if (!nodeIds.has(edge.sourceTempId)) {
      results.push({
        pass: false,
        message: `Orphan edge: source ${edge.sourceTempId} not found in nodes`,
      });
    }
    if (!nodeIds.has(edge.targetTempId)) {
      results.push({
        pass: false,
        message: `Orphan edge: target ${edge.targetTempId} not found in nodes`,
      });
    }
  }

  // Every property references a valid parent node
  for (const prop of subgraph.properties) {
    if (!nodeIds.has(prop.parentTempId)) {
      results.push({
        pass: false,
        message: `Orphan property ${prop.tempId}: parent ${prop.parentTempId} not found in nodes`,
      });
    }
  }

  // No duplicate nodes (same nodeType + same identity property values)
  const identityKeys = new Map<string, string>();
  for (const node of subgraph.nodes) {
    const identityProps = subgraph.properties
      .filter((p) => p.parentTempId === node.tempId)
      .map((p) => `${p.propertyTypeId}:${p.value}`)
      .sort()
      .join('|');
    const key = `${node.nodeType}::${identityProps}`;
    const existing = identityKeys.get(key);
    if (existing && identityProps) {
      results.push({
        pass: false,
        message: `Duplicate node: ${node.tempId} and ${existing} have same type and identity properties`,
      });
    } else {
      identityKeys.set(key, node.tempId);
    }
  }

  // Every evidence references a valid property
  const propIds = new Set(subgraph.properties.map((p) => p.tempId));
  for (const ev of subgraph.evidence) {
    if (!propIds.has(ev.targetPropertyTempId)) {
      results.push({
        pass: false,
        message: `Orphan evidence: target property ${ev.targetPropertyTempId} not found`,
      });
    }
  }

  if (results.length === 0) {
    results.push({ pass: true, message: `Extraction valid: ${subgraph.nodes.length} nodes, ${subgraph.edges.length} edges, ${subgraph.properties.length} properties` });
  }

  return results;
}

function validateConsolidation(changeset: Changeset): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Every node has a resolution
  for (const node of changeset.nodes) {
    if (!node.resolution) {
      results.push({
        pass: false,
        message: `Node ${node.tempId} has no resolution decision`,
      });
    }
  }

  // No conflicting matches — two nodes of the same type shouldn't match to the same existing node
  const matchMap = new Map<string, string[]>();
  for (const node of changeset.nodes) {
    if (node.resolution.action === 'match') {
      const key = `${node.nodeType}::${node.resolution.existingNodeId}`;
      const existing = matchMap.get(key) ?? [];
      existing.push(node.tempId);
      matchMap.set(key, existing);
    }
  }
  for (const [key, tempIds] of matchMap) {
    if (tempIds.length > 1) {
      results.push({
        pass: false,
        message: `Conflicting match: nodes ${tempIds.join(', ')} all matched to ${key}`,
      });
    }
  }

  // Edge references valid nodes in changeset
  const nodeIds = new Set(changeset.nodes.map((n) => n.tempId));
  nodeIds.add(changeset.messageNode.tempId);
  for (const edge of changeset.edges) {
    if (!nodeIds.has(edge.sourceTempId)) {
      results.push({ pass: false, message: `Orphan edge in changeset: source ${edge.sourceTempId} not in nodes` });
    }
    if (!nodeIds.has(edge.targetTempId)) {
      results.push({ pass: false, message: `Orphan edge in changeset: target ${edge.targetTempId} not in nodes` });
    }
  }

  if (results.length === 0) {
    const created = changeset.nodes.filter((n) => n.resolution.action === 'create').length;
    const matched = changeset.nodes.filter((n) => n.resolution.action === 'match').length;
    results.push({ pass: true, message: `Consolidation valid: ${created} created, ${matched} matched` });
  }

  return results;
}

function validateApply(result: ApplyResult, changeset: Changeset): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Message node is created separately but also appears in changeset.nodes (skipped in the loop).
  // nodesCreated = 1 (message) + creates that aren't the message node.
  const nonMessageCreates = changeset.nodes.filter(
    (n) => n.resolution.action === 'create' && n.tempId !== changeset.messageNode.tempId,
  ).length;
  const expectedCreated = nonMessageCreates + 1; // +1 for message node
  const expectedMatched = changeset.nodes.filter((n) => n.resolution.action === 'match').length;

  if (result.nodesCreated.length !== expectedCreated) {
    results.push({
      pass: false,
      message: `Created count mismatch: expected ${expectedCreated}, got ${result.nodesCreated.length}`,
    });
  }

  if (result.nodesUpdated.length !== expectedMatched) {
    results.push({
      pass: false,
      message: `Updated count mismatch: expected ${expectedMatched}, got ${result.nodesUpdated.length}`,
    });
  }

  // Every changeset node should have a real ID mapping
  for (const node of changeset.nodes) {
    if (!result.tempToRealId.has(node.tempId)) {
      results.push({
        pass: false,
        message: `Node ${node.tempId} has no real ID mapping after apply`,
      });
    }
  }

  if (results.length === 0) {
    results.push({ pass: true, message: `Apply valid: ${result.nodesCreated.length} created, ${result.nodesUpdated.length} updated` });
  }

  return results;
}

function formatValidationResults(phase: string, results: ValidationResult[]): string {
  const lines = [`[${phase}]`];
  for (const r of results) {
    lines.push(`  ${r.pass ? 'PASS' : 'FAIL'}: ${r.message}`);
  }
  return lines.join('\n');
}

export { validateExtraction, validateConsolidation, validateApply, formatValidationResults };
export type { ValidationResult };
