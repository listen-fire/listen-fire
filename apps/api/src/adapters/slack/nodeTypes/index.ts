import { nodeTypeRegistry } from '../../pipeline/outbound/nodeTypes';
import { attachmentNode } from './attachment';
import { previewNode } from './preview';
import { replyNode } from './reply';
import { messageNode } from './message';

export function registerSlackNodeTypes(): void {
  nodeTypeRegistry.register(messageNode);
  nodeTypeRegistry.register(replyNode);
  nodeTypeRegistry.register(attachmentNode);
  nodeTypeRegistry.register(previewNode);
}
