import { NextRequest, NextResponse } from 'next/server';
import { isProxiedApiPath, runtimeApiTarget } from '@/lib/api-proxy';

// A self-host image is built without knowing its API, so the rewrites baked
// into the route manifest are wrong there. Whenever the operator names an API
// at run time, that name wins for every path the rewrites cover. Admin has no
// other middleware concern — sign-in is enforced by the pages themselves.
export function middleware(request: NextRequest) {
  const apiTarget = runtimeApiTarget();
  if (!apiTarget || !isProxiedApiPath(request.nextUrl.pathname)) return NextResponse.next();

  return NextResponse.rewrite(
    new URL(request.nextUrl.pathname + request.nextUrl.search, apiTarget),
  );
}

export const config = {
  matcher: ['/api/:path*', '/subscriptions/:path*'],
};
