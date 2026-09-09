export default function Loading() {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-100 px-4">
        <div className="flex items-center gap-2.5">
          <div className="h-4.5 w-4.5 animate-pulse rounded bg-gray-100" />
          <div className="h-4 w-28 animate-pulse rounded bg-gray-100" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-8 w-52 animate-pulse rounded-md bg-gray-50" />
          <div className="h-8 w-16 animate-pulse rounded-md bg-gray-100" />
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {/* Header row */}
        <div className="flex border-b border-gray-200 bg-gray-50/95">
          {[224, 160, 160, 160, 112].map((w, i) => (
            <div key={i} className="shrink-0 px-3 py-2" style={{ width: w }}>
              <div className="h-3 w-16 animate-pulse rounded bg-gray-200/60" />
            </div>
          ))}
        </div>
        {/* Rows */}
        <div className="space-y-px p-px">
          {Array.from({ length: 14 }).map((_, i) => (
            <div key={i} className="flex" style={{ height: 36 }}>
              <div className="flex items-center px-3" style={{ width: 224 }}>
                <div className="h-3.5 w-28 animate-pulse rounded bg-gray-100" style={{ animationDelay: `${i * 30}ms` }} />
              </div>
              {[160, 160, 160].map((w, j) => (
                <div key={j} className="flex items-center px-3" style={{ width: w }}>
                  <div className="h-3.5 w-20 animate-pulse rounded bg-gray-50" style={{ animationDelay: `${i * 30 + 15}ms` }} />
                </div>
              ))}
              <div className="flex items-center px-3" style={{ width: 112 }}>
                <div className="h-3.5 w-12 animate-pulse rounded bg-gray-50" style={{ animationDelay: `${i * 30 + 30}ms` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
