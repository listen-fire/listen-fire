'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc';

export function TemplateGallery() {
  const { data: templates } = trpc.views.knowledge.ontology.getTemplates.useQuery();
  const { mutateAsync: materialize, isLoading: materializing } =
    trpc.views.knowledge.ontology.materializeTemplate.useMutation();
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const utils = trpc.useUtils();

  if (!templates) return null;

  const handleMaterialize = async (key: string) => {
    setActiveKey(key);
    try {
      await materialize({ templateKey: key });
      utils.views.knowledge.ontology.getOntologySummary.invalidate();
      utils.views.knowledge.ontology.getNodeTypes.invalidate();
      utils.views.knowledge.ontology.getEdgeTypes.invalidate();
    } finally {
      setActiveKey(null);
    }
  };

  return (
    <div className="grid w-full max-w-xl grid-cols-2 gap-3">
      {templates.map((t) => (
        <button
          key={t.key}
          onClick={() => handleMaterialize(t.key)}
          disabled={materializing}
          className={`
            flex flex-col gap-2 rounded-lg border border-gray-200 p-4 text-left transition-all
            ${materializing ? 'opacity-60 cursor-not-allowed' : 'hover:border-gray-400 hover:shadow-sm cursor-pointer'}
          `}
        >
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium text-gray-900">{t.name}</span>
            {materializing && activeKey === t.key && (
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
            )}
          </div>
          <p className="line-clamp-2 text-[12px] text-gray-500">{t.description}</p>
          <div className="flex flex-wrap gap-1">
            {t.preview.map((p) => (
              <span key={p} className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
                {p}
              </span>
            ))}
          </div>
        </button>
      ))}
    </div>
  );
}
