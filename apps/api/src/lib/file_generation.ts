import { Readable } from 'node:stream';

import OpenAI from 'openai';
import { jsPDF } from 'jspdf';
import ExcelJS from 'exceljs';

import { services } from '../adapters/registry';
import { getEnvVar } from './utils/environment';
import { isProd } from '../constants';
import { logger } from '../services/logger';

const organizationFallbackOrDev = 'org-8dLfRZxrZST5fjBfvwxP0fU5';
const organization = isProd ? 'org-8BBSblaUkeNcT0htEr4sOoed' : organizationFallbackOrDev;

// Read at first USE, not at module load. `getEnvVar` throws in production when
// the key is unset, so an eager read made merely IMPORTING this module enough
// to stop the process booting — including for a deployment that runs entirely
// on per-team keys (BYOT) or uses no LLM at all. Memoized: still one read and
// one client, just on first call rather than on import.
let openaiClient: OpenAI | undefined;
const openai = () =>
  (openaiClient ??= new OpenAI({
    apiKey: isProd
      ? getEnvVar('OPENAI_API_KEY', { devDefault: 'test', because: 'generated images come from OpenAI' })
      : getEnvVar('OPENAI_API_KEY_FALLBACK_OR_DEV', { devDefault: 'test' }),
    organization,
  }));

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

interface GeneratedFile {
  objectUri: string;
  downloadUrl: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

interface Attachment {
  title: string;
  format: string;
  objectUri: string;
  mimeType: string;
  sizeBytes: number;
}

async function uploadAndSign(buffer: Buffer, filename: string, mimeType: string): Promise<GeneratedFile> {
  const { objectUri } = await services.document.upload(Readable.from(buffer), {
    filename,
    mimeType,
    contentLength: buffer.length,
  });
  const downloadUrl = await services.document.getDownloadUrl({ objectUri });
  return { objectUri, downloadUrl, filename, mimeType, sizeBytes: buffer.length };
}

// -- Image generation --

// -- Image generation (Nano Banana 2 via Vertex AI) --

// Vertex config is read lazily for the same reason as the OpenAI key: image
// generation is optional, and a deployment that never generates one should
// not have to carry Google service-account credentials to boot.
const vertexConfig = () => ({
  privateKey: getEnvVar('GOOGLE_PRIVATE_KEY', { devDefault: '' }),
  clientEmail: getEnvVar('GOOGLE_CLIENT_EMAIL', { devDefault: '' }),
  projectId: getEnvVar('GOOGLE_PROJECT_ID', { devDefault: '' }),
  projectLocation: getEnvVar('GOOGLE_PROJECT_LOCATION', { devDefault: 'europe-west1' }),
});

function dalleToNanoBanana(size?: string): { aspectRatio: string; imageSize: string } {
  if (size === '1792x1024') return { aspectRatio: '16:9', imageSize: '2K' };
  if (size === '1024x1792') return { aspectRatio: '9:16', imageSize: '2K' };
  return { aspectRatio: '1:1', imageSize: '1K' };
}

async function getVertexAccessToken(): Promise<string> {
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({
    credentials: {
      type: 'service_account',
      private_key: vertexConfig().privateKey,
      client_email: vertexConfig().clientEmail,
    },
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse.token) throw new Error('Failed to get Vertex AI access token');
  return tokenResponse.token;
}

async function generateImageNanoBanana(args: {
  prompt: string;
  title: string;
  size?: string;
}): Promise<GeneratedFile> {
  const { aspectRatio, imageSize } = dalleToNanoBanana(args.size);
  const accessToken = await getVertexAccessToken();
  const { projectId, projectLocation } = vertexConfig();
  const endpoint = `https://${projectLocation}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${projectLocation}/publishers/google/models/gemini-3.1-flash-image-preview:generateContent`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: args.prompt }] }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio, imageSize },
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Nano Banana 2 error ${res.status}: ${body}`);
  }

  const json = await res.json();
  const parts = json.candidates?.[0]?.content?.parts;
  const imagePart = parts?.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
  if (!imagePart?.inlineData?.data) throw new Error('No image data returned from Nano Banana 2');

  const mimeType = imagePart.inlineData.mimeType ?? 'image/png';
  const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
  const buffer = Buffer.from(imagePart.inlineData.data, 'base64');
  return uploadAndSign(buffer, `${slugify(args.title)}.${ext}`, mimeType);
}

async function generateImage(args: {
  prompt: string;
  title: string;
  size?: '1024x1024' | '1792x1024' | '1024x1792';
  quality?: 'standard' | 'hd';
  style?: 'vivid' | 'natural';
}): Promise<GeneratedFile> {
  const { privateKey, clientEmail, projectId } = vertexConfig();
  if (privateKey && clientEmail && projectId) {
    return generateImageNanoBanana(args);
  }

  // Fallback to DALL-E 3
  const response = await openai().images.generate({
    model: 'dall-e-3',
    prompt: args.prompt,
    n: 1,
    size: args.size ?? '1024x1024',
    quality: args.quality ?? 'standard',
    style: args.style ?? 'vivid',
    response_format: 'b64_json',
  });

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image data returned from DALL-E');

  const buffer = Buffer.from(b64, 'base64');
  return uploadAndSign(buffer, `${slugify(args.title)}.png`, 'image/png');
}

// -- PDF generation (jsPDF + markdown text) --

async function generatePdf(args: {
  title: string;
  content: string;
  options?: { orientation?: 'portrait' | 'landscape'; size?: 'letter' | 'a4' };
}): Promise<GeneratedFile> {
  const orientation = args.options?.orientation ?? 'portrait';
  const format = args.options?.size ?? 'a4';

  const doc = new jsPDF({ orientation, format, unit: 'mm' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 20;
  const lineHeight = 6;
  const maxWidth = pageWidth - margin * 2;
  let y = margin;

  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  const titleLines = doc.splitTextToSize(args.title, maxWidth) as string[];
  for (const line of titleLines) {
    if (y + 10 > pageHeight - margin) { doc.addPage(); y = margin; }
    doc.text(line, margin, y);
    y += 10;
  }
  y += 6;

  doc.setFontSize(11);
  const lines = args.content.split('\n');

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.startsWith('### ')) {
      y += 4;
      if (y + lineHeight > pageHeight - margin) { doc.addPage(); y = margin; }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      const wrapped = doc.splitTextToSize(line.slice(4), maxWidth) as string[];
      for (const w of wrapped) {
        if (y + lineHeight > pageHeight - margin) { doc.addPage(); y = margin; }
        doc.text(w, margin, y);
        y += lineHeight;
      }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      continue;
    }
    if (line.startsWith('## ')) {
      y += 6;
      if (y + lineHeight > pageHeight - margin) { doc.addPage(); y = margin; }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(14);
      const wrapped = doc.splitTextToSize(line.slice(3), maxWidth) as string[];
      for (const w of wrapped) {
        if (y + lineHeight > pageHeight - margin) { doc.addPage(); y = margin; }
        doc.text(w, margin, y);
        y += 8;
      }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      continue;
    }
    if (line.startsWith('# ')) {
      y += 8;
      if (y + lineHeight > pageHeight - margin) { doc.addPage(); y = margin; }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      const wrapped = doc.splitTextToSize(line.slice(2), maxWidth) as string[];
      for (const w of wrapped) {
        if (y + lineHeight > pageHeight - margin) { doc.addPage(); y = margin; }
        doc.text(w, margin, y);
        y += 9;
      }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      continue;
    }

    if (!line) {
      y += lineHeight * 0.5;
      continue;
    }

    const bulletMatch = line.match(/^(\s*)[-*]\s+(.*)/);
    const indent = bulletMatch ? Math.min(bulletMatch[1].length * 2, 20) : 0;
    const text = bulletMatch ? bulletMatch[2] : line;
    const cleanText = text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').replace(/_(.*?)_/g, '$1');

    const wrapped = doc.splitTextToSize(cleanText, maxWidth - indent) as string[];
    for (let i = 0; i < wrapped.length; i++) {
      if (y + lineHeight > pageHeight - margin) { doc.addPage(); y = margin; }
      const prefix = bulletMatch && i === 0 ? '\u2022 ' : bulletMatch ? '  ' : '';
      doc.text(prefix + wrapped[i], margin + indent, y);
      y += lineHeight;
    }
  }

  const pdfBuffer = Buffer.from(doc.output('arraybuffer'));
  return uploadAndSign(pdfBuffer, `${slugify(args.title)}.pdf`, 'application/pdf');
}

// -- Chart generation (vega-lite spec → PNG) --

async function generateChart(args: {
  title: string;
  content: string;
}): Promise<GeneratedFile> {
  // Dynamic imports — vega and vega-lite are ESM-only packages
  const [vegaMod, vegaLiteMod] = await Promise.all([
    import('vega'),
    import('vega-lite'),
  ]);

  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(args.content);
  } catch {
    throw new Error('Chart content must be valid JSON (vega-lite specification)');
  }

  if (!spec.$schema) {
    spec.$schema = 'https://vega.github.io/schema/vega-lite/v5.json';
  }

  const compiled = vegaLiteMod.compile(spec as any);
  const view = new vegaMod.View(vegaMod.parse(compiled.spec), { renderer: 'none' });
  const canvas = await view.toCanvas();

  // canvas.toBuffer is provided by the node-canvas package
  const pngBuffer = (canvas as any).toBuffer('image/png') as Buffer;
  view.finalize();

  return uploadAndSign(pngBuffer, `${slugify(args.title)}.png`, 'image/png');
}

// -- Spreadsheet generation (JSON rows → XLSX) --

async function generateSpreadsheet(args: {
  title: string;
  content: string;
}): Promise<GeneratedFile> {
  let rows: Record<string, unknown>[];
  try {
    rows = JSON.parse(args.content);
  } catch {
    throw new Error('Spreadsheet content must be a JSON array of objects');
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Spreadsheet content must be a non-empty JSON array of objects');
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(args.title.slice(0, 31));

  // Derive columns from all keys across all rows
  const allKeys = new Set<string>();
  for (const row of rows) {
    if (row && typeof row === 'object') {
      for (const key of Object.keys(row)) allKeys.add(key);
    }
  }
  const columns = [...allKeys];
  sheet.columns = columns.map((key) => ({
    header: key,
    key,
    width: Math.max(key.length + 2, 12),
  }));

  // Style the header row
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };

  for (const row of rows) {
    if (row && typeof row === 'object') {
      sheet.addRow(row);
    }
  }

  const xlsxBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return uploadAndSign(
    xlsxBuffer,
    `${slugify(args.title)}.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
}

// -- Unified dispatch --

type FileFormat = 'pdf' | 'chart' | 'spreadsheet';

async function generateFile(args: {
  format: FileFormat;
  title: string;
  content: string;
  options?: { orientation?: 'portrait' | 'landscape'; size?: 'letter' | 'a4' };
}): Promise<GeneratedFile> {
  switch (args.format) {
    case 'pdf':
      return generatePdf({ title: args.title, content: args.content, options: args.options });
    case 'chart':
      return generateChart({ title: args.title, content: args.content });
    case 'spreadsheet':
      return generateSpreadsheet({ title: args.title, content: args.content });
    default:
      throw new Error(`Unsupported file format: ${args.format}`);
  }
}

const FORMAT_METADATA: Record<FileFormat, { attachmentFormat: string; label: string }> = {
  pdf: { attachmentFormat: 'pdf', label: 'PDF' },
  chart: { attachmentFormat: 'chart', label: 'Chart' },
  spreadsheet: { attachmentFormat: 'spreadsheet', label: 'Spreadsheet' },
};

export {
  generateFile,
  generateImage,
  generatePdf,
  generateChart,
  generateSpreadsheet,
  slugify,
  FORMAT_METADATA,
  type FileFormat,
  type GeneratedFile,
  type Attachment,
};
