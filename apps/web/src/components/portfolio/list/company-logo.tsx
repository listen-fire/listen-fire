"use client";

/**
 * List-local favicon-style logo. Deliberately not shared with the
 * company-page CompanyLogo (apps/web/src/components/portfolio/company/
 * company-logo.tsx, owned by another agent porting the company page) —
 * same derivation (apps/api's `/api/public/icon` proxy off the website's
 * hostname), kept as a separate small component per row rather than a
 * cross-import.
 */

import { useEffect, useState } from "react";
import { apiOrigin as resolveApiOrigin } from "@/lib/api-origin";

function deriveLogoUrl(url: string | null | undefined, size: number): string | undefined {
  if (!url) return undefined;

  let hostname: string | undefined;
  for (const candidate of [url, `https://${url}`]) {
    try {
      hostname = new URL(candidate).hostname;
      break;
    } catch {
      // try the next candidate
    }
  }
  if (!hostname) return undefined;

  // No origin means same-origin (a self-host build bakes none, and this also
  // renders on the server) — stay relative rather than feed `new URL` a base
  // of "", which throws.
  const apiOrigin = resolveApiOrigin();
  const iconPath = `/api/public/icon?size=${size}&hostname=${hostname}`;
  return apiOrigin ? new URL(iconPath, apiOrigin).toString() : iconPath;
}

export function CompanyLogo({
  url,
  alt,
  size = 28,
}: {
  url?: string | null;
  alt?: string;
  size?: number;
}) {
  const logoUrl = deriveLogoUrl(url, size * 4);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [logoUrl]);

  const initials = (alt ?? "").trim().slice(0, 2).toUpperCase();
  const showImage = Boolean(logoUrl) && !failed;

  return (
    <div
      style={{ width: size, height: size }}
      className="relative shrink-0 overflow-hidden rounded-md bg-gray-100"
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- external, unoptimized favicon
        <img
          src={logoUrl}
          alt={alt || "company logo"}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center font-semibold text-gray-400"
          style={{ fontSize: Math.max(9, size / 2.5) }}
        >
          {initials}
        </div>
      )}
    </div>
  );
}
