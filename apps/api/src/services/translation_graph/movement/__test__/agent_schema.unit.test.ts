import type { InstanceSchema } from 'movement-lang';
import { normaliseSchemaForAgent } from '../agent_schema';

function fixture(): InstanceSchema {
  return {
    positions: {
      Company: {
        properties: { name: 'text' },
        edges: {
          // absent read/write ⇒ should be filled true
          people: { target: 'Person' },
          // explicit opt-outs ⇒ must be preserved verbatim
          attachments: { target: 'File', writable: false },
          replies: { target: 'Message', readable: false },
        },
      },
    },
    collections: { Companies: { target: 'Company' } },
    writableRoots: {
      Company: {
        fields: { name: 'text' },
        resultShape: { externalId: 'text' },
        edges: { owner: { target: 'Person' } },
      },
    },
    createShapes: {
      Message: {
        fields: { body: 'text' },
        resultShape: { externalId: 'text' },
        edges: { thread: { target: 'Thread' } },
      },
    },
  };
}

describe('normaliseSchemaForAgent', () => {
  it('fills absent edge read/write with explicit true across positions, roots, and createShapes', () => {
    const out = normaliseSchemaForAgent(fixture());

    expect(out.positions.Company.edges.people).toEqual({
      target: 'Person',
      readable: true,
      writable: true,
    });
    expect(out.writableRoots.Company.edges?.owner).toEqual({
      target: 'Person',
      readable: true,
      writable: true,
    });
    expect(out.createShapes?.Message.edges?.thread).toEqual({
      target: 'Thread',
      readable: true,
      writable: true,
    });
  });

  it('preserves explicit read-only / write-only opt-outs (fills only the missing side)', () => {
    const out = normaliseSchemaForAgent(fixture());

    // read-only edge: writable:false kept, readable filled true
    expect(out.positions.Company.edges.attachments).toEqual({
      target: 'File',
      writable: false,
      readable: true,
    });
    // write-only edge: readable:false kept, writable filled true
    expect(out.positions.Company.edges.replies).toEqual({
      target: 'Message',
      readable: false,
      writable: true,
    });
  });

  it('preserves sibling fields (properties, collections) untouched', () => {
    const out = normaliseSchemaForAgent(fixture());
    expect(out.positions.Company.properties).toEqual({ name: 'text' });
    expect(out.collections).toEqual({ Companies: { target: 'Company' } });
    expect(out.writableRoots.Company.fields).toEqual({ name: 'text' });
  });

  it('does NOT mutate the input (it is the shared TTL-cached checker object)', () => {
    const input = fixture();
    normaliseSchemaForAgent(input);
    // The cached object's edges keep the absent-⇒-true convention.
    expect(input.positions.Company.edges.people).toEqual({ target: 'Person' });
    expect('readable' in input.positions.Company.edges.people).toBe(false);
    expect(input.writableRoots.Company.edges?.owner).toEqual({ target: 'Person' });
  });

  it('omits createShapes when the input has none', () => {
    const input = fixture();
    delete input.createShapes;
    const out = normaliseSchemaForAgent(input);
    expect('createShapes' in out).toBe(false);
  });
});
