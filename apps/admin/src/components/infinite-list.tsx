'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_ROW_HEIGHT = 56;

export type Page<T> = { items: T[]; total: number };

export function InfiniteList<T>({
  fetchPage,
  renderRow,
  rowHeight = DEFAULT_ROW_HEIGHT,
  pageSize = DEFAULT_PAGE_SIZE,
  searchPlaceholder = 'Search…',
  emptyLabel = 'Nothing here yet.',
  toolbar,
  requireSearch = false,
}: {
  fetchPage: (search: string, limit: number, offset: number) => Promise<Page<T>>;
  renderRow: (item: T, index: number) => React.ReactNode;
  rowHeight?: number;
  pageSize?: number;
  searchPlaceholder?: string;
  emptyLabel?: string;
  toolbar?: React.ReactNode;
  /** When true, the list shows a placeholder and skips all fetches until the search box is non-empty. */
  requireSearch?: boolean;
}): JSX.Element {
  const [inputValue, setInputValue] = useState('');
  const [search, setSearch] = useState('');
  const [pages, setPages] = useState<Map<number, T[]>>(new Map());
  const [total, setTotal] = useState<number | null>(null);

  // Track in-flight page fetches — a ref (not state) so we never re-render
  // just because a fetch starts/ends.
  const inFlight = useRef(new Set<number>());
  // Track which search term the current page cache belongs to, so stale
  // responses from a previous query are discarded.
  const currentSearch = useRef(search);

  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Debounce search input ────────────────────────────────────────────
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleInputChange = useCallback((value: string) => {
    setInputValue(value);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setSearch(value);
    }, 300);
  }, []);

  // ── Reset cache whenever the committed search term changes ───────────
  useEffect(() => {
    currentSearch.current = search;
    setPages(new Map());
    setTotal(null);
    inFlight.current.clear();
    // Scroll to top
    scrollRef.current?.scrollTo({ top: 0 });
  }, [search]);

  // ── Page loader ──────────────────────────────────────────────────────
  const loadPage = useCallback(
    async (pageIndex: number) => {
      if (inFlight.current.has(pageIndex)) return;
      inFlight.current.add(pageIndex);

      const searchAtFetch = currentSearch.current;

      try {
        const result = await fetchPage(searchAtFetch, pageSize, pageIndex * pageSize);

        // Discard if the search term has since changed
        if (searchAtFetch !== currentSearch.current) return;

        setTotal(result.total);
        setPages((prev) => {
          const next = new Map(prev);
          next.set(pageIndex, result.items);
          return next;
        });
      } finally {
        inFlight.current.delete(pageIndex);
      }
    },
    [fetchPage, pageSize],
  );

  // ── Virtualizer ──────────────────────────────────────────────────────
  const virtualizer = useVirtualizer({
    count: total ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 20,
  });

  const virtualItems = virtualizer.getVirtualItems();

  // ── Trigger page loads for visible pages ─────────────────────────────
  const visiblePageIndices = useMemo(() => {
    const indices = new Set<number>();
    for (const item of virtualItems) {
      indices.add(Math.floor(item.index / pageSize));
    }
    return indices;
  }, [virtualItems, pageSize]);

  // ── requireSearch: skip all fetches while the search box is empty ────
  const blocked = requireSearch && search === '';

  useEffect(() => {
    if (blocked) return;
    for (const pageIdx of visiblePageIndices) {
      if (!pages.has(pageIdx) && !inFlight.current.has(pageIdx)) {
        loadPage(pageIdx);
      }
    }
  }, [blocked, visiblePageIndices, pages, loadPage]);

  // ── Initial fetch (page 0) on mount and after search reset ───────────
  useEffect(() => {
    if (!blocked && total === null && !inFlight.current.has(0)) {
      loadPage(0);
    }
  }, [blocked, total, loadPage]);

  // ── Render ───────────────────────────────────────────────────────────
  const isLoading = !blocked && total === null;

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar row: search + optional extra controls */}
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={inputValue}
          onChange={(e) => handleInputChange(e.target.value)}
          placeholder={searchPlaceholder}
          className="flex-1 rounded-md border border-gray-200 px-3 py-2 text-[13px] focus:border-gray-400 focus:outline-none"
        />
        {toolbar}
      </div>

      {/* List */}
      {blocked ? (
        <div className="flex items-center justify-center rounded-xl border border-dashed border-gray-200 py-10 text-[13px] text-gray-400">
          Type to search…
        </div>
      ) : isLoading ? (
        <div className="space-y-1.5">
          {Array.from({ length: 5 }, (_, i) => (
            <div
              key={i}
              style={{ height: rowHeight }}
              className="animate-pulse rounded-xl bg-gray-100"
            />
          ))}
        </div>
      ) : total === 0 ? (
        <div className="flex items-center justify-center rounded-xl border border-dashed border-gray-200 py-10 text-[13px] text-gray-400">
          {emptyLabel}
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="max-h-[70vh] overflow-auto rounded-xl border border-gray-100"
        >
          {/* Spacer that drives the scroll range */}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualItems.map((virtualItem) => {
              const pageIdx = Math.floor(virtualItem.index / pageSize);
              const rowIdx = virtualItem.index % pageSize;
              const item = pages.get(pageIdx)?.[rowIdx];

              return (
                <div
                  key={virtualItem.key}
                  style={{
                    position: 'absolute',
                    top: virtualItem.start,
                    left: 0,
                    right: 0,
                    height: virtualItem.size,
                  }}
                >
                  {item !== undefined ? (
                    renderRow(item, virtualItem.index)
                  ) : (
                    // Placeholder for not-yet-loaded rows
                    <div className="flex h-full items-center px-4">
                      <div className="h-3 w-2/3 animate-pulse rounded bg-gray-100" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Count footer */}
      {total !== null && total > 0 && (
        <div className="text-[11px] text-gray-400">
          {total.toLocaleString()} {total === 1 ? 'result' : 'results'}
        </div>
      )}
    </div>
  );
}
