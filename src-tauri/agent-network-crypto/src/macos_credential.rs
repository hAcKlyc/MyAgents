//! A per-query UI policy, preserving the legacy keyring service/account/domain.
//! This does not impose a hard deadline on the Security framework IPC.
use super::macos_helper::ReadMode;
use core_foundation::{
    array::CFArray,
    base::TCFType,
    string::{CFString, CFStringRef},
};
use keyring::macos::{MacCredential, MacKeychainDomain};
use security_framework::{
    os::macos::keychain::{SecKeychain, SecPreferencesDomain},
    passwords::{generic_password, PasswordOptions},
};
use security_framework_sys::item::{kSecMatchLimit, kSecMatchSearchList, kSecUseAuthenticationUI};
use std::sync::atomic::AtomicBool;

// These public Security constants are present in the SDK but not exposed by
// security-framework-sys 2.17.0. They are immutable framework-owned CFStrings.
#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecUseAuthenticationUIFail: CFStringRef;
    static kSecUseAuthenticationUIAllow: CFStringRef;
    static kSecMatchLimitOne: CFStringRef;
}

fn domain(credential: &MacCredential) -> SecPreferencesDomain {
    match credential.domain {
        MacKeychainDomain::User => SecPreferencesDomain::User,
        MacKeychainDomain::System => SecPreferencesDomain::System,
        MacKeychainDomain::Common => SecPreferencesDomain::Common,
        MacKeychainDomain::Dynamic => SecPreferencesDomain::Dynamic,
    }
}

#[allow(deprecated)] // The pinned API has no setters for search-list or UIFail.
fn query(
    service: &str,
    account: &str,
    keychains: CFArray<SecKeychain>,
    mode: ReadMode,
) -> PasswordOptions {
    let mut options = PasswordOptions::new_generic_password(service, account);
    // SAFETY: all constants are immutable CFStrings supplied by Security;
    // wrap_under_get_rule retains them, and every query value is owned.
    unsafe {
        options.query.push((
            CFString::wrap_under_get_rule(kSecMatchSearchList),
            keychains.into_CFType(),
        ));
        options.query.push((
            CFString::wrap_under_get_rule(kSecMatchLimit),
            CFString::wrap_under_get_rule(kSecMatchLimitOne).into_CFType(),
        ));
        options.query.push((
            CFString::wrap_under_get_rule(kSecUseAuthenticationUI),
            CFString::wrap_under_get_rule(match mode {
                ReadMode::Background => kSecUseAuthenticationUIFail,
                ReadMode::Authorize => kSecUseAuthenticationUIAllow,
            })
            .into_CFType(),
        ));
    }
    options
}

pub fn read_secret_noninteractive(entry: &keyring::Entry) -> keyring::Result<Vec<u8>> {
    let Some(credential) = entry.get_credential().downcast_ref::<MacCredential>() else {
        // Preserve the explicit keyring mock used by portable owner tests.
        #[cfg(test)]
        return entry.get_secret();
        #[cfg(not(test))]
        return Err(keyring::Error::PlatformFailure(Box::new(
            std::io::Error::other("unsupported credential backend"),
        )));
    };
    super::macos_helper::read(credential)
}

pub fn read_secret_authorized(
    entry: &keyring::Entry,
    cancelled: &AtomicBool,
) -> keyring::Result<Vec<u8>> {
    let Some(credential) = entry.get_credential().downcast_ref::<MacCredential>() else {
        #[cfg(test)]
        return if cancelled.load(std::sync::atomic::Ordering::Acquire) {
            Err(super::macos_helper::unavailable())
        } else {
            entry.get_secret()
        };
        #[cfg(not(test))]
        return Err(keyring::Error::PlatformFailure(Box::new(
            std::io::Error::other("unsupported credential backend"),
        )));
    };
    super::macos_helper::read_authorized(credential, cancelled)
}

pub(super) fn read_direct(credential: &MacCredential, mode: ReadMode) -> keyring::Result<Vec<u8>> {
    let keychain = SecKeychain::default_for_domain(domain(credential))
        .map_err(keyring::macos::decode_error)?;
    generic_password(query(
        &credential.service,
        &credential.account,
        CFArray::from_CFTypes(&[keychain]),
        mode,
    ))
    .map_err(keyring::macos::decode_error)
}

pub fn credential_authorization_required(error: &keyring::Error) -> bool {
    match error {
        keyring::Error::PlatformFailure(error) => error
            .downcast_ref::<security_framework::base::Error>()
            .is_some_and(|error| matches!(error.code(), -25308 | -25293)),
        _ => false,
    }
}

#[cfg(test)]
#[allow(deprecated)] // Inspect the exact dictionary without querying any credential.
mod tests {
    use super::*;
    fn string_value(options: &PasswordOptions, key: CFStringRef) -> Option<String> {
        // SAFETY: tests only pass static Security CFString constants.
        let key = unsafe { CFString::wrap_under_get_rule(key) };
        options
            .query
            .iter()
            .find(|(candidate, _)| *candidate == key)
            .and_then(|(_, value)| value.downcast::<CFString>())
            .map(|value| value.to_string())
    }
    #[test]
    fn exact_query_preserves_legacy_namespace_and_fails_instead_of_skipping() {
        let options = query(
            "isolated-service",
            "isolated-account",
            CFArray::from_CFTypes(&[]),
            ReadMode::Background,
        );
        unsafe {
            assert_eq!(
                string_value(&options, security_framework_sys::item::kSecClass),
                Some(
                    CFString::wrap_under_get_rule(
                        security_framework_sys::item::kSecClassGenericPassword
                    )
                    .to_string()
                )
            );
            let search_key = CFString::wrap_under_get_rule(kSecMatchSearchList);
            let (_, search_value) = options
                .query
                .iter()
                .find(|(key, _)| *key == search_key)
                .unwrap();
            assert_eq!(search_value.type_of(), CFArray::<SecKeychain>::type_id());
            assert_eq!(
                string_value(&options, security_framework_sys::item::kSecAttrService).as_deref(),
                Some("isolated-service")
            );
            assert_eq!(
                string_value(&options, security_framework_sys::item::kSecAttrAccount).as_deref(),
                Some("isolated-account")
            );
            assert_eq!(
                string_value(&options, kSecUseAuthenticationUI),
                Some(CFString::wrap_under_get_rule(kSecUseAuthenticationUIFail).to_string())
            );
            assert_ne!(
                string_value(&options, kSecUseAuthenticationUI),
                Some(
                    CFString::wrap_under_get_rule(
                        security_framework_sys::item::kSecUseAuthenticationUISkip
                    )
                    .to_string()
                )
            );
            assert_eq!(
                string_value(&options, kSecMatchLimit),
                Some(CFString::wrap_under_get_rule(kSecMatchLimitOne).to_string())
            );
        }
        assert_eq!(options.query.len(), 6); // class/service/account plus the three restrictions
        let credential =
            MacCredential::new_with_target(None, "isolated-service", "isolated-account").unwrap();
        assert!(matches!(domain(&credential), SecPreferencesDomain::User));
        for (target, expected) in [
            ("User", SecPreferencesDomain::User),
            ("System", SecPreferencesDomain::System),
            ("Common", SecPreferencesDomain::Common),
            ("Dynamic", SecPreferencesDomain::Dynamic),
        ] {
            let credential = MacCredential::new_with_target(
                Some(target),
                "isolated-service",
                "isolated-account",
            )
            .unwrap();
            assert_eq!(domain(&credential), expected);
        }
    }
    #[test]
    fn authorization_query_changes_only_the_ui_policy() {
        let background = query(
            "isolated-service",
            "isolated-account",
            CFArray::from_CFTypes(&[]),
            ReadMode::Background,
        );
        let authorized = query(
            "isolated-service",
            "isolated-account",
            CFArray::from_CFTypes(&[]),
            ReadMode::Authorize,
        );
        unsafe {
            assert_eq!(
                string_value(&authorized, kSecUseAuthenticationUI),
                Some(CFString::wrap_under_get_rule(kSecUseAuthenticationUIAllow).to_string())
            );
            for key in [
                security_framework_sys::item::kSecClass,
                security_framework_sys::item::kSecAttrService,
                security_framework_sys::item::kSecAttrAccount,
                kSecMatchLimit,
            ] {
                assert_eq!(
                    string_value(&background, key),
                    string_value(&authorized, key)
                );
            }
        }
        assert_eq!(authorized.query.len(), background.query.len());
    }
    #[test]
    fn only_real_item_not_found_maps_to_missing() {
        assert!(matches!(
            keyring::macos::decode_error(security_framework::base::Error::from(-25300)),
            keyring::Error::NoEntry
        ));
        for code in [-25308, -25293, -25291] {
            let error = keyring::macos::decode_error(security_framework::base::Error::from(code));
            assert!(!matches!(error, keyring::Error::NoEntry));
            assert_eq!(
                credential_authorization_required(&error),
                matches!(code, -25308 | -25293)
            );
        }
    }
}
