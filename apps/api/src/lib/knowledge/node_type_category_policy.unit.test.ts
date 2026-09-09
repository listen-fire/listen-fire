import { unsupportedCategoryReason } from './node_type_category_policy';

describe('unsupportedCategoryReason', () => {
  it('allows object (the only creatable kind)', () => {
    expect(unsupportedCategoryReason('object')).toBeNull();
  });

  it('rejects message as deprecated, with a jargon-free reason', () => {
    const reason = unsupportedCategoryReason('message');
    expect(reason).toBeTruthy();
    // No internal jargon leaks to the user-facing reason.
    expect(reason).not.toMatch(/node[_ ]?type|message[_ ]?node|category|extraction graph/i);
  });

  it('rejects scoped_object as deprecated, with a jargon-free reason', () => {
    const reason = unsupportedCategoryReason('scoped_object');
    expect(reason).toBeTruthy();
    expect(reason).not.toMatch(/scoped_object|node[_ ]?type|category/i);
  });

  it('rejects any unknown category', () => {
    expect(unsupportedCategoryReason('widget')).toBeTruthy();
  });
});
