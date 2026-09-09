import { extractDocumentTextTool } from './extract_document_text';
import { pitchDeckUrlTool } from './pitch_deck_url';
import { splitMultipleDealsTool } from './split_multiple_deals';

const toolsList = [extractDocumentTextTool, pitchDeckUrlTool, splitMultipleDealsTool];

type Tool = (typeof toolsList)[number];

const tools = toolsList.reduce(
  (acc, tool) => {
    acc[tool.type] = tool;
    return acc;
  },
  {} as Record<Tool['type'], (typeof toolsList)[number]>,
);

export { Tool, tools };
