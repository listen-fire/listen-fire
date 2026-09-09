import React from 'react';
import { render } from '@react-email/render';

import SignupConfirmTemplate, {
  SignupConfirmTemplateProps,
} from './templates/SignupConfirmTemplate';
import { sendEmail } from './send';

interface SignupConfirmProps {
  recipientEmail: string;
  confirmLink: string;
  expiryMinutes: number;
}

/** The email-verification message for a password signup — confirms the address
 *  before any account is created (distinct from the magic-link login email). */
async function signupConfirmEmail(props: SignupConfirmProps) {
  const templateParams: SignupConfirmTemplateProps = {
    confirmLink: props.confirmLink,
    expiryMinutes: props.expiryMinutes,
  };
  const emailBody = render(<SignupConfirmTemplate {...templateParams} />);
  return sendEmail('signup_confirm', {
    recipients: [
      {
        email: props.recipientEmail,
        username: props.recipientEmail.split('@')[0],
      },
    ],
    subject: 'Confirm your email to finish signing up for Listen-Fire',
    data: emailBody,
  });
}

export { signupConfirmEmail };
