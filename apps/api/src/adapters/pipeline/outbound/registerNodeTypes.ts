import { registerAttioNodeTypes } from '../../attio/nodes';
import { registerAffinityNodeTypes } from '../../affinity/nodes';
import { registerAirtableNodeTypes } from '../../airtable/nodes';
import { registerGDriveNodeTypes } from '../../google/nodes';
import { registerGoogleSheetsNodeTypes } from '../../googleSheets/nodes';
import { registerSlackNodeTypes } from '../../slack/nodeTypes';
import { registerWebhookNodeTypes } from '../../webhook/nodes';
import { registerDropboxNodeTypes } from '../../dropbox/nodes';

let registered = false;

export function registerAllNodeTypes(): void {
  if (registered) return;

  registerAttioNodeTypes();
  registerAffinityNodeTypes();
  registerAirtableNodeTypes();
  registerGDriveNodeTypes();
  registerGoogleSheetsNodeTypes();
  registerSlackNodeTypes();
  registerWebhookNodeTypes();
  registerDropboxNodeTypes();

  registered = true;
}
