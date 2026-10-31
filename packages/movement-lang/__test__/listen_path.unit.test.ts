import type { ListenDeclaration } from '../parser/ast';
import { parseProgram } from '../parser/parse';

function listenOf(source: string): ListenDeclaration {
  const [statement] = parseProgram(source).statements;
  if (statement?.kind !== 'listen') throw new Error(`not a listen: ${JSON.stringify(statement)}`);
  return statement;
}

describe('a listen on a traversal', () => {
  it('carries the traversal as its path, rooted at its instance', () => {
    const listen = listenOf('listen to chat-[:Channels]->-[m:Messages WHERE m.Topic == "lunch-poll"]->-[:Interactions]-> fire countVote\n');
    expect(listen).toMatchObject({
      instance: 'chat',
      config: [],
      movement: 'countVote',
      path: { root: { kind: 'name', name: 'chat' }, hopsRaw: '-[:Channels]->-[m:Messages WHERE m.Topic == "lunch-poll"]->-[:Interactions]->' },
    });
  });

  it('carries the type it states its untyped landing is', () => {
    const listen = listenOf('listen to hooks-[:Requests]-><Payment> fire paid\n');
    expect(listen).toMatchObject({ path: { hopsRaw: '-[:Requests]->' }, landing: { graph: 'Payment' }, movement: 'paid' });
    expect(listenOf('listen to hooks-[:Requests]-> fire paid\n')).not.toHaveProperty('landing');
  });

  it('keeps its alias', () => {
    expect(listenOf('listen as "Lunch" to chat-[:Channels]-> fire f\n')).toMatchObject({ alias: 'Lunch', path: { hopsRaw: '-[:Channels]->' } });
  });

  it('the settings form has no path', () => {
    const listen = listenOf('listen to crm { events: ["company.created"] } fire f\n');
    expect(listen).not.toHaveProperty('path');
    expect(listen.config).toHaveLength(1);
    expect(listenOf('listen to manual fire f\n')).not.toHaveProperty('path');
  });
});
