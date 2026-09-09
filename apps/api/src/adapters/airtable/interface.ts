import { Request, Response } from 'express';
import { z } from 'zod';

import { airtableCredsParser } from './apiClient';

type AirtableField = {
  id: string;
  name: string;
  type?:
    | 'singleLineText'
    | 'email'
    | 'url'
    | 'multilineText'
    | 'number'
    | 'percent'
    | 'currency'
    | 'singleSelect'
    | 'multipleSelects'
    | 'singleCollaborator'
    | 'multipleCollaborators'
    | 'multipleRecordLinks'
    | 'date'
    | 'dateTime'
    | 'phoneNumber'
    | 'multipleAttachments'
    | 'checkbox'
    | 'formula'
    | 'createdTime'
    | 'rollup'
    | 'count'
    | 'lookup'
    | 'multipleLookupValues'
    | 'autoNumber'
    | 'barcode'
    | 'rating'
    | 'richText'
    | 'duration'
    | 'lastModifiedTime'
    | 'button'
    | 'createdBy'
    | 'lastModifiedBy'
    | 'externalSyncSource'
    | 'aiText'
    | undefined;
  description?: string | undefined;
  options?: unknown;
};

interface AirtableConnector {
  authClient: {
    exchangeRefreshToken: (params: { refreshToken: string }) => Promise<{
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      refreshExpiresIn: number;
    }>;
  };
  handleCallback(request: Request, response: Response): Promise<void>;
  generateInstallUrl(): Promise<string>;
  getApiClient(id: string, creds: z.infer<typeof airtableCredsParser>): Promise<AirtableConfigurer>;
}

interface AirtableConfigurer {
  listBases(): Promise<{ id: string; name: string }[]>;
  listTables(args: { baseId: string }): Promise<
    {
      id: string;
      description?: string | undefined;
      primaryFieldId: string;
      name: string;
      fields: AirtableField[];
    }[]
  >;
}

export { AirtableConnector, AirtableConfigurer, AirtableField };
