//! Lexical addresses (packages/movement-engine/services/movement_engine/address.ts): the
//! path of steps from the movement body's root to a statement, encoded as
//! the text a park keys on (`s1.i0.s0.b0.s0`).
//!
//! - `s i`: the i-th statement of the current sequence;
//! - `i j`: a fan-out body's iteration j (a traversal block's j-th landing);
//! - `b k`: an `if` arm (or, later, a parallel branch) k;
//! - `c k`: what runs inside a statement's k-th call (a callee's body).
//!
//! A `suspendAt` naming a `c` step is refused at admission: a statement is
//! re-run by a journal of its finished calls, which this engine keeps none of.

use std::fmt::Write;
use std::rc::Rc;

/// A lexical address: `s1.b0.s2`.
///
/// Each step shares the address it extends: an address grows with the calls
/// nested above it, and a run holds one for every statement it has open, so
/// copies of the steps would make memory quadratic in the call depth.
#[derive(Clone, Default)]
pub struct Address(Option<Rc<Step>>);

struct Step {
    parent: Address,
    kind: char,
    index: usize,
}

impl Address {
    /// `childStmt`.
    pub fn stmt(&self, index: usize) -> Address {
        self.child('s', index)
    }

    /// `childBranch`.
    pub fn branch(&self, index: usize) -> Address {
        self.child('b', index)
    }

    /// `childIter`: a fan-out iteration, positional in the order its head
    /// yielded the landings.
    pub fn iter(&self, index: usize) -> Address {
        self.child('i', index)
    }

    /// `childCall`: what runs inside a statement's k-th call.
    pub fn call(&self, index: usize) -> Address {
        self.child('c', index)
    }

    fn child(&self, kind: char, index: usize) -> Address {
        Address(Some(Rc::new(Step { parent: self.clone(), kind, index })))
    }

    /// The steps from the last to the first.
    fn steps(&self) -> impl Iterator<Item = &Step> {
        std::iter::successors(self.0.as_deref(), |step| step.parent.0.as_deref())
    }

    /// `parseAddress`, `None` for a text that does not read.
    pub fn parse(text: &str) -> Option<Address> {
        if text.is_empty() {
            return Some(Address::default());
        }
        text.split('.').try_fold(Address::default(), |address, step| {
            let mut chars = step.chars();
            let kind = chars.next()?;
            let digits = chars.as_str();
            (matches!(kind, 's' | 'b' | 'i' | 'c') && !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then(|| digits.parse().ok().map(|index| address.child(kind, index)))?
        })
    }

    /// `encodeAddress`.
    pub fn encode(&self) -> String {
        let mut steps: Vec<&Step> = self.steps().collect();
        steps.reverse();
        let mut text = String::with_capacity(steps.len() * 3);
        for (position, step) in steps.iter().enumerate() {
            if position > 0 {
                text.push('.');
            }
            text.push(step.kind);
            write!(text, "{}", step.index).expect("a String takes any write");
        }
        text
    }
}

impl PartialEq for Address {
    fn eq(&self, other: &Address) -> bool {
        let mut theirs = other.steps();
        for mine in self.steps() {
            let Some(step) = theirs.next() else { return false };
            if (mine.kind, mine.index) != (step.kind, step.index) {
                return false;
            }
            // From a shared step back they are one address.
            if let (Some(mine), Some(step)) = (&mine.parent.0, &step.parent.0)
                && Rc::ptr_eq(mine, step)
            {
                return true;
            }
        }
        theirs.next().is_none()
    }
}

impl Eq for Address {}

impl std::fmt::Debug for Address {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Address({})", self.encode())
    }
}

// Unlinked a step at a time: the steps a run's last holder lets go of can be
// as many as the calls it nested, too many for a drop that recurses.
impl Drop for Address {
    fn drop(&mut self) {
        let mut next = self.0.take();
        while let Some(mut step) = next.and_then(Rc::into_inner) {
            next = step.parent.0.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_encode_as_address_ts_does() {
        let root = Address::default();
        assert_eq!(root.encode(), "");
        assert_eq!(root.stmt(1).branch(0).stmt(2).encode(), "s1.b0.s2");
        assert_eq!(root.stmt(1).iter(0).stmt(0).branch(0).stmt(0).encode(), "s1.i0.s0.b0.s0");
        // A nested block's iteration, inside its enclosing block's.
        assert_eq!(root.stmt(1).iter(2).stmt(3).iter(0).stmt(1).encode(), "s1.i2.s3.i0.s1");
    }

    #[test]
    fn an_address_reads_back_and_equals_by_its_steps() {
        let written = Address::default().stmt(1).call(0).stmt(2);
        assert_eq!(Address::parse("s1.c0.s2"), Some(written.clone()));
        assert_eq!(Address::parse(""), Some(Address::default()));
        assert_eq!(Address::parse("s1.x0"), None);
        assert_ne!(written, Address::default().stmt(1).call(0));
        assert_ne!(written, Address::default().call(0).stmt(2));
        assert_ne!(Address::default(), written);
    }

    /// As long as a run could make one, with no one left holding its steps.
    #[test]
    fn the_longest_address_is_let_go_of_a_step_at_a_time() {
        let mut address = Address::default();
        for index in 0..2_000_000 {
            address = address.stmt(index);
        }
        drop(address);
    }
}
