type DocumentOutput = { type: 'DOCUMENT'; documentId: string; extract?: boolean };

type DocumentWithContentOutput = {
  type: 'DOCUMENT_WITH_CONTENT';
  documentId: string;
  rawTextId: string;
};

type ChunkedTextOutput = { type: 'CHUNKED_TEXT'; rawTextId: string };

type UpdateSubmissionOutput = { type: 'UPDATE_SUBMISSION'; submissionId: string };

type PitchDeckUrlOutput = {
  type: 'PITCH_DECK_URL';
  url: string;
  password?: string;
  email?: string;
};

type WebsiteUrlOutput = { type: 'WEBSITE_URL'; url: string };

type DealTextOutput = { type: 'DEAL_TEXT'; rawTextId: string };

type GreetingOutput = { type: 'GREETING'; rawTextId: string; reply: string | null };

type EmptyOutput = { type: 'EMPTY' };

type InjectionOutput = { type: 'INJECTION'; rawTextId: string };

type TextOutput = { type: 'TEXT'; rawTextId: string };

type MaybeMultipleDealOutput = { type: 'MAYBE_MULTIPLE_DEAL_TEXT' } & (
  | { rawTextId: string }
  | { content: string }
);

type EmailAttachmentOutput = {
  type: 'EMAIL_ATTACHMENT';
  name?: string | null;
  size?: number | null;
  key: string;
};

type WhatsappAttachmentOutput = { type: 'WHATSAPP_ATTACHMENT'; url: string };

type ToolOutput =
  | DocumentOutput
  | DocumentWithContentOutput
  | ChunkedTextOutput
  | TextOutput
  | UpdateSubmissionOutput
  | PitchDeckUrlOutput
  | WebsiteUrlOutput
  | DealTextOutput
  | GreetingOutput
  | EmptyOutput
  | InjectionOutput
  | EmailAttachmentOutput
  | WhatsappAttachmentOutput
  | MaybeMultipleDealOutput;

type ToolType =
  | 'CLASSIFY_TEXT'
  | 'EXTRACT_DOCUMENT_TEXT'
  | 'PITCH_DECK_URL'
  | 'TEXT_SPLITTER'
  | 'UPDATE_SUBMISSION'
  | 'WEBSITE_URL'
  | 'RESEARCH_FOUNDER_SOCIALS'
  | 'PARSE_DEAL'
  | 'PARSE_INVESTOR_SPREADSHEET'
  | 'WHATSAPP_ATTACHMENT'
  | 'EMAIL_ATTACHMENT'
  | 'SPLIT_MULTIPLE_DEALS'
  | 'ADD_DOCUMENT_TO_DEAL'
  | 'ADD_DOCUMENT_TO_ROUND'
  | 'CLUSTER_COMPANIES'
  | 'PROCESS_COMPANY'
  | 'PROCESS_PERSON'
  | 'GATHER_COMPANY_TEXT'
  | 'PARSE_COMPANY_DISPLAY_DATA'
  | 'IDENTIFY_COMPANY_RELATED_ENTITIES'
  | 'GATHER_PERSON_TEXT'
  | 'PARSE_PERSON_DISPLAY_DATA'
  | 'IDENTIFY_PERSON_RELATED_ENTITIES'
  | 'IDENTIFY_SOURCES'
  | 'BUILD_PROFILES_FOR_COMPANY'
  | 'BUILD_PROFILES_FOR_PERSON'
  | 'BUILD_DEAL';

type Tool<T, U> = ((params: T) => Promise<U>) & {
  type: ToolType;
};

export {
  Tool,
  ToolOutput,
  DocumentOutput,
  DocumentWithContentOutput,
  PitchDeckUrlOutput,
  WebsiteUrlOutput,
  DealTextOutput,
  GreetingOutput,
  EmptyOutput,
  InjectionOutput,
  TextOutput,
};
