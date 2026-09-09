"use client";

/**
 * Port of apps/app's components/CompanyLogo (a styled-components Avatar
 * wrapper) — derives a favicon URL from the company's website via apps/api's
 * icon proxy (`/api/public/icon`), falling back to the company's initials
 * when there's no website or the image fails to load. apps/app used
 * `useUnicornFallback` to show a placeholder mascot instead; apps/web has no
 * such asset, so the fallback is always initials.
 */

import { useEffect, useState } from "react";
import { apiOrigin as resolveApiOrigin } from "@/lib/api-origin";

function deriveLogoUrl(
  url: string | null | undefined,
  size: number,
): string | undefined {
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
  size,
  fetchSize,
  border,
}: {
  url?: string | null;
  alt?: string;
  size: number;
  fetchSize?: number;
  border?: boolean;
}) {
  const logoUrl = deriveLogoUrl(url, fetchSize ?? size);
  const [failed, setFailed] = useState(false);

  // Reset the failure flag when the source URL changes (e.g. a different
  // company renders through the same mounted component instance).
  useEffect(() => {
    setFailed(false);
  }, [logoUrl]);

  const initials = (alt ?? "").trim().slice(0, 2).toUpperCase();
  const showImage = Boolean(logoUrl) && !failed;

  return (
    <div
      style={{ width: size, height: size }}
      className={`relative shrink-0 overflow-hidden rounded-lg ${
        border ? "border border-gray-200" : ""
      }`}
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
          className="flex h-full w-full items-center justify-center bg-gray-100 font-semibold text-gray-400"
          style={{ fontSize: Math.max(10, size / 2.5) }}
        >
          {initials}
        </div>
      )}
    </div>
  );
}
