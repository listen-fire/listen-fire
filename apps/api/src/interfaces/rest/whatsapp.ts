import { type Router, Router as ExpressRouter } from 'express';

import { verifyWebhook, receiveWebhook, type WhatsappDoorConfig } from '../whatsapp/webhook';

// The one Meta number door. Both numbers live in the SAME Meta app / WABA, so
// they deliver here to a single webhook; the door is number-aware — it reads
// each message's phone_number_id, gates movement-vs-legacy on the receiving
// number (see services/whatsapp/dispatch.ts), and replies from that number.
const primaryDoor: WhatsappDoorConfig = {
  verifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  appSecret: process.env.WHATSAPP_WEBHOOK_SECRET,
};

const router: Router = ExpressRouter();

router.get('/webhook', verifyWebhook(primaryDoor));
router.post('/webhook', receiveWebhook(primaryDoor));

export { router as whatsappRouter };
