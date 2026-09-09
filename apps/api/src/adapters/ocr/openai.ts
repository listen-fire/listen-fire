import { Readable } from 'node:stream';

import { OcrAdapter } from './interface';
import { openAiChat } from '../../lib/openai';
import { streamToBuffer } from '../../lib/utils/stream';

class OpenAiOcrAdapter implements OcrAdapter {
  async extractPdf(rs: Readable, _options: { numpages?: number; size: number }) {
    const pdfBuffer = await streamToBuffer(rs);
    const pdfAsBase64 = pdfBuffer.toString('base64');

    const output = await openAiChat(
      [
        {
          role: 'system',
          content: `You are a PDF OCR service.

Extract the text from the PDF sent by the user. You respond with the text from the PDF, and add any appropriate metadata.

Use markdown to format the output (e.g. titles as # Title), and describe any image where it appears in the document.
The aim is to get the best textual representation of what's in the document, so spatial reasoning matters a lot.

You do not provide additional commentary, or offer to do anything else. You only respond with the extracted information.

Your output will be interpreted by a wider system as the content of the document. No human will interact with your output directly.`,
        },
        {
          role: 'user',
          content: [
            {
              type: 'file',
              file: {
                filename: 'document.pdf',
                file_data: `data:application/pdf;base64,${pdfAsBase64}`,
              },
            },
          ],
        },
      ],
      {
        model: 'gpt-5-mini',
        temperature: 1,
      },
      'pdf_ocr',
    );

    return output;
  }
}

export { OpenAiOcrAdapter };
