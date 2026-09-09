import { Request, Response } from 'express';

interface SlackConnector {
  generateInstallUrl(): Promise<string>;
  handleCallback(request: Request, response: Response): Promise<void>;
  getConfigurer(token: string, baseUrl?: string): Promise<SlackConfigurer>;
}

interface SlackConfigurer {
  listChannels(args: {
    token: string;
    search?: string;
    teamId?: string;
  }): Promise<{ type: 'private' | 'public'; name: string; id: string }[]>;
  addBotToChannel(args: { token: string; conversationId: string }): Promise<void>;
}

export { SlackConnector, SlackConfigurer };
