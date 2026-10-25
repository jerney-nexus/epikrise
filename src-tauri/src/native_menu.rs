use std::sync::Mutex;

use tauri::{
    AppHandle, EventTarget, Manager, Wry,
    menu::{HELP_SUBMENU_ID, Menu, MenuItem, MenuItemKind, Submenu},
};
use tauri_specta::Event;

use crate::{NativeMenuAction, NativeMenuLabels, NativeMenuRequest, NativeMenuStatus};

const HELP_ID: &str = "native-help";
const GENERAL_SETTINGS_ID: &str = "native-settings-general";
const PROVIDER_SETTINGS_ID: &str = "native-settings-provider";
const MODEL_SETTINGS_ID: &str = "native-settings-model";
const TEMPLATE_SETTINGS_ID: &str = "native-settings-template";
#[cfg(not(target_os = "macos"))]
const SETTINGS_SUBMENU_ID: &str = "native-settings-menu";

#[derive(Default)]
pub(crate) struct NativeMenuState(Mutex<Option<NativeMenuItems>>);

struct NativeMenuItems {
    help: MenuItem<Wry>,
    general_settings: MenuItem<Wry>,
    provider_settings: MenuItem<Wry>,
    model_settings: MenuItem<Wry>,
    template_settings: MenuItem<Wry>,
    help_menu: Submenu<Wry>,
    #[cfg(not(target_os = "macos"))]
    settings_menu: Submenu<Wry>,
    #[cfg(target_os = "macos")]
    application_menu: Submenu<Wry>,
}

pub(crate) fn install(app: &AppHandle<Wry>) -> tauri::Result<NativeMenuState> {
    let menu = Menu::default(app)?;
    let labels = NativeMenuLabels::english();
    let help = menu_item(app, HELP_ID, &labels.help_action, help_accelerator())?;
    let general_settings = menu_item(
        app,
        GENERAL_SETTINGS_ID,
        &labels.general_settings_action,
        settings_accelerator(),
    )?;
    let provider_settings = menu_item(
        app,
        PROVIDER_SETTINGS_ID,
        &labels.provider_settings_action,
        None,
    )?;
    let model_settings = menu_item(app, MODEL_SETTINGS_ID, &labels.model_settings_action, None)?;
    let template_settings = menu_item(
        app,
        TEMPLATE_SETTINGS_ID,
        &labels.template_settings_action,
        None,
    )?;

    #[cfg(target_os = "macos")]
    let application_menu = {
        let Some(MenuItemKind::Submenu(application_menu)) = menu.items()?.into_iter().next() else {
            let error: Box<dyn std::error::Error> = Box::new(std::io::Error::other(
                "default macOS application menu is unavailable",
            ));
            return Err(tauri::Error::Setup(error.into()));
        };
        application_menu.insert(&template_settings, 2)?;
        application_menu.insert(&model_settings, 2)?;
        application_menu.insert(&provider_settings, 2)?;
        application_menu.insert(&general_settings, 2)?;
        application_menu
    };

    #[cfg(not(target_os = "macos"))]
    let settings_menu = {
        let settings_menu = Submenu::with_id_and_items(
            app,
            SETTINGS_SUBMENU_ID,
            escaped_label(&labels.settings_menu),
            true,
            &[
                &general_settings,
                &provider_settings,
                &model_settings,
                &template_settings,
            ],
        )?;
        menu.append(&settings_menu)?;
        settings_menu
    };

    let Some(MenuItemKind::Submenu(help_menu)) = menu.get(HELP_SUBMENU_ID) else {
        let error: Box<dyn std::error::Error> =
            Box::new(std::io::Error::other("default Help menu is unavailable"));
        return Err(tauri::Error::Setup(error.into()));
    };
    help_menu.append(&help)?;
    for item in [
        &help,
        &general_settings,
        &provider_settings,
        &model_settings,
        &template_settings,
    ] {
        item.set_enabled(false)?;
    }

    app.set_menu(menu)?;

    Ok(NativeMenuState(Mutex::new(Some(NativeMenuItems {
        help,
        general_settings,
        provider_settings,
        model_settings,
        template_settings,
        help_menu,
        #[cfg(not(target_os = "macos"))]
        settings_menu,
        #[cfg(target_os = "macos")]
        application_menu,
    }))))
}

pub(crate) fn sync(
    state: &NativeMenuState,
    labels: NativeMenuLabels,
    ready: bool,
) -> Result<(), String> {
    let guard = state
        .0
        .lock()
        .map_err(|_| "Native menu could not be synchronized".to_owned())?;
    let Some(items) = guard.as_ref() else {
        return Err("Native menu could not be synchronized".to_owned());
    };

    items
        .help
        .set_text(escaped_label(&labels.help_action))
        .and_then(|()| {
            items
                .general_settings
                .set_text(escaped_label(&labels.general_settings_action))
        })
        .and_then(|()| {
            items
                .provider_settings
                .set_text(escaped_label(&labels.provider_settings_action))
        })
        .and_then(|()| {
            items
                .model_settings
                .set_text(escaped_label(&labels.model_settings_action))
        })
        .and_then(|()| {
            items
                .template_settings
                .set_text(escaped_label(&labels.template_settings_action))
        })
        .and_then(|()| items.help_menu.set_text(escaped_label(&labels.help_menu)))
        .map_err(|_| "Native menu could not be synchronized".to_owned())?;

    #[cfg(target_os = "macos")]
    let _ = &items.application_menu;

    #[cfg(not(target_os = "macos"))]
    items
        .settings_menu
        .set_text(escaped_label(&labels.settings_menu))
        .map_err(|_| "Native menu could not be synchronized".to_owned())?;

    for item in [
        &items.help,
        &items.general_settings,
        &items.provider_settings,
        &items.model_settings,
        &items.template_settings,
    ] {
        item.set_enabled(ready)
            .map_err(|_| "Native menu could not be synchronized".to_owned())?;
    }
    Ok(())
}

pub(crate) fn dispatch(app: &AppHandle<Wry>, id: &str) {
    let Some(action) = NativeMenuAction::from_id(id) else {
        return;
    };

    let Some(window) = app.get_webview_window("main") else {
        emit_unavailable(app);
        return;
    };
    if window.show().is_err() || window.unminimize().is_err() || window.set_focus().is_err() {
        emit_unavailable(app);
        return;
    }

    let request = NativeMenuRequest { action };
    if request
        .emit_to(
            app,
            EventTarget::Webview {
                label: "main".to_owned(),
            },
        )
        .is_err()
    {
        emit_unavailable(app);
    }
}

fn emit_unavailable(app: &AppHandle<Wry>) {
    let _ = NativeMenuStatus { available: false }.emit_to(
        app,
        EventTarget::Webview {
            label: "main".to_owned(),
        },
    );
}

fn menu_item(
    app: &AppHandle<Wry>,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, id, escaped_label(label), false, accelerator)
}

fn escaped_label(label: &str) -> String {
    label.replace('&', "&&")
}

#[cfg(target_os = "macos")]
fn settings_accelerator() -> Option<&'static str> {
    Some("Cmd+,")
}

#[cfg(not(target_os = "macos"))]
fn settings_accelerator() -> Option<&'static str> {
    Some("Ctrl+,")
}

#[cfg(target_os = "macos")]
fn help_accelerator() -> Option<&'static str> {
    None
}

#[cfg(not(target_os = "macos"))]
fn help_accelerator() -> Option<&'static str> {
    Some("F1")
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use crate::{NativeMenuAction, NativeMenuRequest};

    use super::{escaped_label, help_accelerator, settings_accelerator};

    #[test]
    fn native_menu_action_ids_are_unique_and_stable() {
        let ids = NativeMenuAction::ALL.map(NativeMenuAction::id);
        assert_eq!(ids.len(), 5);
        assert_eq!(ids.into_iter().collect::<HashSet<_>>().len(), 5);
    }

    #[test]
    fn native_menu_actions_map_only_known_ids() {
        for action in NativeMenuAction::ALL {
            assert_eq!(NativeMenuAction::from_id(action.id()), Some(action));
        }
        assert_eq!(NativeMenuAction::from_id("edit-copy"), None);
        assert_eq!(NativeMenuAction::from_id("translated label"), None);
    }

    #[test]
    fn native_menu_actions_have_a_fixed_serialized_contract() {
        let serialized =
            NativeMenuAction::ALL.map(|action| serde_json::to_value(NativeMenuRequest { action }));
        let values = serialized.map(|value| value.ok());
        assert_eq!(
            values,
            [
                Some(serde_json::json!({"action": "help"})),
                Some(serde_json::json!({"action": "generalSettings"})),
                Some(serde_json::json!({"action": "providerSettings"})),
                Some(serde_json::json!({"action": "modelSettings"})),
                Some(serde_json::json!({"action": "templateSettings"})),
            ]
        );
    }

    #[test]
    fn native_menu_labels_escape_mnemonic_ampersands() {
        assert_eq!(
            escaped_label("Research & development"),
            "Research && development"
        );
    }

    #[test]
    fn non_macos_menu_accelerators_match_the_desktop_conventions() {
        #[cfg(not(target_os = "macos"))]
        {
            assert_eq!(settings_accelerator(), Some("Ctrl+,"));
            assert_eq!(help_accelerator(), Some("F1"));
        }
    }
}
