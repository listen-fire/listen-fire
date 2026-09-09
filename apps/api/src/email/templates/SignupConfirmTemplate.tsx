import * as React from 'react';
import { Html, Head, Font, Text, Tailwind, Button, Hr } from '@react-email/components';

interface SignupConfirmTemplateProps {
  confirmLink: string;
  expiryMinutes: number;
}

function SignupConfirmTemplate(props: SignupConfirmTemplateProps) {
  return (
    <Html lang="en" className="bg-white">
      <Tailwind>
        <Head>
          <Font fontFamily="Arial" fallbackFontFamily="Arial" fontWeight={400} fontStyle="normal" />
        </Head>
        <Text>Welcome to Listen-Fire!</Text>

        <Text>Confirm your email address to finish creating your account:</Text>

        <Button href={props.confirmLink} className="bg-[#8778F7] px-8 py-4 text-white rounded-lg">
          Confirm my email
        </Button>

        <Text>
          Once confirmed, you can sign in with your email and password — or with Google, Microsoft,
          or a magic link.
        </Text>

        <Hr />

        <Text className="text-xs text-gray-500">
          If you didn&apos;t try to sign up for Listen-Fire, you can safely ignore this email — no
          account will be created. Don&apos;t share or forward this link.
          <br />
          This link expires in {props.expiryMinutes} minutes.
          <br />
        </Text>
      </Tailwind>
    </Html>
  );
}

SignupConfirmTemplate.PreviewProps = {
  confirmLink: 'http://localhost:3003/signup/confirm?token=abc123',
  expiryMinutes: 30,
};

export { SignupConfirmTemplateProps };

// eslint-disable-next-line local-rules/bottom-exports
export default SignupConfirmTemplate;
