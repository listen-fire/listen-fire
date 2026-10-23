// The limiter slot: a module's declared limits held across the calls it makes
// (`limitRequest`, then `limited` around the call), the slot a host fills
// (`installLimiter`), the in-process limiter a host starts from, and a
// vendor's rate-limit wait read (`vendorWaitMs`) and turned into a throttle on
// the caller's key (`throttleAfter`); a vendor's remaining budget on a success
// (`vendorBudget`) closes the key early once it is spent (`budgetAfter`).

export * from '../services/limiter/limiter';
