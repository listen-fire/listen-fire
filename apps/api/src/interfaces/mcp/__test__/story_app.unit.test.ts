import { lookupStoryToken } from '../../../services/translation_graph/movement/story_token';
import { servedStoryView } from '../../../services/translation_graph/movement/story_view';
import { APP_HTML, storyApp, storyAppData } from '../story_app';

jest.mock('../../../services/translation_graph/movement/story_token', () => ({
  lookupStoryToken: jest.fn(),
}));
jest.mock('../../../services/translation_graph/movement/story_view', () => ({
  servedStoryView: jest.fn(),
}));

const looksUp = lookupStoryToken as jest.MockedFunction<typeof lookupStoryToken>;
const projects = servedStoryView as jest.MockedFunction<typeof servedStoryView>;

const view = { movement: { id: 'mov_1', name: 'Deal intake', validity: null } } as never;

const result = (body: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(body) }],
});

describe('the story handed to the in-chat view', () => {
  beforeEach(() => {
    looksUp.mockResolvedValue({ teamId: 'team_1', movementId: 'mov_1' });
    projects.mockResolvedValue({ ok: true, view });
  });

  it('draws the automation the tool just returned', async () => {
    const data = await storyAppData(
      result({ id: 'mov_1', name: 'Deal intake', storyUrl: 'https://api.example.com/api/story/story_abc' }),
    );

    // The link's token is what names the movement — so the picture in the
    // chat and the picture behind the link cannot be of different things.
    expect(looksUp).toHaveBeenCalledWith('story_abc');
    expect(projects).toHaveBeenCalledWith({ teamId: 'team_1', id: 'mov_1' });
    expect(data).toEqual({ 'dev.listen-fire/story': view });
  });

  it('draws nothing when the automation has no link', async () => {
    expect(await storyAppData(result({ id: 'mov_1', name: 'Deal intake' }))).toBeUndefined();
    expect(looksUp).not.toHaveBeenCalled();
  });

  it('draws nothing when the tool answered with something else', async () => {
    expect(await storyAppData({ content: [{ type: 'text', text: 'not json' }] })).toBeUndefined();
    expect(await storyAppData({ content: [] })).toBeUndefined();
  });

  it('draws nothing for a link that no longer stands for anything', async () => {
    looksUp.mockResolvedValue(null);
    expect(await storyAppData(result({ storyUrl: 'https://api.example.com/api/story/story_gone' }))).toBeUndefined();
  });

  it('draws nothing for a program we could not read', async () => {
    projects.mockResolvedValue({
      ok: false,
      reason: 'unreadable',
      movement: { id: 'mov_1', name: 'Deal intake' },
      problems: [],
    });
    expect(await storyAppData(result({ storyUrl: 'https://api.example.com/api/story/story_abc' }))).toBeUndefined();
  });
});

describe('the view itself', () => {
  it('is the single file the bundler emits beside the link page', () => {
    expect(APP_HTML.endsWith('public/story/app.html')).toBe(true);
  });

  it('is nominated under the extension’s ui:// scheme', () => {
    expect(storyApp.resourceUri).toBe('ui://listen-fire/automation-story');
  });
});
