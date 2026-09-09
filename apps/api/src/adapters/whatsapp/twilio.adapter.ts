import twilio from 'twilio';

import { sendSlackNotification } from '../../lib/slack';
import { OutboundWhatsAppMessager, SendArgs } from './interface';

function normaliseWhatsAppNumber(whatsAppNumber: string) {
  return whatsAppNumber.replace(/^(whatsapp:)?/, 'whatsapp:');
}

class OutboundTwilioMessager implements OutboundWhatsAppMessager {
  private twilioNumber: string;
  private twilioClient: twilio.Twilio;

  constructor({
    twilioNumber,
    accountSid,
    authToken,
  }: {
    twilioNumber: string;
    accountSid: string;
    authToken: string;
  }) {
    this.twilioNumber = twilioNumber;
    this.twilioClient = twilio(accountSid, authToken);
  }

  async send({ recipient, body, contentSid }: SendArgs): Promise<boolean> {
    const response = await this.twilioClient.messages.create({
      from: normaliseWhatsAppNumber(this.twilioNumber),
      to: normaliseWhatsAppNumber(recipient.phoneNumber),
      body,
      statusCallback: 'https://forward-errors-to-slack-6063.twil.io/message-status',
      contentSid,
    });

    if (response.status === 'failed' || response.status === 'undelivered') {
      await sendSlackNotification({
        type: 'DEALFLOW',
        opsTitle: `WhatsApp message to ${recipient.displayName} failed`,
        text: `:whatsapp: :x: WhatsApp message to ${recipient.displayName} failed
          \n Error Code: ${response.errorCode}
          \n Error Message: ${response.errorMessage}
        `,
      });
    }
    return response.status !== 'failed' && response.status !== 'undelivered';
  }
}

export { OutboundTwilioMessager };
