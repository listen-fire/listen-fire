import type { Chapter } from '../types';

export const connectBuildAutomate: Chapter = {
  id: 'connect-build-automate',
  title: 'Connect, build, automate',
  content: `## How the pieces fit

Getting value from Listen-Fire is three moves, in order.

1. **Connect** the systems you work in — your CRM, your email — from the
   Connections page. A connection is a stored credential Listen-Fire uses to
   read and write on your behalf.
2. **Build** an automation: a small program that says "when this happens,
   write that there". Automations read from and write to the systems you
   connected. (The "Writing automations" handbook covers authoring.)
3. **Automate**: once an automation is live, its trigger fires it on real
   events, and the Automations page shows what it did.

You usually start by connecting a system, because an automation can only
move data between systems Listen-Fire can reach. If a user wants to build
something but has nothing connected yet, connecting is the first step —
and you can offer to do it for them in this conversation.`,
};
