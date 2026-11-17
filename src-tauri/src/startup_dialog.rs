const DEFAULT_LOCALE: &str = "de-CH";
const ENGLISH_LOCALE: &str = "en";

const CATALOGS: [(&str, &str); 5] = [
    ("de-CH", include_str!("../../locales/de-CH/app.ftl")),
    ("en", include_str!("../../locales/en/app.ftl")),
    ("es", include_str!("../../locales/es/app.ftl")),
    ("fr", include_str!("../../locales/fr/app.ftl")),
    ("it", include_str!("../../locales/it/app.ftl")),
];

fn catalog(locale: &str) -> Option<&'static str> {
    CATALOGS
        .iter()
        .find(|(name, _)| *name == locale)
        .map(|(_, source)| *source)
}

fn resolve_locale(candidate: Option<&str>) -> &'static str {
    let Some(candidate) = candidate else {
        return DEFAULT_LOCALE;
    };
    let normalized = candidate.replace('_', "-").to_ascii_lowercase();
    if let Some((name, _)) = CATALOGS
        .iter()
        .find(|(name, _)| name.to_ascii_lowercase() == normalized)
    {
        return name;
    }
    let language = normalized.split('-').next().unwrap_or_default();
    CATALOGS
        .iter()
        .find(|(name, _)| name.split('-').next() == Some(language))
        .map_or(DEFAULT_LOCALE, |(name, _)| name)
}

fn lookup<'a>(source: &'a str, key: &str) -> Option<&'a str> {
    source.lines().find_map(|line| {
        let (name, value) = line.split_once(" = ")?;
        (name == key).then_some(value.trim())
    })
}

/// Returns the startup dialog text for the OS locale, mirroring the frontend's
/// catalog fallback. Startup runs before the UI can supply its selected locale.
pub(crate) fn message(key: &str) -> String {
    let locale = resolve_locale(sys_locale::get_locale().as_deref());
    catalog(locale)
        .and_then(|source| lookup(source, key))
        .or_else(|| catalog(ENGLISH_LOCALE).and_then(|source| lookup(source, key)))
        .unwrap_or(key)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const STARTUP_KEYS: [&str; 5] = [
        "startup-error-title",
        "startup-session-bus-failed",
        "startup-session-bus-hint",
        "startup-policy-failed",
        "startup-policy-hint",
    ];

    #[test]
    fn every_locale_defines_the_startup_dialog_messages() {
        for (name, source) in CATALOGS {
            for key in STARTUP_KEYS {
                assert!(lookup(source, key).is_some(), "{name} is missing {key}");
            }
        }
    }

    #[test]
    fn os_locales_resolve_to_supported_catalogs() {
        assert_eq!(resolve_locale(Some("fr-CH")), "fr");
        assert_eq!(resolve_locale(Some("en_US.UTF-8")), "en");
        assert_eq!(resolve_locale(Some("de-CH")), "de-CH");
        assert_eq!(resolve_locale(Some("pt-BR")), DEFAULT_LOCALE);
        assert_eq!(resolve_locale(None), DEFAULT_LOCALE);
    }
}
