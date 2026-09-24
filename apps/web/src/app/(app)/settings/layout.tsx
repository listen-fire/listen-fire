"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { PageBody, PageHeader } from "@/components/ui";

const tabs = [
  { label: "General", href: "/settings" },
  { label: "Team", href: "/settings/team" },
  { label: "API Keys", href: "/settings/api-keys" },
  { label: "Webhooks", href: "/settings/webhooks" },
  { label: "Remote Adapters", href: "/settings/remote-adapters" },
] as const;

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <>
      <PageHeader title="Settings" />
      <PageBody width="narrow">
        <nav className="flex gap-4 overflow-x-auto border-b border-gray-100">
          {tabs.map((tab) => {
            const active =
              tab.href === "/settings"
                ? pathname === "/settings"
                : pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`shrink-0 whitespace-nowrap border-b-2 px-1 pb-2 text-[13px] font-medium transition-colors ${
                  active
                    ? "border-primary text-primary-700"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-6">{children}</div>
      </PageBody>
    </>
  );
}
