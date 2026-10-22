<!-- hero:start -->
# Listen-Fire

**Customer automations for your product, without building the engine.**

Today "when this happens in my workspace, do that" is the feature your customers keep asking for, and the honest answer is a rules engine you would have to build, run and keep up yourself.

With Listen-Fire the engine is a package. It runs inside your own Node process, sees your product as one more system a program can read and write, and lets each customer, or their agent, write automations in a short language that is checked against that customer's own data before it runs. Your code answers its requests for data, AI, the clock and storage, so nothing leaves your tenant boundary, and a paused run is a value you keep wherever you keep state.

- **For:** product teams who want customer-defined automations in their SaaS without owning a scheduler, a run store and a language.
- **Replaces:** a home-grown rules engine, or a model call per event.
- **Proves it:** a small HTTP app in the repository where a customer saves a program, the app checks it against that customer's data model, and the app's own event runs it, with an end-to-end test.
<!-- hero:end -->

## Notes for the test

- Claim under test: an embeddable engine is the fastest way to ship customer-facing automation in a product.
- The reader should be able to say back: "I npm install it, define my product as a module, and my customers write automations that run in my process."
- Watch for: readers who assume it needs a hosted service or a network of its own. It does not; the engine runs in-process and is handed its host.
