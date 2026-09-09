// The demo graph's shape, without a database: the fixture is a fixed list, and
// the writer asks for the ontology's own type ids rather than inventing any.

import { DEMO_COMPANIES, demoPropertyWrites } from '../demo_graph';

describe('the demo knowledge fixture', () => {
  it('is a handful of companies, not a load test', () => {
    expect(DEMO_COMPANIES.length).toBeGreaterThanOrEqual(3);
    expect(DEMO_COMPANIES.length).toBeLessThanOrEqual(8);
    expect(new Set(DEMO_COMPANIES).size).toBe(DEMO_COMPANIES.length);
  });

  it('writes the name onto the ontology’s own Name property', () => {
    const writes = demoPropertyWrites('prop-name', 'Northwind Robotics');
    expect(writes).toEqual([{ propertyTypeId: 'prop-name', value: 'Northwind Robotics' }]);
  });
});
