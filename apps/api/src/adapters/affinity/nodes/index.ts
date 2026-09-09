import { register as registerOrganization, AFFINITY_ORGANIZATION_NODE_TYPE } from './organization';
import { register as registerPerson, AFFINITY_PERSON_NODE_TYPE } from './person';
import { register as registerListEntry, AFFINITY_LIST_ENTRY_NODE_TYPE } from './listEntry';
import { register as registerNote, AFFINITY_NOTE_NODE_TYPE } from './note';
import { register as registerFile, AFFINITY_FILE_NODE_TYPE } from './file';
import { register as registerPreview, AFFINITY_PREVIEW_NODE_TYPE } from './preview';

export { AffinityFieldConfiguration } from './shared';
export { AffinityOrganizationConfig, AFFINITY_ORGANIZATION_NODE_TYPE } from './organization';
export { AffinityPersonConfig, AFFINITY_PERSON_NODE_TYPE } from './person';
export { AffinityListEntryConfig, AFFINITY_LIST_ENTRY_NODE_TYPE } from './listEntry';
export { AffinityNoteConfig, AFFINITY_NOTE_NODE_TYPE } from './note';
export { AffinityFileConfig, AFFINITY_FILE_NODE_TYPE } from './file';
export { AffinityPreviewConfig, AFFINITY_PREVIEW_NODE_TYPE } from './preview';

export const AFFINITY_NODE_TYPES = {
  ORGANIZATION: AFFINITY_ORGANIZATION_NODE_TYPE,
  PERSON: AFFINITY_PERSON_NODE_TYPE,
  LIST_ENTRY: AFFINITY_LIST_ENTRY_NODE_TYPE,
  NOTE: AFFINITY_NOTE_NODE_TYPE,
  FILE: AFFINITY_FILE_NODE_TYPE,
  PREVIEW: AFFINITY_PREVIEW_NODE_TYPE,
} as const;

export function registerAffinityNodeTypes(): void {
  registerNote();
  registerFile();
  registerPreview();
  registerListEntry({ note: AFFINITY_NOTE_NODE_TYPE });
  registerPerson({ listEntry: AFFINITY_LIST_ENTRY_NODE_TYPE, note: AFFINITY_NOTE_NODE_TYPE, preview: AFFINITY_PREVIEW_NODE_TYPE });
  registerOrganization({
    person: AFFINITY_PERSON_NODE_TYPE,
    listEntry: AFFINITY_LIST_ENTRY_NODE_TYPE,
    note: AFFINITY_NOTE_NODE_TYPE,
    file: AFFINITY_FILE_NODE_TYPE,
    preview: AFFINITY_PREVIEW_NODE_TYPE,
  });
}
