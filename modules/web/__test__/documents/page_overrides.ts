// The browser slot with some of its pages' methods answered by the test, for
// what the scripted page cannot show on its own: a page whose `load` event
// never comes, a redirect, a page that runs script.

import type { BrowserPage, BrowserSlot } from 'movement-engine/public/browser';

/** `slot`, every page it opens answering `overrides(page)` in place of its own. */
export function overridingPages(slot: BrowserSlot, overrides: (page: BrowserPage) => Partial<BrowserPage>): BrowserSlot {
  return {
    module: slot.module,
    withPage: (fn, options) => slot.withPage((page, session) => fn(overriding(page, overrides(page)), session), options),
  };
}

function overriding(page: BrowserPage, own: Partial<BrowserPage>): BrowserPage {
  return new Proxy(page, {
    get(target, property) {
      if (property in own) return Reflect.get(own, property);
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const LOAD_NEVER_CAME = (): Promise<never> => Promise.reject(new Error('Timeout 30000ms exceeded (waiting for "load")'));

/** A page whose DOM arrives but whose `load` event never does (a tracker
 *  holding it): a navigation or a wait for `load` times out. What each
 *  navigation waited for is kept in `waitedFor`. */
export function loadNeverFires(slot: BrowserSlot): { slot: BrowserSlot; waitedFor: Array<string | undefined> } {
  const waitedFor: Array<string | undefined> = [];
  return {
    waitedFor,
    slot: overridingPages(slot, (page) => ({
      goto: async (url, options) => {
        waitedFor.push(options?.waitUntil);
        if (options?.waitUntil !== 'domcontentloaded' && options?.waitUntil !== 'commit') return LOAD_NEVER_CAME();
        return page.goto(url, options);
      },
      waitForLoadState: async (state, options) => {
        if (state === 'domcontentloaded') return page.waitForLoadState(state, options);
        return LOAD_NEVER_CAME();
      },
    })),
  };
}
