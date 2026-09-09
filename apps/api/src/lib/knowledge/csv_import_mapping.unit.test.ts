import { rowsToCollectedNodes } from './csv_import_mapping';

describe('rowsToCollectedNodes', () => {
  it('maps only the mapped columns to properties, one node per row', () => {
    const nodes = rowsToCollectedNodes({
      rows: [
        { Company: 'Acme', Rev: '100', Ignore: 'x' },
        { Company: 'Beta', Rev: '200', Ignore: 'y' },
      ],
      typeName: 'Company',
      mapping: { Company: 'Name', Rev: 'Revenue' },
    });
    expect(nodes).toEqual([
      { id: 'row-0', type: 'Company', properties: { Name: 'Acme', Revenue: '100' } },
      { id: 'row-1', type: 'Company', properties: { Name: 'Beta', Revenue: '200' } },
    ]);
  });

  it('skips empty cells so they do not overwrite existing values on re-import', () => {
    const nodes = rowsToCollectedNodes({
      rows: [{ Company: 'Acme', Rev: '' }],
      typeName: 'Company',
      mapping: { Company: 'Name', Rev: 'Revenue' },
    });
    expect(nodes).toEqual([{ id: 'row-0', type: 'Company', properties: { Name: 'Acme' } }]);
  });
});
