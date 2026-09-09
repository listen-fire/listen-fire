import { register as registerObject, WEBHOOK_OBJECT_NODE_TYPE } from './object';
import { register as registerArray, WEBHOOK_ARRAY_NODE_TYPE } from './array';

export {
  WebhookObjectConfig,
  WEBHOOK_OBJECT_NODE_TYPE,
  objectConfigSchema,
  ObjectField,
  objectFieldSchema,
} from './object';
export { WebhookArrayConfig, WEBHOOK_ARRAY_NODE_TYPE, arrayConfigSchema } from './array';

export const WEBHOOK_NODE_TYPES = {
  OBJECT: WEBHOOK_OBJECT_NODE_TYPE,
  ARRAY: WEBHOOK_ARRAY_NODE_TYPE,
} as const;

type WebhookNodeTypeId = (typeof WEBHOOK_NODE_TYPES)[keyof typeof WEBHOOK_NODE_TYPES];
type ExtractActionType<T extends string> = T extends `webhook:${infer Action}` ? Action : never;
export type WebhookActionType = ExtractActionType<WebhookNodeTypeId>;

const WEBHOOK_ACTION_TYPES = Object.values(WEBHOOK_NODE_TYPES).map(
  (id) => id.split(':')[1],
) as WebhookActionType[];

export function isWebhookActionType(value: string): value is WebhookActionType {
  return WEBHOOK_ACTION_TYPES.includes(value as WebhookActionType);
}

export function registerWebhookNodeTypes(): void {
  registerObject({
    object: WEBHOOK_OBJECT_NODE_TYPE,
    array: WEBHOOK_ARRAY_NODE_TYPE,
  });
  registerArray({
    object: WEBHOOK_OBJECT_NODE_TYPE,
  });
}
