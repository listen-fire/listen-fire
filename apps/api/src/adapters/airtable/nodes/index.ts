import { register as registerRecord, AIRTABLE_RECORD_NODE_TYPE } from './record';

export { AirtableFieldConfiguration } from './shared';
export { AirtableRecordConfig, AIRTABLE_RECORD_NODE_TYPE } from './record';

export const AIRTABLE_NODE_TYPES = {
  RECORD: AIRTABLE_RECORD_NODE_TYPE,
} as const;

export function registerAirtableNodeTypes(): void {
  registerRecord();
}
