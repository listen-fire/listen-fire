import { SlackConfigurer } from '../interface';
import { SlackAPIClient } from './apiClient';

class SlackWebApiConfigurer implements SlackConfigurer {
  private client: SlackAPIClient;

  constructor({ client }: { client: SlackAPIClient }) {
    this.client = client;
  }

  async addBotToChannel({ conversationId }: { conversationId: string }) {
    const info = await this.client.api.conversations.info({ channel: conversationId });
    if (!info.channel?.is_member) {
      await this.client.api.conversations.join({ channel: conversationId });
    }
  }

  async listChannels({ teamId }: { teamId?: string }) {
    const allChannels = [];
    let cursor = undefined;
    let nFetches = 0;

    while (nFetches < 1000) {
      const channels = await this.client.api.conversations.list({
        types: 'public_channel,private_channel',
        limit: 500,
        cursor,
        exclude_archived: true,
        team_id: teamId,
      });

      allChannels.push(...(channels.channels ?? []));
      nFetches++;

      if (!channels.response_metadata?.next_cursor) {
        break;
      } else {
        cursor = channels.response_metadata.next_cursor;
      }
    }

    return allChannels
      .map((channel) => ({
        type: channel.is_private ? 'private' : 'public',
        name: channel.name,
        id: channel.id,
      }))
      .filter(
        (channel): channel is { type: 'private' | 'public'; name: string; id: string } =>
          !!channel.name && !!channel.id,
      );
  }
}

export { SlackWebApiConfigurer };
