import { z } from 'zod';

import PipelineInputType from '../../../generated/kysely/public/PipelineInputType';

// -- Input field schema: defines available metadata fields per channel type --

type InputFieldDef = {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean';
  source: 'channel' | 'config' | 'universal';
};

const UNIVERSAL_FIELDS: InputFieldDef[] = [
  { key: 'current_user_name', label: 'Current User Name', type: 'string', source: 'universal' },
  { key: 'current_user_email', label: 'Current User Email', type: 'string', source: 'universal' },
  { key: 'current_timestamp', label: 'Current Timestamp', type: 'string', source: 'universal' },
  { key: 'current_date', label: 'Current Date', type: 'string', source: 'universal' },
  { key: 'input_channel_name', label: 'Input Channel Name', type: 'string', source: 'universal' },
];

const MAILGUN_FIELDS: InputFieldDef[] = [
  { key: 'from_address', label: 'From Address', type: 'string', source: 'channel' },
  { key: 'to_address', label: 'To Address', type: 'string', source: 'channel' },
  { key: 'subject', label: 'Subject', type: 'string', source: 'channel' },
  { key: 'thread_id', label: 'Thread ID', type: 'string', source: 'channel' },
  { key: 'recipients', label: 'All Recipients', type: 'string', source: 'channel' },
];

const GMAIL_FIELDS: InputFieldDef[] = [
  { key: 'from_address', label: 'From Address', type: 'string', source: 'channel' },
  { key: 'to_address', label: 'To Address', type: 'string', source: 'channel' },
  { key: 'subject', label: 'Subject', type: 'string', source: 'channel' },
  { key: 'thread_id', label: 'Thread ID', type: 'string', source: 'channel' },
  { key: 'recipients', label: 'All Recipients', type: 'string', source: 'channel' },
];

const GRANOLA_FIELDS: InputFieldDef[] = [
  { key: 'meeting_title', label: 'Meeting Title', type: 'string', source: 'channel' },
  { key: 'organizer_email', label: 'Organizer Email', type: 'string', source: 'channel' },
  { key: 'attendee_emails', label: 'Attendee Emails', type: 'string', source: 'channel' },
  { key: 'attendee_names', label: 'Attendee Names', type: 'string', source: 'channel' },
  { key: 'scheduled_start', label: 'Scheduled Start', type: 'string', source: 'channel' },
  { key: 'scheduled_end', label: 'Scheduled End', type: 'string', source: 'channel' },
  { key: 'folder_names', label: 'Folder Names', type: 'string', source: 'channel' },
  { key: 'note_owner_email', label: 'Note Owner Email', type: 'string', source: 'channel' },
  { key: 'note_owner_name', label: 'Note Owner Name', type: 'string', source: 'channel' },
  { key: 'granola_note_id', label: 'Granola Note ID', type: 'string', source: 'channel' },
];

const INPUT_FIELD_SCHEMAS: Partial<Record<PipelineInputType, InputFieldDef[]>> = {
  [PipelineInputType.MAILGUN]: MAILGUN_FIELDS,
  [PipelineInputType.INBOUND_EMAIL]: MAILGUN_FIELDS,
  [PipelineInputType.CUSTOM_EMAIL]: [
    ...MAILGUN_FIELDS,
    { key: 'email_key', label: 'Email Key', type: 'string', source: 'config' },
  ],
  [PipelineInputType.GMAIL]: GMAIL_FIELDS,
  [PipelineInputType.GRANOLA]: GRANOLA_FIELDS,
  [PipelineInputType.SLACK]: [
    { key: 'channel_id', label: 'Channel ID', type: 'string', source: 'channel' },
    { key: 'channel_name', label: 'Channel Name', type: 'string', source: 'channel' },
    { key: 'user_id', label: 'User ID', type: 'string', source: 'channel' },
    { key: 'thread_ts', label: 'Thread Timestamp', type: 'string', source: 'channel' },
  ],
  [PipelineInputType.TWILIO]: [
    { key: 'from_number', label: 'From Number', type: 'string', source: 'channel' },
    { key: 'profile_name', label: 'Profile Name', type: 'string', source: 'channel' },
  ],
  [PipelineInputType.INBOUND_WHATSAPP]: [
    { key: 'from_number', label: 'From Number', type: 'string', source: 'channel' },
    { key: 'profile_name', label: 'Profile Name', type: 'string', source: 'channel' },
  ],
};

function getInputFieldSchema(type: PipelineInputType): InputFieldDef[] {
  return [...UNIVERSAL_FIELDS, ...(INPUT_FIELD_SCHEMAS[type] ?? [])];
}

// -- Input property mapping: maps input metadata → message node properties --

const inputMappingSourceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('property'), fieldKey: z.string() }),
  z.object({ mode: z.literal('static'), value: z.string() }),
  z.object({ mode: z.literal('llm'), prompt: z.string() }),
]);

const inputTraversalStepSchema = z.object({
  edgeTypeId: z.string(),
});

type InputTraversalStep = z.infer<typeof inputTraversalStepSchema>;

const inputPropertyMappingSchema = z.object({
  source: inputMappingSourceSchema,
  traversal: z.array(inputTraversalStepSchema).default([]),
  targetPropertyTypeId: z.string(),
});

type InputMappingSource = z.infer<typeof inputMappingSourceSchema>;
type InputPropertyMapping = z.infer<typeof inputPropertyMappingSchema>;
type InputMetadata = Record<string, string | number | boolean>;

// -- Lightweight metadata extraction from stored payload data --
// Used by the knowledge pipeline to extract metadata without instantiating the full adapter.

type PayloadData = Record<string, unknown>;

function getString(data: PayloadData, key: string): string | undefined {
  const v = data[key];
  return typeof v === 'string' ? v : undefined;
}

const MAILGUN_EXTRACTOR = (data: PayloadData): InputMetadata => {
  const metadata: InputMetadata = {};
  const sender = getString(data, 'sender');
  if (sender) metadata.from_address = sender;
  const recipient = getString(data, 'recipient');
  if (recipient) metadata.to_address = recipient;
  const subject = getString(data, 'subject');
  if (subject) metadata.subject = subject;
  const refs = getString(data, 'References');
  if (refs) {
    metadata.thread_id = refs.split(' ')[0];
  } else {
    const messageId = getString(data, 'Message-Id');
    if (messageId) metadata.thread_id = messageId;
  }
  const recipients = [getString(data, 'To'), getString(data, 'Cc'), getString(data, 'Bcc')]
    .filter(Boolean)
    .join(', ');
  if (recipients) metadata.recipients = recipients;
  return metadata;
};

const SLACK_EXTRACTOR = (data: PayloadData): InputMetadata => {
  const metadata: InputMetadata = {};
  const event = data.event as PayloadData | undefined;
  if (event) {
    const channel = getString(event, 'channel');
    if (channel) metadata.channel_id = channel;
    const user = getString(event, 'user');
    if (user) metadata.user_id = user;
    const threadTs = getString(event, 'thread_ts');
    if (threadTs) metadata.thread_ts = threadTs;
  }
  return metadata;
};

const TWILIO_EXTRACTOR = (data: PayloadData): InputMetadata => {
  const metadata: InputMetadata = {};
  const from = getString(data, 'From');
  if (from) metadata.from_number = from;
  const profileName = getString(data, 'ProfileName');
  if (profileName) metadata.profile_name = profileName;
  return metadata;
};

const GMAIL_EXTRACTOR = (data: PayloadData): InputMetadata => {
  const metadata: InputMetadata = {};
  const sender = getString(data, 'sender');
  if (sender) metadata.from_address = sender;
  const recipient = getString(data, 'recipient');
  if (recipient) metadata.to_address = recipient;
  const subject = getString(data, 'subject');
  if (subject) metadata.subject = subject;
  const refs = getString(data, 'References');
  if (refs) {
    metadata.thread_id = refs.split(' ')[0];
  } else {
    const messageId = getString(data, 'Message-Id');
    if (messageId) metadata.thread_id = messageId;
  }
  const recipients = [getString(data, 'To'), getString(data, 'Cc'), getString(data, 'Bcc')]
    .filter(Boolean)
    .join(', ');
  if (recipients) metadata.recipients = recipients;
  return metadata;
};

const GRANOLA_EXTRACTOR = (data: PayloadData): InputMetadata => {
  const metadata: InputMetadata = {};
  const title = getString(data, 'meeting_title');
  if (title) metadata.meeting_title = title;
  const organizer = getString(data, 'organizer_email');
  if (organizer) metadata.organizer_email = organizer;
  const attendeeEmails = getString(data, 'attendee_emails');
  if (attendeeEmails) metadata.attendee_emails = attendeeEmails;
  const attendeeNames = getString(data, 'attendee_names');
  if (attendeeNames) metadata.attendee_names = attendeeNames;
  const scheduledStart = getString(data, 'scheduled_start');
  if (scheduledStart) metadata.scheduled_start = scheduledStart;
  const scheduledEnd = getString(data, 'scheduled_end');
  if (scheduledEnd) metadata.scheduled_end = scheduledEnd;
  const folderNames = getString(data, 'folder_names');
  if (folderNames) metadata.folder_names = folderNames;
  const ownerEmail = getString(data, 'note_owner_email');
  if (ownerEmail) metadata.note_owner_email = ownerEmail;
  const ownerName = getString(data, 'note_owner_name');
  if (ownerName) metadata.note_owner_name = ownerName;
  const noteId = getString(data, 'granola_note_id');
  if (noteId) metadata.granola_note_id = noteId;
  return metadata;
};

const PAYLOAD_EXTRACTORS: Partial<Record<PipelineInputType, (data: PayloadData) => InputMetadata>> =
  {
    [PipelineInputType.MAILGUN]: MAILGUN_EXTRACTOR,
    [PipelineInputType.INBOUND_EMAIL]: MAILGUN_EXTRACTOR,
    [PipelineInputType.CUSTOM_EMAIL]: MAILGUN_EXTRACTOR,
    [PipelineInputType.GMAIL]: GMAIL_EXTRACTOR,
    [PipelineInputType.SLACK]: SLACK_EXTRACTOR,
    [PipelineInputType.TWILIO]: TWILIO_EXTRACTOR,
    [PipelineInputType.INBOUND_WHATSAPP]: TWILIO_EXTRACTOR,
    [PipelineInputType.GRANOLA]: GRANOLA_EXTRACTOR,
  };

type UniversalContext = {
  userName?: string;
  userEmail?: string;
  inputChannelName?: string;
};

function extractMetadataFromPayload(options: {
  inputType: PipelineInputType;
  payloadData: unknown;
  config: Record<string, unknown>;
  universalContext?: UniversalContext;
}): InputMetadata {
  const { inputType, payloadData, config, universalContext } = options;
  const extractor = PAYLOAD_EXTRACTORS[inputType];
  const channelMetadata = extractor ? extractor(payloadData as PayloadData) : {};

  // Merge config-sourced fields
  const fieldSchema = INPUT_FIELD_SCHEMAS[inputType] ?? [];
  const configMetadata: InputMetadata = {};
  for (const field of fieldSchema) {
    if (field.source === 'config') {
      const v = config[field.key];
      if (v !== undefined && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
        configMetadata[field.key] = v;
      }
    }
  }

  // Universal fields
  const now = new Date();
  const universal: InputMetadata = {
    current_timestamp: now.toISOString(),
    current_date: now.toISOString().slice(0, 10),
  };
  if (universalContext?.userName) universal.current_user_name = universalContext.userName;
  if (universalContext?.userEmail) universal.current_user_email = universalContext.userEmail;
  if (universalContext?.inputChannelName) universal.input_channel_name = universalContext.inputChannelName;

  return { ...universal, ...channelMetadata, ...configMetadata };
}

export {
  InputFieldDef,
  InputMappingSource,
  InputTraversalStep,
  InputPropertyMapping,
  InputMetadata,
  UniversalContext,
  inputMappingSourceSchema,
  inputTraversalStepSchema,
  inputPropertyMappingSchema,
  getInputFieldSchema,
  extractMetadataFromPayload,
  INPUT_FIELD_SCHEMAS,
};
