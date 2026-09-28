import { parseProgram, checkProgram, mockCatalog } from 'movement-lang';

const PROBE = `
import { manual, slack } from adapters
import { team_workspace } from credentials

runs = manual()
chat = slack(credentials: team_workspace)

type Thesis = <"Consumer" | "Infra" | "Health">

function \`Recap\`(go: <runs-[:Invocation]->>) {
  theses = MEMBERS(<Thesis>)
  before = 10
  after  = 4
  delta  = -(after - before)
  first  = AT(theses, 0)
  line   = IF EXISTS(first) THEN "\${first}" ELSE "" END

  ops = ONLY(chat-[ch:Channels WHERE \`Name\` == "ops"]->)
  if ops == null { ERROR("no #ops channel") }
  write ops-[:Messages]-> { Message: "\${JOIN(theses, ", ")} / \${line} / \${delta}" }
}

listen to runs {} fire \`Recap\`
`;

import adapterSchemas from './adapter_schemas.fixture.json';

it('debug parse', () => {
  const capturedSchemas = adapterSchemas.schemas as Record<string, unknown>;
  const capturedSpecs = adapterSchemas.specs as Record<string, unknown>;
  const catalog = mockCatalog({
    adapters: {
      manual: { ...(capturedSpecs.manual as object), schema: capturedSchemas.manual },
      slack: { ...(capturedSpecs.slack as object), schema: capturedSchemas.slack },
    } as never,
    credentials: { team_workspace: { adapter: 'slack' } },
  });
  const p = parseProgram(PROBE);
  const errors = checkProgram(p, catalog).filter((d) => (d.severity ?? 'error') === 'error');
  // eslint-disable-next-line no-console
  console.log('ERRORS', JSON.stringify(errors, null, 1));
  expect(true).toBe(true);
});
