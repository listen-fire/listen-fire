'use client';

import { AuthProvider } from '@/lib/auth';
import { CapabilitiesProvider } from '@/lib/capabilities-provider';
import { TRPCProvider } from '@/lib/trpc-provider';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <CapabilitiesProvider>
      <AuthProvider>
        <TRPCProvider>{children}</TRPCProvider>
      </AuthProvider>
    </CapabilitiesProvider>
  );
}
