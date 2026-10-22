<!-- hero:start -->
# Listen-Fire

**Customer-facing automations for your product, without building the engine.**

Every SaaS product eventually needs "when this happens in your workspace, do that", and most build a workflow engine from scratch to get it. Listen-Fire is that engine as a package: it runs inside your own Node process as WebAssembly, treats your product as one more system a program can read and write, and lets your customers (or their agents) write automations in a small, checkable language. Programs can pause for a person and resume days later, and the engine asks your host for everything it touches, so nothing leaves your tenant boundary.

- **For:** product teams who want customer-defined automations in their SaaS without owning a scheduler, a run store and a language.
- **Replaces:** a home-grown rules engine, or a per-event call to a model. A checked program is predictable, cheap to run, and the same for every tenant.
- **Proves it:** a small HTTP app where a customer saves a program, the app checks it against that customer's own data model, and the app's own event runs it. The example ships in the repository with an end-to-end test.
<!-- hero:end -->

## Notes for the test

- Claim under test: an embeddable engine is the fastest way to ship customer-facing automation in a product.
- The reader should be able to say back: "I npm install it, define my product as a module, and my customers write automations that run in my process."
- Watch for: readers who assume it needs a hosted service or a network of its own. It does not; the engine runs in-process and is handed its host.
