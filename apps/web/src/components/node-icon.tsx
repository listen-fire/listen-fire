'use client';

import { useEffect, useRef } from 'react';
import { trpc } from '@/lib/trpc';

function PlaceholderIcon({ size, className }: { size: number; className?: string }) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" opacity="0.3" />
    </svg>
  );
}

function InlineSvg({ svg, size, className }: { svg: string; size: number; className?: string }) {
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = svg;

    const svgEl = containerRef.current.querySelector('svg');
    if (svgEl) {
      svgEl.removeAttribute('width');
      svgEl.removeAttribute('height');
      svgEl.removeAttribute('class');
      svgEl.style.width = '100%';
      svgEl.style.height = '100%';
      svgEl.style.display = 'block';
    }
  }, [svg]);

  return (
    <span
      ref={containerRef}
      className={`inline-flex shrink-0 ${className ?? ''}`}
      style={{ width: size, height: size }}
    />
  );
}

export function NodeIcon({
  nodeTypeId,
  iconSvg,
  size = 16,
  className,
}: {
  nodeTypeId: string;
  iconSvg: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const utils = trpc.useUtils();

  const { mutate, data, isLoading } = trpc.views.knowledge.ontology.generateNodeIcon.useMutation({
    onSuccess: () => {
      utils.views.knowledge.ontology.getOntologySummary.invalidate();
    },
  });

  const hasTriggered = useRef(false);

  useEffect(() => {
    if (!iconSvg && !hasTriggered.current && !isLoading && !data) {
      hasTriggered.current = true;
      mutate({ nodeTypeId });
    }
  }, [iconSvg, nodeTypeId, isLoading, data, mutate]);

  const svg = iconSvg ?? data?.svg;

  if (!svg) {
    return <PlaceholderIcon size={size} className={className} />;
  }

  return <InlineSvg svg={svg} size={size} className={className} />;
}
