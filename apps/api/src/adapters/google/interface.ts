import { Request, Response } from 'express';
import z from 'zod';

import { GoogleAuthClient, googleCredsParser } from './authClient';
import { TableInfo } from '../googleSheets/apiClient';

interface GoogleConnector {
  authClient: GoogleAuthClient;
  handleCallback(request: Request, response: Response): Promise<void>;
  generateInstallUrl(): Promise<string>;
  listSheets({
    spreadsheetId,
    id,
    credentials,
  }: {
    spreadsheetId: string;
    id: string;
    credentials: z.infer<typeof googleCredsParser>;
  }): Promise<{ name: string; id: number }[]>;
  listTables({
    spreadsheetId,
    id,
    credentials,
  }: {
    spreadsheetId: string;
    id: string;
    credentials: z.infer<typeof googleCredsParser>;
  }): Promise<TableInfo[]>;
}

interface GoogleConfigurer {}

export { GoogleConnector, GoogleConfigurer };
