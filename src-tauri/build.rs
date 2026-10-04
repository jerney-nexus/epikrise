#[path = "src/windows_updater_features.rs"]
mod windows_updater_features;

use std::env;

const WINDOWS_UPDATER_FEATURES: [(&str, &str); 4] = [
    (
        "updater-windows-x86_64-nsis",
        "CARGO_FEATURE_UPDATER_WINDOWS_X86_64_NSIS",
    ),
    (
        "updater-windows-aarch64-nsis",
        "CARGO_FEATURE_UPDATER_WINDOWS_AARCH64_NSIS",
    ),
    (
        "updater-windows-x86_64-msi",
        "CARGO_FEATURE_UPDATER_WINDOWS_X86_64_MSI",
    ),
    (
        "updater-windows-aarch64-msi",
        "CARGO_FEATURE_UPDATER_WINDOWS_AARCH64_MSI",
    ),
];

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let target = env::var("TARGET").unwrap_or_default();
    let direct_updater = env::var_os("CARGO_FEATURE_DIRECT_RELEASE_UPDATER").is_some();
    let selected_features = WINDOWS_UPDATER_FEATURES
        .iter()
        .filter_map(|(feature, environment)| env::var_os(environment).map(|_| *feature))
        .collect::<Vec<_>>();

    windows_updater_features::validate_windows_updater_features(
        &target,
        direct_updater,
        &selected_features,
    )
    .map_err(std::io::Error::other)?;

    tauri_build::build();
    Ok(())
}
