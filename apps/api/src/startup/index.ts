// The composition root for background work: which units' registries this
// process runs, and the one bridge that belongs to no single unit.
//
// Everything below is either "this unit's registry, if this unit is mounted"
// or a wire between two mounted units. There is no worker here.

import { mounts, mountedProducts } from '../products';
import { mutationDelivery } from '../services/knowledge/mutation_outbox/delivery_mode';
import { subscribeEngineToKnowledgeOutbox } from '../services/translation_graph/triggers/knowledge_outbox_subscriber';
import { asksWorkers } from './asks';
import { automationsWorkers } from './automations';
import { coreStartup } from './core';
import { knowledgeWorkers } from './knowledge';
import { residualWorkers } from './residual';
import { runRegistry } from './registry';
import { valuationsWorkers } from './valuations';

/**
 * Knowledge emits, the engine listens, and neither imports the other to do it
 * (M-38). Which way a drained event travels is this deployment's single
 * delivery mode — under `local` we are the consumer, so we subscribe; under
 * `webhook` automations is a different process reaching us over HTTP, and
 * subscribing too would deliver every mutation twice (D39c, D41b). Either way
 * it takes BOTH products in this process for there to be anything to wire.
 */
function wireKnowledgeToEngine() {
  if (!mounts('knowledge') || !mounts('automations')) return;
  if (mutationDelivery() !== 'local') return;
  subscribeEngineToKnowledgeOutbox();
}

function startup() {
  console.warn(`[startup] products: ${mountedProducts().join(', ')}`);

  wireKnowledgeToEngine();

  if (mounts('core')) runRegistry(coreStartup);
  if (mounts('valuations')) runRegistry(valuationsWorkers);
  if (mounts('automations')) runRegistry(automationsWorkers);
  if (mounts('knowledge')) runRegistry(knowledgeWorkers);
  if (mounts('asks')) runRegistry(asksWorkers);
  if (mounts('residual')) runRegistry(residualWorkers);
}

export { startup };
