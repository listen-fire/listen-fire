'use client';

import { AuthProvider } from '@/lib/auth';
import { TRPCProvider } from '@/lib/trpc-provider';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <TRPCProvider>{children}</TRPCProvider>
    </AuthProvider>
  );
}
