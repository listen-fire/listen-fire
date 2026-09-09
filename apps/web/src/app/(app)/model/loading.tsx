export default function Loading() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-100 px-4">
        <div className="h-4 w-20 animate-pulse rounded bg-gray-100" />
        <div className="flex items-center gap-2">
          <div className="h-7 w-24 animate-pulse rounded-md bg-gray-100" />
          <div className="h-7 w-24 animate-pulse rounded-md bg-gray-100" />
          <div className="h-7 w-24 animate-pulse rounded-md bg-gray-100" />
        </div>
      </div>
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 items-center justify-center">
          <div className="relative h-40 w-56">
            <div className="absolute left-1/2 top-0 h-10 w-28 -translate-x-1/2 animate-pulse rounded-lg border border-gray-100 bg-gray-50" />
            <div className="absolute bottom-0 left-0 h-10 w-24 animate-pulse rounded-lg border border-gray-100 bg-gray-50" style={{ animationDelay: '100ms' }} />
            <div className="absolute right-0 bottom-0 h-10 w-24 animate-pulse rounded-lg border border-gray-100 bg-gray-50" style={{ animationDelay: '200ms' }} />
            <div className="absolute left-1/2 top-10 h-16 w-px -translate-x-4 rotate-[25deg] bg-gray-100" />
            <div className="absolute left-1/2 top-10 h-16 w-px translate-x-3 -rotate-[25deg] bg-gray-100" />
          </div>
        </div>
        <div className="hidden w-80 shrink-0 border-l border-gray-200 p-4 sm:block">
          <div className="space-y-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="h-3 w-16 animate-pulse rounded bg-gray-50" />
                <div className="h-8 w-full animate-pulse rounded-md bg-gray-50" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
