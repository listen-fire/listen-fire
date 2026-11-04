//! Going too deep ends a run with `MOVENG_CALL_DEPTH`, whatever the limit and
//! whatever the recursion goes through, and never takes the process down
//! (docs/contracts/run-limits.md). Each test runs `listen-fire run` as its own
//! process, so the engine is on the main thread's stack, held to 8 MiB whatever
//! the shell that started the tests allows.
//!
//! `LF_BIN` names the binary to drive, as in apps/cli's tests. The limit of
//! 10,000 takes a release build twelve minutes, so it runs only on one: under
//! `cargo test --release`, or `LF_BIN=<a release build> cargo test --test
//! call_depth -- --ignored`.

use std::path::PathBuf;
use std::process::Command;

const MAIN_THREAD_STACK_KIB: usize = 8176;

fn binary() -> String {
    std::env::var("LF_BIN").unwrap_or_else(|_| env!("CARGO_BIN_EXE_listen-fire").to_string())
}

struct Project(PathBuf);

impl Project {
    fn new(movement: &str) -> Project {
        let root = std::env::temp_dir().join(format!("lf-call-depth-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&root);
        assert!(Command::new(binary()).arg("init").arg(&root).output().unwrap().status.success());
        std::fs::remove_file(root.join("movements/hello.mvt")).unwrap();
        std::fs::write(root.join("movements/b.mvt"), format!("{movement}\nlisten to manual-[:Invocations]-> fire b\n")).unwrap();
        Project(root)
    }

    /// The run's exit code (`None`: a signal ended it) and everything it said.
    fn run(&self, env: &[(&str, &str)]) -> (Option<i32>, String) {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(format!("ulimit -s {MAIN_THREAD_STACK_KIB} && exec \"$0\" run b --ephemeral"))
            .arg(binary())
            .current_dir(&self.0)
            .env_remove("MOVEMENT_MAX_CALL_DEPTH");
        command.envs(env.iter().copied());
        let out = command.output().unwrap();
        let said = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        (out.status.code(), said)
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn ended_at_the_limit(ran: (Option<i32>, String), limit: usize) {
    let (code, said) = ran;
    assert_eq!(code, Some(1), "the run should fail, not take the process down:\n{said}");
    assert!(said.contains("MOVENG_CALL_DEPTH"), "{said}");
    assert!(said.contains(&format!("is {limit}.")), "{said}");
}

const DOWN: &str = "function down(n: <number>): <number> {
  if (n <= 0) { return 0 }
  return 1 + down(n - 1)
}
";

fn recursion(depth: usize) -> String {
    format!("{DOWN}function b(run: <manual-[:Invocations]->>) {{ return down({depth}) }}")
}

#[test]
fn the_default_limit_is_reached_on_a_debug_build_too() {
    ended_at_the_limit(Project::new(&recursion(100_000)).run(&[]), 32);
}

#[test]
fn a_recursion_under_the_limit_finishes() {
    let (code, said) = Project::new(&recursion(20)).run(&[]);
    assert_eq!(code, Some(0), "{said}");
    assert!(said.contains("returned 20"), "{said}");
}

/// Far past what 8 MiB holds in a debug build (about 19 calls of this one).
#[test]
#[cfg_attr(not(debug_assertions), ignore = "a release build's limit is the 10,000 below")]
fn a_raised_limit_is_reached_past_the_stack_the_thread_started_with() {
    ended_at_the_limit(Project::new(&recursion(100_000)).run(&[("MOVEMENT_MAX_CALL_DEPTH", "200")]), 200);
}

#[test]
#[cfg_attr(debug_assertions, ignore = "twelve minutes on a release build: see the head of this file")]
fn a_limit_of_ten_thousand_is_reached() {
    // The wall clock is another limit's business: a slow machine should not read as this one failing.
    ended_at_the_limit(Project::new(&recursion(100_000)).run(&[("MOVEMENT_MAX_CALL_DEPTH", "10000"), ("MOVEMENT_MAX_SEGMENT_SECONDS", "7200")]), 10_000);
}

/// What the recursion goes through changes what a call costs in stack, not
/// how the run ends. A `through` stage is not here: it takes plugins only
/// (MOV_THROUGH_NOT_PLUGIN), and a plugin cannot call back into the movement.
#[test]
fn every_way_of_recursing_ends_at_the_limit() {
    let deep_expression = format!("{}down(n - 1){}", "(1 + ".repeat(100), ")".repeat(100));
    let start = "function b(run: <manual-[:Invocations]->>) { return down(100000) }";
    let shapes = [
        ("through another function", format!("function down(n: <number>): <number> {{\n  if (n <= 0) {{ return 0 }}\n  return 1 + other(n - 1)\n}}\nfunction other(n: <number>): <number> {{ return down(n) }}\n{start}")),
        ("as a statement", format!("function down(n: <number>): <number> {{\n  if (n <= 0) {{ return 0 }}\n  x = down(n - 1)\n  return x + 1\n}}\n{start}")),
        ("in a condition", format!("function down(n: <number>): <number> {{\n  if (n > 0 && down(n - 1) > 0) {{ return 1 }}\n  return 0\n}}\n{start}")),
        ("as an argument", format!("function id(n: <number>): <number> {{ return n }}\nfunction down(n: <number>): <number> {{\n  if (n <= 0) {{ return 0 }}\n  return id(down(n - 1))\n}}\n{start}")),
        ("inside an expression as deep as the parser takes", format!("function down(n: <number>): <number> {{\n  if (n <= 0) {{ return 0 }}\n  return {deep_expression}\n}}\n{start}")),
        ("a closure by its name", "function b(run: <manual-[:Invocations]->>) {\n  f = (n: <number>): <number> => {\n    if (n <= 0) { return 0 }\n    return 1 + f(n - 1)\n  }\n  return f(100000)\n}".to_string()),
        ("a closure around a closure", "function down(n: <number>, g: <(x: <number>) => <number>>): <number> {\n  if (n <= 0) { return g(0) }\n  return down(n - 1, (x) => g(x) + 1)\n}\nfunction b(run: <manual-[:Invocations]->>) { return down(100000, (x) => x) }".to_string()),
        ("a map", format!("function down(n: <number>): <number> {{\n  if (n <= 0) {{ return 0 }}\n  r = map([n], (x) => down(x - 1))\n  return 1\n}}\n{start}")),
        ("a function handed to a map by name", "function b(run: <manual-[:Invocations]->>) {\n  g = (x: <number>): <number[]> => {\n    return map([x], g)\n  }\n  return g(1)\n}".to_string()),
        ("all", format!("function down(n: <number>): <number> {{\n  if (n <= 0) {{ return 0 }}\n  r = all(() => {{ return down(n - 1) }})\n  return 1\n}}\n{start}")),
        ("race", format!("function down(n: <number>): <number> {{\n  if (n <= 0) {{ return 0 }}\n  r = race(() => {{ return down(n - 1) }})\n  return 1\n}}\n{start}")),
        ("a walk's body", format!("node T {{\n  name: <text>\n  node kid {{\n    x: <number>\n  }}\n}}\nfunction down(n: <number>): <number> {{\n  if (n <= 0) {{ return 0 }}\n  t = graph<T> {{ name: \"a\", kid: [{{ x: n }}] }}\n  t-[k:kid]-> {{\n    y = down(k.x - 1)\n  }}\n  return 1\n}}\n{start}")),
    ];
    for (shape, movement) in shapes {
        let (code, said) = Project::new(&movement).run(&[]);
        assert_eq!(code, Some(1), "{shape}: the run should fail, not take the process down:\n{said}");
        assert!(said.contains("MOVENG_CALL_DEPTH"), "{shape}: {said}");
    }
}

/// A run stopped with its calls still open lets them all go at once, one
/// inside the other.
#[test]
fn a_run_stopped_deep_in_its_calls_ends_with_the_coded_error() {
    let (code, said) = Project::new(&recursion(100_000)).run(&[("MOVEMENT_MAX_CALL_DEPTH", "100000"), ("MOVEMENT_MAX_SEGMENT_SECONDS", "1")]);
    assert_eq!(code, Some(1), "the run should fail, not take the process down:\n{said}");
    assert!(said.contains("MOVENG_LIMIT_WALL_CLOCK"), "{said}");
}

fn nested_by_a_loop(levels: usize, end: &str) -> String {
    let members = vec!["1"; levels].join(",");
    format!("function b(run: <manual-[:Invocations]->>) {{\n  x = reduce([{members}], (acc, i) => {{ return {{ v: acc }} }}, {{}})\n  {end}\n}}")
}

/// A value built by a recursion is as deep as the calls that built it. A loop
/// builds one here, which is quicker and goes as deep.
#[test]
fn a_deep_value_is_let_go_of_cleanly() {
    let (code, said) = Project::new(&nested_by_a_loop(5000, "return 1")).run(&[]);
    assert_eq!(code, Some(0), "{said}");
    assert!(said.contains("returned 1"), "{said}");
}

#[test]
fn a_value_too_deep_to_write_is_said_to_be_so() {
    let (code, said) = Project::new(&nested_by_a_loop(5000, "return x")).run(&[]);
    assert_eq!(code, Some(0), "{said}");
    assert!(said.contains("nested more than 3000 levels"), "{said}");
}
