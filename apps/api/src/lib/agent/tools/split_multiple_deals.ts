import { Prompt } from '../../prompts';
import { RawTextService } from '../../../services/raw_text';
import { TextOutput, Tool } from './types';

type SplitMultipleDealsParams = {
  rawTextId: string;
};

const splitMultipleDealsTool: Tool<SplitMultipleDealsParams, TextOutput[]> = async ({
  rawTextId,
}) => {
  const { content } = await RawTextService.getById(rawTextId);

  let dealContents = await Prompt.splitMessageIntoMultipleDeals({ message: content });

  if (dealContents.length === 0) {
    dealContents = [content];
  }

  const outputs: TextOutput[] = [];
  for (const dealContent of dealContents) {
    const { id } = await RawTextService.getOrCreateFromContent(dealContent);
    outputs.push({ type: 'TEXT', rawTextId: id });
  }

  return outputs;
};

splitMultipleDealsTool.type = 'SPLIT_MULTIPLE_DEALS';

export { splitMultipleDealsTool };
