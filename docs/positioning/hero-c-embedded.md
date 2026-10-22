<!-- hero:start -->
# Listen-Fire

**Customer automations for your product, without building the engine.**

Today "when this happens in my workspace, do that" is the feature your customers keep asking for, and the honest answer is a rules engine you would have to build, run and keep up yourself.

With Listen-Fire the engine is a package. It runs inside your own Node process. You describe your product once as a module, its records and the links between them, and each customer, or their agent, writes automations against it in a short language that is checked against that customer's own fields before it runs. Your code answers the engine's requests for data, AI, the clock and storage, so every run sees one tenant only and stops at the limits you set. A program can wait three days and then act; the waiting run is a value you store wherever you keep state.

- **For:** product teams who want customer-defined automations in their SaaS without owning a scheduler, a run store and a language.
- **Replaces:** a home-grown rules engine, or a model call per event.
- **Proves it:** a small HTTP app in the repository where a customer saves a program, the app checks it against that customer's data model, and the app's own event runs it, with an end-to-end test.
<!-- hero:end -->

## Notes for the test

- Claim under test: an embeddable engine is the fastest way to ship customer-facing automation in a product.
- The reader should be able to say back: "I npm install it, define my product as a module, and my customers write automations that run in my process."
- Watch for: readers who assume it needs a hosted service or a network of its own. It does not; the engine runs in-process and is handed its host.
