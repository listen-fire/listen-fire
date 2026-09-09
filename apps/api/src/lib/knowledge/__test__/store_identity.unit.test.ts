import { projectUniqueness } from '../store/identity';

// The stored ontology shape is an OR-of-AND of expression entries. T2 made the
// TG path speak the flat `{ any: [{ all: [{ field, fuzzy? }] }] }` currency;
// edge support (this change) re-adds edge-traversal projection.
describe('projectUniqueness', () => {
  it('projects property entries to their property_type_id', () => {
    const stored = [
      [{ expr: { type: 'property', propertyTypeId: 'prop-name' }, fuzzy: true }],
    ];
    expect(projectUniqueness(stored)).toEqual({
      any: [{ all: [{ field: 'prop-name', fuzzy: true }] }],
    });
  });

  it('projects a single-step edge traversal to its edge_type_id', () => {
    const stored = [
      [{ expr: { type: 'traverse', steps: [{ type: 'edge', edgeTypeId: 'edge-round' }] } }],
    ];
    expect(projectUniqueness(stored)).toEqual({
      any: [{ all: [{ field: 'edge-round' }] }],
    });
  });

  it('keeps a mixed property + edge AND-group (compound identity)', () => {
    const stored = [
      [
        { expr: { type: 'property', propertyTypeId: 'prop-name' } },
        { expr: { type: 'traverse', steps: [{ type: 'edge', edgeTypeId: 'edge-round' }] } },
      ],
    ];
    expect(projectUniqueness(stored)).toEqual({
      any: [{ all: [{ field: 'prop-name' }, { field: 'edge-round' }] }],
    });
  });

  it('drops edge_to / within / multi-step entries it cannot search', () => {
    const stored = [
      [
        { kind: 'edge_to', ancestorName: 'round' },
        { expr: { type: 'property', propertyTypeId: 'prop-name' } },
        {
          expr: {
            type: 'traverse',
            steps: [
              { type: 'edge', edgeTypeId: 'edge-a' },
              { type: 'edge', edgeTypeId: 'edge-b' },
            ],
          },
        },
      ],
    ];
    // Only the plain property survives; edge_to and the 2-hop traverse drop.
    expect(projectUniqueness(stored)).toEqual({
      any: [{ all: [{ field: 'prop-name' }] }],
    });
  });

  it('returns empty for non-array / absent input', () => {
    expect(projectUniqueness(null)).toEqual({ any: [] });
    expect(projectUniqueness(undefined)).toEqual({ any: [] });
  });
});
