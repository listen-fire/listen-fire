/**
 * The movement story renderer — ONE rendering, two mounts.
 *
 * The app's workbench panel and the standalone HTML page both draw a story out
 * of this package, so the picture a customer is handed on a link and the
 * picture its author sees while editing cannot drift apart.
 *
 * Everything here is adapter-blind: the components print labels, icons and
 * phrases that arrived inside the `StoryView`, and know nothing about which
 * systems exist. The server does the vocabulary join; this draws the result.
 *
 */

export * from './view';
export { FlowCanvas } from './flow-canvas';
export { ReferentsProvider } from './referents';
export { Banner, Problems, ValidityNotice } from './notices';
