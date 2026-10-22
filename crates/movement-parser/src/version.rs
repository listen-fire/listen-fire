//! The language version is the toolchain release: the one semver every crate
//! and package carries. A movement's pin is the release it was written
//! against, and a release reads a pin whose compatibility key is its own
//! (docs/contracts/language-versions.md). The same rule is
//! packages/movement-lang/language_version.ts; a test holds the two equal.

/// This release's version, and so the language it reads.
pub const LANGUAGE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// How a pin stands against a release.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Standing {
    Compatible,
    Newer,
    OlderKey,
    Malformed,
}

// The refusals, with `{pin}` and `{own}` to fill. The contract doc quotes
// them and the TypeScript words them the same; a test reads them here.
const NEWER_MESSAGE: &str = "this automation pins language {pin}, newer than this release ({own}); upgrade the engine";
const OLDER_KEY_MESSAGE: &str =
    "this automation pins language {pin}, which this release ({own}) does not read; validate it under {own} and upgrade it";
const MALFORMED_MESSAGE: &str = "this automation pins language {pin}, which is not a version; a pin is a release's version, such as {own}";

/// `MAJOR.MINOR.PATCH[-pre]`, each number without a leading zero.
fn parse(version: &str) -> Option<(u64, u64, u64)> {
    let (release, pre) = match version.split_once('-') {
        Some((release, pre)) => (release, Some(pre)),
        None => (version, None),
    };
    let pre_is_valid = |pre: &str| {
        pre.split('.').all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
    };
    if pre.is_some_and(|pre| !pre_is_valid(pre)) {
        return None;
    }
    let number = |part: &str| {
        let digits = !part.is_empty() && part.chars().all(|c| c.is_ascii_digit());
        if !digits || (part.len() > 1 && part.starts_with('0')) {
            return None;
        }
        part.parse::<u64>().ok()
    };
    let mut parts = release.split('.');
    let (major, minor, patch) = (number(parts.next()?)?, number(parts.next()?)?, number(parts.next()?)?);
    parts.next().is_none().then_some((major, minor, patch))
}

/// The part of a version a pin must share with a release: the minor under
/// 0.x (`0.12`), the major from 1.0 (`1`).
pub fn compatibility_key(version: &str) -> Result<String, String> {
    match parse(version) {
        Some((0, minor, _)) => Ok(format!("0.{minor}")),
        Some((major, _, _)) => Ok(major.to_string()),
        None => Err(format!("{version} is not a version (MAJOR.MINOR.PATCH, with an optional -pre-release)")),
    }
}

/// How `pin` stands against the release `own`.
pub fn standing(pin: &str, own: &str) -> Standing {
    let (Some(pinned), Some(release)) = (parse(pin), parse(own)) else {
        return Standing::Malformed;
    };
    if compatibility_key(pin) == compatibility_key(own) {
        return Standing::Compatible;
    }
    if (pinned.0, pinned.1) > (release.0, release.1) { Standing::Newer } else { Standing::OlderKey }
}

/// Whether the release `own` reads a movement pinned to `pin`.
pub fn compatible(pin: &str, own: &str) -> bool {
    standing(pin, own) == Standing::Compatible
}

/// Why `own` does not read `pin`, by its standing; none when it does.
pub fn refusal_message(pin: &str, own: &str, standing: Standing) -> Option<String> {
    let template = match standing {
        Standing::Compatible => return None,
        Standing::Newer => NEWER_MESSAGE,
        Standing::OlderKey => OLDER_KEY_MESSAGE,
        Standing::Malformed => MALFORMED_MESSAGE,
    };
    Some(template.replace("{pin}", pin).replace("{own}", own))
}

/// `refusal_message` under the pin's own standing.
pub fn refusal(pin: &str, own: &str) -> Option<String> {
    refusal_message(pin, own, standing(pin, own))
}

/// The integer the wasm entries still take for this language. Task 2 removes.
pub const LEGACY_PIN: u32 = 5;

/// An integer pin as the ABI carries it, as a version the rule reads: 5 is
/// this release, any other integer is not a version. Task 2 removes.
pub fn legacy_pin_to_semver(pin: u32) -> String {
    if pin == LEGACY_PIN { LANGUAGE_VERSION.to_string() } else { pin.to_string() }
}

/// The run host's units (Henry 2026-10-16): every file has these names in
/// scope, each already connected — `listen to manual fire hello`,
/// `listen to cron { schedule: "0 9 * * 1" } fire digest` — with no import
/// and no `connect`. A file's own binding of the name replaces it.
pub const RUN_HOST_UNITS: &[&str] = &["cron", "manual"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pin_is_read_when_its_compatibility_key_is_the_releases() {
        let table = [
            ("0.12.3", "0.12.0", Standing::Compatible),
            ("0.13.0", "0.12.0", Standing::Newer),
            ("0.11.0", "0.12.0", Standing::OlderKey),
            ("1.4.0", "1.0.0", Standing::Compatible),
            ("2.0.0", "1.9.0", Standing::Newer),
            ("0.12.0-rc.6", "0.12.0", Standing::Compatible),
            ("banana", "0.12.0", Standing::Malformed),
        ];
        for (pin, own, expected) in table {
            assert_eq!(standing(pin, own), expected, "{pin} against {own}");
            assert_eq!(compatible(pin, own), expected == Standing::Compatible, "{pin} against {own}");
        }
    }

    #[test]
    fn the_key_is_the_minor_under_zero_and_the_major_from_one() {
        assert_eq!(compatibility_key("0.12.0-rc.6"), Ok("0.12".to_string()));
        assert_eq!(compatibility_key("1.4.2"), Ok("1".to_string()));
        for malformed in ["banana", "5", "0.12", "0.12.0.1", "01.2.3", "0.12.0-", "0.12.0-rc..1", ""] {
            assert!(compatibility_key(malformed).is_err(), "{malformed}");
        }
    }

    #[test]
    fn each_refusal_names_the_pin_the_release_and_the_remedy() {
        assert_eq!(refusal("0.12.1", "0.12.0"), None);
        assert_eq!(
            refusal("0.13.0", "0.12.0").unwrap(),
            "this automation pins language 0.13.0, newer than this release (0.12.0); upgrade the engine"
        );
        assert_eq!(
            refusal("0.11.0", "0.12.0").unwrap(),
            "this automation pins language 0.11.0, which this release (0.12.0) does not read; validate it under 0.12.0 and upgrade it"
        );
        assert_eq!(
            refusal("banana", "0.12.0").unwrap(),
            "this automation pins language banana, which is not a version; a pin is a release's version, such as 0.12.0"
        );
    }

    #[test]
    fn this_release_reads_its_own_version_and_the_legacy_pin_maps_onto_it() {
        assert!(compatible(LANGUAGE_VERSION, LANGUAGE_VERSION));
        assert_eq!(legacy_pin_to_semver(LEGACY_PIN), LANGUAGE_VERSION);
        assert_eq!(standing(&legacy_pin_to_semver(4), LANGUAGE_VERSION), Standing::Malformed);
    }
}
