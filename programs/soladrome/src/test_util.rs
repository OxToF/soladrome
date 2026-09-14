// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs

//! Helpers shared by the native `#[cfg(test)]` suites.
//!
//! These tests exist to be *measurable*: the 124 bankrun/mocha cases exercise the SBF binary
//! through a validator, which `cargo llvm-cov` cannot instrument — it compiles for the host and
//! runs `cargo test`, so a repository with no `#[test]` reports 0.00% region coverage no matter
//! how well tested it actually is. Hacken's 2026-09-14 review reported exactly that. Pure
//! functions with no `Context` are the part of the program that can answer the question
//! honestly, and they are also the part where a bug is unrecoverable: curve pricing, LP
//! accounting and mint admission.
//!
//! Nothing here is compiled into the program. `#[cfg(test)]` is stripped before
//! `cargo build-sbf` ever runs, so the deployed artefact is byte-for-byte unchanged.

use anchor_lang::error::Error;

/// The numeric code Anchor would return on-chain for an `Err`.
///
/// Asserting on the code rather than on `is_err()` is what makes a refusal test meaningful: a
/// guard that starts failing for the *wrong* reason (an overflow where an `InvalidAmount` was
/// intended, say) still returns `Err` and would pass a laxer assertion.
pub fn err_code(e: Error) -> u32 {
    match e {
        Error::AnchorError(ae) => ae.error_code_number,
        Error::ProgramError(pe) => panic!("expected an AnchorError, got a ProgramError: {pe:?}"),
    }
}

/// Assert that `result` failed with `expected`, naming the mismatch when it did not.
#[macro_export]
macro_rules! assert_err {
    ($result:expr, $expected:expr) => {{
        let expected_code = $expected as u32 + anchor_lang::error::ERROR_CODE_OFFSET;
        match $result {
            Ok(v) => panic!(
                "expected {:?} ({}), got Ok({:?})",
                $expected, expected_code, v
            ),
            Err(e) => {
                let got = $crate::test_util::err_code(e);
                assert_eq!(
                    got, expected_code,
                    "expected {:?} ({}), got error code {}",
                    $expected, expected_code, got
                );
            }
        }
    }};
}
