import { Router } from 'express';

const mailgunRouter: ReturnType<typeof Router> = Router();

// DELIBERATE SINK — not a broken door, and NOT inbound mail.
//
// The Mailgun dashboard's *event* webhook (delivery/bounce/open telemetry for
// OUTBOUND mail) POSTs here. It originally fed an `email_event_log` table
// (ce03f7645, 2024-07); when that table was removed (c1a0fdf91) the route was
// kept as a 200-sink so Mailgun doesn't accumulate 404s and disable the
// webhook noisily. Inbound mail routing is completely separate
// (`/api/private/mailgun/callback` via Mailgun Routes) and never touches this.
//
// Delete this route only together with removing the event webhook in the
// Mailgun dashboard.
mailgunRouter.post('/event', async (_, res) => {
  res.sendStatus(200);
});

export { mailgunRouter };
