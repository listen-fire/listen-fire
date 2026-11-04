//! Enough stack for however deep a movement's calls nest.
//!
//! The engine is async, and awaiting is polling: every future polls the one
//! it awaits, so a poll runs down the whole chain of calls a movement has
//! open, on the stack of whichever thread drives the segment. How much stack
//! one call takes depends on the program and the build, so no stack fixed
//! ahead of time holds what the call depth limit allows. So what a movement's
//! recursion passes through runs on more stack when too little is left, and
//! the limit alone decides how deep a run goes (the limit bounds the memory:
//! docs/contracts/run-limits.md).
//!
//! WASM has no stack to switch to, and each of these is what it wraps, adding
//! no frame of its own: a value walked there is held to V8's stack as well as
//! its own. Running low on the stack it has ends the run instead (`stack_is_low`).

use std::future::Future;
use std::pin::Pin;

/// A future the program's calls or its text decide how deeply it nests.
pub(crate) type Deep<'s, T> = Pin<Box<dyn Future<Output = T> + 's>>;

/// What a statement may count on being left of the shadow stack, whatever the
/// program: until the next statement or call asks again it runs at most one
/// statement's own expressions, which the parser bounds, the parser itself at
/// its depth limit among them (`scripts/build-movement-wasm.sh`, which adds this
/// to the stack so a run that fitted before still does).
#[cfg(target_arch = "wasm32")]
const STACK_MARGIN: usize = 1024 * 1024;

/// Whether what is left of the stack is under the margin. The shadow stack
/// comes first in linear memory (`--stack-first`) and grows down towards zero,
/// so a local's address is what is left.
#[cfg(target_arch = "wasm32")]
pub(crate) fn stack_is_low() -> bool {
    let here = 0u8;
    (std::hint::black_box(&here) as *const u8 as usize) < STACK_MARGIN
}

/// The native engine runs on more stack instead (`deep`).
#[cfg(not(target_arch = "wasm32"))]
#[inline(always)]
pub(crate) fn stack_is_low() -> bool {
    false
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn deep<'s, T>(future: impl Future<Output = T> + 's) -> Deep<'s, T> {
    Box::pin(future)
}

/// One step of a walk down a value, which the program decides the depth of.
#[cfg(target_arch = "wasm32")]
#[inline(always)]
pub(crate) fn walking<R>(step: impl FnOnce() -> R) -> R {
    step()
}

/// `work` with room for what the program's text bounds, and for a value on the
/// wire at its deepest: what a host does with a segment's step.
#[cfg(target_arch = "wasm32")]
#[inline(always)]
pub fn with_room<R>(work: impl FnOnce() -> R) -> R {
    work()
}

#[cfg(not(target_arch = "wasm32"))]
pub use native::with_room;
#[cfg(not(target_arch = "wasm32"))]
pub(crate) use native::{deep, walking};

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use super::Deep;

    /// What a future may count on being left: a poll does synchronous work
    /// that only the program's text bounds, the deepest of it the parser at
    /// its depth limit (`check` on the deepest text takes 2 MiB of stack in a
    /// release build and 8 MiB in a debug one, measured 2026-11-04). A value at
    /// `MAX_WIRE_NESTING`, written out, takes less again.
    const RED_ZONE: usize = if cfg!(debug_assertions) { 16 * 1024 * 1024 } else { 4 * 1024 * 1024 };

    /// Address space, touched only as far as it is used: larger than the red
    /// zone so that a stack holds more than one call.
    const SEGMENT: usize = 4 * RED_ZONE;

    /// A walk's step is one small frame, so a walk stays on the stack it found
    /// until that is nearly gone: it is run for every value a segment holds.
    const WALK_RED_ZONE: usize = 256 * 1024;

    pub(crate) fn walking<R>(step: impl FnOnce() -> R) -> R {
        stacker::maybe_grow(WALK_RED_ZONE, SEGMENT, step)
    }

    pub fn with_room<R>(work: impl FnOnce() -> R) -> R {
        stacker::maybe_grow(RED_ZONE, SEGMENT, work)
    }

    struct OnEnoughStack<F: Future> {
        // Boxed, so this is Unpin, and taken out to be dropped, so what it
        // holds is let go of on the stack this chooses: a run ended early
        // drops every call it has open, one inside the other.
        future: Option<Pin<Box<F>>>,
    }

    impl<F: Future> Future for OnEnoughStack<F> {
        type Output = F::Output;

        fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<F::Output> {
            let future = self.get_mut().future.as_mut().expect("only a drop takes the future, and nothing polls after it");
            with_room(|| future.as_mut().poll(cx))
        }
    }

    impl<F: Future> Drop for OnEnoughStack<F> {
        fn drop(&mut self) {
            let future = self.future.take();
            walking(|| drop(future));
        }
    }

    pub(crate) fn deep<'s, T>(future: impl Future<Output = T> + 's) -> Deep<'s, T> {
        Box::pin(OnEnoughStack { future: Some(Box::pin(future)) })
    }
}

/// What a test of a walker needs: a value nested far past what the stack it
/// runs on holds, so that a walk with no stack to ask for ends the whole test
/// process rather than failing one test.
#[cfg(all(test, not(target_arch = "wasm32")))]
pub(crate) mod testing {
    use crate::js::Js;

    /// More levels than a stack of `SMALL_STACK` holds at any frame size a
    /// walk could have (a frame is 16 bytes at the least).
    pub(crate) const LEVELS: usize = 20_000;
    const SMALL_STACK: usize = 256 * 1024;

    /// `work` on a thread of its own with a small stack, which is the stack a
    /// walk would run on were it called from deep inside a run.
    pub(crate) fn on_a_small_stack<R: Send + 'static>(work: impl FnOnce() -> R + Send + 'static) -> R {
        std::thread::Builder::new().stack_size(SMALL_STACK).spawn(work).expect("a thread").join().expect("the walk finished")
    }

    /// `leaf` wrapped in a list, `LEVELS` times.
    pub(crate) fn nested_lists(leaf: Js) -> Js {
        (0..LEVELS).fold(leaf, |inside, _| Js::array(vec![inside]))
    }

    /// `leaf` wrapped in a map, `LEVELS` times.
    pub(crate) fn nested_maps(leaf: Js) -> Js {
        (0..LEVELS).fold(leaf, |inside, _| crate::env::object_of(vec![("v", inside)]))
    }
}
