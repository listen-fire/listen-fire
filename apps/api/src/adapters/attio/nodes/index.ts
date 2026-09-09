import { register as registerObject, ATTIO_OBJECT_NODE_TYPE } from './object';
import { register as registerListEntry, ATTIO_LIST_ENTRY_NODE_TYPE } from './listEntry';
import { register as registerNote, ATTIO_NOTE_NODE_TYPE } from './note';
import { register as registerTask, ATTIO_TASK_NODE_TYPE } from './task';
import { register as registerUpload, ATTIO_UPLOAD_NODE_TYPE } from './upload';

export { AttioFieldConfiguration } from './shared';
export { AttioObjectConfig, ATTIO_OBJECT_NODE_TYPE, objectConfigSchema } from './object';
export {
  AttioListEntryConfig,
  ATTIO_LIST_ENTRY_NODE_TYPE,
  listEntryConfigSchema,
} from './listEntry';
export { AttioNoteConfig, ATTIO_NOTE_NODE_TYPE, noteConfigSchema } from './note';
export { AttioTaskConfig, ATTIO_TASK_NODE_TYPE, taskConfigSchema } from './task';
export { AttioUploadConfig, ATTIO_UPLOAD_NODE_TYPE, uploadConfigSchema } from './upload';

export const ATTIO_NODE_TYPES = {
  OBJECT: ATTIO_OBJECT_NODE_TYPE,
  LIST_ENTRY: ATTIO_LIST_ENTRY_NODE_TYPE,
  NOTE: ATTIO_NOTE_NODE_TYPE,
  TASK: ATTIO_TASK_NODE_TYPE,
  UPLOAD: ATTIO_UPLOAD_NODE_TYPE,
} as const;

type AttioNodeTypeId = (typeof ATTIO_NODE_TYPES)[keyof typeof ATTIO_NODE_TYPES];
type ExtractActionType<T extends string> = T extends `attio:${infer Action}` ? Action : never;
export type AttioActionType = ExtractActionType<AttioNodeTypeId>;

const ATTIO_ACTION_TYPES = Object.values(ATTIO_NODE_TYPES).map(
  (id) => id.split(':')[1],
) as AttioActionType[];

export function isAttioActionType(value: string): value is AttioActionType {
  return ATTIO_ACTION_TYPES.includes(value as AttioActionType);
}

export function registerAttioNodeTypes(): void {
  registerObject({
    listEntry: ATTIO_LIST_ENTRY_NODE_TYPE,
    note: ATTIO_NOTE_NODE_TYPE,
    task: ATTIO_TASK_NODE_TYPE,
    upload: ATTIO_UPLOAD_NODE_TYPE,
  });
  registerListEntry({
    note: ATTIO_NOTE_NODE_TYPE,
    task: ATTIO_TASK_NODE_TYPE,
    upload: ATTIO_UPLOAD_NODE_TYPE,
  });
  registerNote();
  registerTask();
  registerUpload();
}
