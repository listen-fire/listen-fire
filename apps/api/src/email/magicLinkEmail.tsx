import React from 'react';
import { render } from '@react-email/render';

import MagicLinkTemplate, { MagicLinkTemplateProps } from './templates/MagicLinkTemplate';
import { sendEmail } from './send';

interface MagicLinkProps {
  recipientName: string;
  recipientEmail: string;
  magicLink: string;
}

async function magicLinkEmail(props: MagicLinkProps) {
  const templateParams: MagicLinkTemplateProps = {
    recipientName: props.recipientName,
    magicLink: props.magicLink,
  };
  const emailBody = render(<MagicLinkTemplate {...templateParams} />);
  return sendEmail('magic_link', {
    recipients: [
      {
        email: props.recipientEmail,
        username: props.recipientName,
      },
    ],
    subject: "Log in to Listen-Fire (Don't forward this)",
    data: emailBody,
  });
}

export { magicLinkEmail };
