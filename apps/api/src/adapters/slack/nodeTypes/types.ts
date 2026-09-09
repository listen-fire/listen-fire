import { createNodeTypeId } from '../../pipeline/outbound/nodeTypes';

export const SLACK_NODE_TYPES = {
  MESSAGE: createNodeTypeId('slack', 'message'),
  THREAD_REPLY: createNodeTypeId('slack', 'thread-reply'),
  ATTACHMENT: createNodeTypeId('slack', 'attachment'),
  PREVIEW: createNodeTypeId('slack', 'preview'),
} as const;
