import { selectConnectUrlMutation } from '../connect-credential';

describe('selectConnectUrlMutation', () => {
  it('routes ATTIO to attioConnectUrl', () => {
    const mutate = jest.fn();
    const client = {
      views: { credentials: { attioConnectUrl: { mutate } } },
    } as any;
    const getUrl = selectConnectUrlMutation('ATTIO', client);
    expect(getUrl).toBeDefined();
  });

  it('returns undefined for a service with no OAuth flow', () => {
    expect(selectConnectUrlMutation('NOT_A_SERVICE', {} as any)).toBeUndefined();
  });
});
