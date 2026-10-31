// The listens a host routes deliveries to, read off a program's source.

import { ENGINE_VERSION, parsePinned } from '../../../../public/movement-engine';
import { collectFileListeners } from '../file_listeners';

describe('collectFileListeners', () => {
  it('routes a settings listen, and not a listen on a traversal as one on its root', () => {
    const source = [
      'import { chat } from adapters',
      'slack = connect chat',
      'function count_vote(i: <slack-[:Interaction]->>) {',
      '  return i',
      '}',
      'listen to slack-[:Channels]->-[:Messages]->-[:Interactions]-> fire count_vote',
      'listen to slack {} fire count_vote',
      '',
    ].join('\n');
    const listeners = collectFileListeners(parsePinned({ source, languageVersion: ENGINE_VERSION }));
    expect(listeners).toEqual([{ instanceName: 'slack', adapter: 'chat', config: {}, movementName: 'count_vote' }]);
  });
});
