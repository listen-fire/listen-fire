import * as React from 'react';
import { Html, Head, Font, Text, Tailwind, Button, Hr } from '@react-email/components';

import { HOUR, MAGIC_LINK_EXPIRY } from '../../constants';

interface MagicLinkTemplateProps {
  recipientName: string;
  magicLink: string;
}

function MagicLinkTemplate(props: MagicLinkTemplateProps) {
  return (
    <Html lang="en" className="bg-white">
      <Tailwind>
        <Head>
          <Font fontFamily="Arial" fallbackFontFamily="Arial" fontWeight={400} fontStyle="normal" />
        </Head>
        <Text>Hi {props.recipientName},</Text>

        <Text>Here's a magic link to log into your account:</Text>

        <Button href={props.magicLink} className="bg-[#8778F7] px-8 py-4 text-white rounded-lg">
          Log in to Listen-Fire
        </Button>

        <Hr />

        <Text className="text-xs text-gray-500">
          If you did not request this link, please ignore this email. Do not share this link with
          anyone or forward this email.
          <br />
          This link will expire in {MAGIC_LINK_EXPIRY / HOUR} hours.
          <br />
        </Text>
      </Tailwind>
    </Html>
  );
}

MagicLinkTemplate.PreviewProps = {
  recipientName: 'Andy',
  magicLink:
    'http://localhost:3001/magic?token=adsalfkhdgsflkasjdhflaskdjfhasldkjfhasdkfjhadskjflhdsaljkfhasdlafdhslfjkahkjfhd',
};

export { MagicLinkTemplateProps };

// eslint-disable-next-line local-rules/bottom-exports
export default MagicLinkTemplate;
