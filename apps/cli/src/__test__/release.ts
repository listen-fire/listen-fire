// The release the binary under test is: the one version every crate and
// package carries, so a test that means "this release" follows it and never
// goes stale at a release bump.

import { LANGUAGE_VERSION } from '../../../../packages/movement-lang/language_version';

export const RELEASE: string = LANGUAGE_VERSION;

/** The release as a regular expression's text. */
export const RELEASE_RE: string = RELEASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
