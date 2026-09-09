// Barrel — public surface of the transform registry. R7 will import
// from here to register the ported plugins; the evaluator (R1) and
// the editor's transform inspector (wave-2 E3) consume the lookup
// helpers.
//
// Importing this module is intentionally side-effect-free at the
// registry level — the registry starts empty and is populated by
// callers (R7's plugin-port module) at boot. Keeping registration
// out of this barrel avoids hidden initialisation order surprises.

export {
  registerTransform,
  getTransform,
  listTransforms,
  _resetTransformRegistry,
} from './registry';

export type {
  TransformImpl,
  TransformInput,
  TransformOutput,
  PreExtractionInput,
  ContextDependentInput,
  EphemeralEmission,
  PluginManifest,
} from './registry';
