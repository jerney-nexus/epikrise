#[cfg_attr(not(feature = "direct-release-updater"), allow(dead_code))]
pub fn select_windows_updater_target(
    architecture: &str,
    selected_features: &[&str],
) -> Result<&'static str, &'static str> {
    let [selected_feature] = selected_features else {
        return Err(if selected_features.is_empty() {
            "A Windows installer-family updater feature is required."
        } else {
            "Select exactly one Windows installer-family updater feature."
        });
    };

    let (expected_architecture, target) = match *selected_feature {
        "updater-windows-x86_64-nsis" => ("x86_64", "windows-x86_64-nsis"),
        "updater-windows-aarch64-nsis" => ("aarch64", "windows-aarch64-nsis"),
        "updater-windows-x86_64-msi" => ("x86_64", "windows-x86_64-msi"),
        "updater-windows-aarch64-msi" => ("aarch64", "windows-aarch64-msi"),
        _ => return Err("Unsupported Windows installer-family updater feature."),
    };

    if architecture != expected_architecture {
        return Err("Windows updater feature does not match the target architecture.");
    }

    Ok(target)
}

#[allow(dead_code)]
pub fn validate_windows_updater_features(
    target: &str,
    direct_updater_enabled: bool,
    selected_features: &[&str],
) -> Result<Option<&'static str>, &'static str> {
    if target.ends_with("-windows-msvc") {
        if direct_updater_enabled {
            let architecture = target.split('-').next().unwrap_or_default();
            return select_windows_updater_target(architecture, selected_features).map(Some);
        }
        if !selected_features.is_empty() {
            return Err("Windows updater features require the direct-release-updater feature.");
        }
    } else if !selected_features.is_empty() {
        return Err("Windows updater features require a Windows target.");
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::{select_windows_updater_target, validate_windows_updater_features};

    #[test]
    fn maps_the_four_supported_windows_updater_targets() {
        for (architecture, feature, target) in [
            (
                "x86_64",
                "updater-windows-x86_64-nsis",
                "windows-x86_64-nsis",
            ),
            (
                "aarch64",
                "updater-windows-aarch64-nsis",
                "windows-aarch64-nsis",
            ),
            ("x86_64", "updater-windows-x86_64-msi", "windows-x86_64-msi"),
            (
                "aarch64",
                "updater-windows-aarch64-msi",
                "windows-aarch64-msi",
            ),
        ] {
            assert_eq!(
                select_windows_updater_target(architecture, &[feature]),
                Ok(target)
            );
        }
    }

    #[test]
    fn rejects_missing_conflicting_and_wrong_architecture_features() {
        assert_eq!(
            select_windows_updater_target("x86_64", &[]),
            Err("A Windows installer-family updater feature is required.")
        );
        assert_eq!(
            select_windows_updater_target(
                "x86_64",
                &["updater-windows-x86_64-nsis", "updater-windows-x86_64-msi"]
            ),
            Err("Select exactly one Windows installer-family updater feature.")
        );
        assert_eq!(
            select_windows_updater_target("aarch64", &["updater-windows-x86_64-nsis"]),
            Err("Windows updater feature does not match the target architecture.")
        );
    }

    #[test]
    fn build_guard_requires_family_selection_only_for_windows_updater_builds() {
        assert_eq!(
            validate_windows_updater_features("x86_64-pc-windows-msvc", true, &[]),
            Err("A Windows installer-family updater feature is required.")
        );
        assert_eq!(
            validate_windows_updater_features(
                "x86_64-pc-windows-msvc",
                true,
                &["updater-windows-x86_64-nsis"]
            ),
            Ok(Some("windows-x86_64-nsis"))
        );
        assert_eq!(
            validate_windows_updater_features(
                "aarch64-unknown-linux-gnu",
                true,
                &["updater-windows-aarch64-nsis"]
            ),
            Err("Windows updater features require a Windows target.")
        );
        assert_eq!(
            validate_windows_updater_features("aarch64-unknown-linux-gnu", true, &[]),
            Ok(None)
        );
    }
}
