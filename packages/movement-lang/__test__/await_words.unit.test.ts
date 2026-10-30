import { AWAIT_ARRIVALS_WORD } from '../parser/await_words';
import { parseProgram } from '../parser/parse';

/** Every `await` source the parsed program holds, at any depth. */
function awaitSources(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(awaitSources);
  if (value === null || typeof value !== 'object') return [];
  const entries = Object.entries(value);
  const own = entries.flatMap(([key, child]) => (key === 'await' && child !== null && typeof child === 'object' && 'source' in child ? [child.source] : []));
  return [...own, ...entries.flatMap(([, child]) => awaitSources(child))];
}

describe('the word that makes a wait take only arrivals', () => {
  it("the TS word is the parser's", () => {
    const [source] = awaitSources(parseProgram(`f = () => { x = await ${AWAIT_ARRIVALS_WORD} d-[:Notes]-> }\n`));
    expect(source).toMatchObject({ kind: 'traversal', head: { root: { kind: 'name', name: 'd' }, hopsRaw: '-[:Notes]->' }, arrivalsOnly: true });
  });

  it('a plain await carries no arrivalsOnly', () => {
    const [source] = awaitSources(parseProgram('f = () => { x = await d-[:Notes]-> }\n'));
    expect(source).toMatchObject({ kind: 'traversal', head: { root: { kind: 'name', name: 'd' } } });
    expect(source).not.toHaveProperty('arrivalsOnly');
  });
});
