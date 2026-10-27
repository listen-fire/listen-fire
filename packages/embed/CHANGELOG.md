# @listen-fire/embed

## 0.12.8

### Patch Changes

- 1e44cfd: A new package, `@listen-fire/embed`: the engine embedded in another product's process as one host. `createEmbeddedHost({ modules, store?, secrets?, engine?, limits?, now?, moduleHost? })` connects a tenant's modules under the names its movements import (`connect(tenant, { name, module, credential })`, each module loaded in process over that tenant's credential); `save` checks a movement against the tenant's catalog, built from its connections and kept until they change or `schemaChanged(tenant)` is called; `dispatch(tenant, { adapterType, connection?, event })` runs every listen that hears the event, narrowed by connection as `lf` routes; `tick(now?)` steps on parked runs whose timer is due. `run(tenant, { program, text? })` runs one program now: every `listen to manual` it declares fires, `text` its Invocation's `Text`; the run host's `manual` unit is in every tenant's catalog, as `lf` builds it in, unless a module of that adapter type replaces it. Its store (connections, saved movements, run records, the run host's store) and its vault are the embedder's, in memory by default. It takes `@listen-fire/engine` as a peer (`>=0.12.0 <1.0.0`). This is the package's first release: `changeset version` takes it from 0.12.7 to 0.12.8.
