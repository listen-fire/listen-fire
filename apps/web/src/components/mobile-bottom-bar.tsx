"use client";

interface MobileBottomBarProps {
  children: React.ReactNode;
}

export function MobileBottomBar({ children }: MobileBottomBarProps) {
  return (
    <div className="flex shrink-0 items-center justify-between border-t border-gray-200 bg-white px-4 py-3">
      {children}
    </div>
  );
}
