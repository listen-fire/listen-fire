// Editor-action derivation — unit tests for the activity-layer mapping (V2).
//
// These exercise the pure projection (`tool_call` args → EditorAction[])
// with no MQ involvement, via the `__test__` export. They are the
// acceptance gate for the name-keyed editor-action vocabulary.

import { __test__ } from '../editor_actions';

const { deriveFromToolCall, actionsForPlanOp } = __test__;

describe('actionsForPlanOp', () => {
  it('maps a field-write op to focusNode + editField with the finished value', () => {
    const actions = actionsForPlanOp({
      kind: 'writeExpression',
      args: { nodePath: 'Companies > People', fieldName: 'Email', formula: '`From`' },
    });
    expect(actions).toEqual([
      { type: 'focusNode', nodeName: 'Companies > People' },
      { type: 'editField', nodeName: 'Companies > People', fieldName: 'Email', value: '`From`' },
    ]);
  });

  it('maps addFieldMapping to focusNode + editField with a null value (no value yet)', () => {
    const actions = actionsForPlanOp({
      kind: 'addFieldMapping',
      args: { nodePath: 'Companies', fieldName: 'Domain' },
    });
    expect(actions).toEqual([
      { type: 'focusNode', nodeName: 'Companies' },
      { type: 'editField', nodeName: 'Companies', fieldName: 'Domain', value: null },
    ]);
  });

  it('maps a root-action op to a focusNode on the target type name', () => {
    const actions = actionsForPlanOp({
      kind: 'addRootAction',
      args: { targetTypeName: 'Companies' },
    });
    expect(actions).toEqual([{ type: 'focusNode', nodeName: 'Companies' }]);
  });

  it('maps node-shaping ops (setAdapterConfig) to a focusNode only', () => {
    const actions = actionsForPlanOp({
      kind: 'setAdapterConfig',
      args: { nodePath: 'Deals' },
    });
    expect(actions).toEqual([{ type: 'focusNode', nodeName: 'Deals' }]);
  });

  it('emits nothing for an unrecognised op kind', () => {
    expect(actionsForPlanOp({ kind: 'somethingNew', args: {} })).toEqual([]);
  });
});

describe('deriveFromToolCall', () => {
  it('fans out an executePlan batch into per-op editor-actions', () => {
    const actions = deriveFromToolCall({
      operations: [
        { kind: 'addRootAction', args: { targetTypeName: 'Companies' } },
        { kind: 'writeExpression', args: { nodePath: 'Companies', fieldName: 'Name', formula: '`Subject`' } },
      ],
    });
    expect(actions).toEqual([
      { type: 'focusNode', nodeName: 'Companies' },
      { type: 'focusNode', nodeName: 'Companies' },
      { type: 'editField', nodeName: 'Companies', fieldName: 'Name', value: '`Subject`' },
    ]);
  });

  it('maps chooseCredential to a bindCredential action', () => {
    expect(deriveFromToolCall({ name: 'My Attio', role: 'target' })).toEqual([
      { type: 'bindCredential', role: 'target', name: 'My Attio' },
    ]);
  });

  it('ignores a credential call with an unknown role', () => {
    expect(deriveFromToolCall({ name: 'X', role: 'sideways' })).toEqual([]);
  });

  it('maps a completions result carrying options to showCompletions', () => {
    expect(
      deriveFromToolCall({ nodePath: 'Companies', options: ['Name', 'Domain', 'AI('] }),
    ).toEqual([
      { type: 'showCompletions', nodeName: 'Companies', fieldName: null, options: ['Name', 'Domain', 'AI('] },
    ]);
  });

  it('emits nothing for a bare introspection call (no options, no plan, no cred)', () => {
    expect(deriveFromToolCall({ nodePath: 'Companies' })).toEqual([]);
  });

  it('emits nothing for undefined args', () => {
    expect(deriveFromToolCall(undefined)).toEqual([]);
  });
});
