use std::sync::Mutex;

use tauri::{
    AppHandle, EventTarget, Manager, Wry,
    menu::{
        HELP_SUBMENU_ID, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu,
        WINDOW_SUBMENU_ID,
    },
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
    localized_submenus: Vec<(Submenu<Wry>, NativeMenuTitle)>,
    localized_predefined: Vec<(PredefinedMenuItem<Wry>, NativeMenuLabel)>,
}

#[derive(Clone, Copy)]
enum NativeMenuTitle {
    #[cfg(not(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    )))]
    File,
    Edit,
    #[cfg(target_os = "macos")]
    View,
    Window,
    Help,
    #[cfg(not(target_os = "macos"))]
    Settings,
}

impl NativeMenuTitle {
    fn text(self, labels: &NativeMenuLabels) -> &str {
        match self {
            #[cfg(not(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            )))]
            Self::File => &labels.file_menu,
            Self::Edit => &labels.edit_menu,
            #[cfg(target_os = "macos")]
            Self::View => &labels.view_menu,
            Self::Window => &labels.window_menu,
            Self::Help => &labels.help_menu,
            #[cfg(not(target_os = "macos"))]
            Self::Settings => &labels.settings_menu,
        }
    }
}

#[derive(Clone, Copy)]
enum NativeMenuLabel {
    #[cfg(not(target_os = "macos"))]
    About,
    #[cfg(target_os = "macos")]
    AboutApp,
    #[cfg(target_os = "macos")]
    Services,
    #[cfg(target_os = "macos")]
    HideApp,
    #[cfg(target_os = "macos")]
    HideOthers,
    #[cfg(target_os = "macos")]
    QuitApp,
    #[cfg(target_os = "windows")]
    Close,
    #[cfg(not(target_os = "windows"))]
    CloseWindow,
    #[cfg(target_os = "windows")]
    Exit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    #[cfg(target_os = "macos")]
    Fullscreen,
    Minimize,
    #[cfg(not(target_os = "macos"))]
    Maximize,
    #[cfg(target_os = "macos")]
    Zoom,
}

impl NativeMenuLabel {
    fn text(self, labels: &NativeMenuLabels) -> &str {
        match self {
            #[cfg(not(target_os = "macos"))]
            Self::About => &labels.about_action,
            #[cfg(target_os = "macos")]
            Self::AboutApp => &labels.about_app_action,
            #[cfg(target_os = "macos")]
            Self::Services => &labels.services_action,
            #[cfg(target_os = "macos")]
            Self::HideApp => &labels.hide_app_action,
            #[cfg(target_os = "macos")]
            Self::HideOthers => &labels.hide_others_action,
            #[cfg(target_os = "macos")]
            Self::QuitApp => &labels.quit_app_action,
            #[cfg(target_os = "windows")]
            Self::Close => &labels.close_action,
            #[cfg(not(target_os = "windows"))]
            Self::CloseWindow => &labels.close_window_action,
            #[cfg(target_os = "windows")]
            Self::Exit => &labels.exit_action,
            Self::Undo => &labels.undo_action,
            Self::Redo => &labels.redo_action,
            Self::Cut => &labels.cut_action,
            Self::Copy => &labels.copy_action,
            Self::Paste => &labels.paste_action,
            Self::SelectAll => &labels.select_all_action,
            #[cfg(target_os = "macos")]
            Self::Fullscreen => &labels.fullscreen_action,
            Self::Minimize => &labels.minimize_action,
            #[cfg(not(target_os = "macos"))]
            Self::Maximize => &labels.maximize_action,
            #[cfg(target_os = "macos")]
            Self::Zoom => &labels.zoom_action,
        }
    }
}

pub(crate) fn install(app: &AppHandle<Wry>) -> tauri::Result<NativeMenuState> {
    let menu = Menu::default(app)?;
    let labels = NativeMenuLabels::english();
    let edit_menu = find_submenu(&menu, "Edit")?;
    let window_menu = find_submenu_by_id(&menu, WINDOW_SUBMENU_ID)?;
    let help_menu = find_submenu_by_id(&menu, HELP_SUBMENU_ID)?;
    let mut localized_submenus = vec![
        (edit_menu.clone(), NativeMenuTitle::Edit),
        (window_menu.clone(), NativeMenuTitle::Window),
        (help_menu.clone(), NativeMenuTitle::Help),
    ];
    let mut localized_predefined = Vec::new();

    #[cfg(not(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    )))]
    {
        let file_menu = find_submenu(&menu, "File")?;
        localized_submenus.push((file_menu.clone(), NativeMenuTitle::File));
        #[cfg(target_os = "macos")]
        push_predefined(
            &mut localized_predefined,
            &file_menu,
            0,
            NativeMenuLabel::CloseWindow,
        )?;
        #[cfg(target_os = "windows")]
        push_predefined(
            &mut localized_predefined,
            &file_menu,
            0,
            NativeMenuLabel::Close,
        )?;
        #[cfg(target_os = "windows")]
        push_predefined(
            &mut localized_predefined,
            &file_menu,
            1,
            NativeMenuLabel::Exit,
        )?;
    }

    #[cfg(target_os = "macos")]
    {
        let view_menu = find_submenu(&menu, "View")?;
        localized_submenus.push((view_menu.clone(), NativeMenuTitle::View));
        push_predefined(
            &mut localized_predefined,
            &view_menu,
            0,
            NativeMenuLabel::Fullscreen,
        )?;
        let Some(MenuItemKind::Submenu(application_menu)) = menu.items()?.into_iter().next() else {
            return Err(setup_error("default macOS application menu is unavailable"));
        };
        for (index, label) in [
            (0, NativeMenuLabel::AboutApp),
            (2, NativeMenuLabel::Services),
            (4, NativeMenuLabel::HideApp),
            (5, NativeMenuLabel::HideOthers),
            (7, NativeMenuLabel::QuitApp),
        ] {
            push_predefined(&mut localized_predefined, &application_menu, index, label)?;
        }
    }

    // Keep these positions aligned with the predefined items in Tauri's default menus.
    for (index, label) in [
        (0, NativeMenuLabel::Undo),
        (1, NativeMenuLabel::Redo),
        (3, NativeMenuLabel::Cut),
        (4, NativeMenuLabel::Copy),
        (5, NativeMenuLabel::Paste),
        (6, NativeMenuLabel::SelectAll),
    ] {
        push_predefined(&mut localized_predefined, &edit_menu, index, label)?;
    }
    push_predefined(
        &mut localized_predefined,
        &window_menu,
        0,
        NativeMenuLabel::Minimize,
    )?;
    #[cfg(target_os = "macos")]
    push_predefined(
        &mut localized_predefined,
        &window_menu,
        1,
        NativeMenuLabel::Zoom,
    )?;
    #[cfg(not(target_os = "macos"))]
    push_predefined(
        &mut localized_predefined,
        &window_menu,
        1,
        NativeMenuLabel::Maximize,
    )?;
    #[cfg(target_os = "macos")]
    push_predefined(
        &mut localized_predefined,
        &window_menu,
        3,
        NativeMenuLabel::CloseWindow,
    )?;
    #[cfg(target_os = "windows")]
    push_predefined(
        &mut localized_predefined,
        &window_menu,
        2,
        NativeMenuLabel::Close,
    )?;
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    push_predefined(
        &mut localized_predefined,
        &window_menu,
        2,
        NativeMenuLabel::CloseWindow,
    )?;
    #[cfg(not(target_os = "macos"))]
    push_predefined(
        &mut localized_predefined,
        &help_menu,
        0,
        NativeMenuLabel::About,
    )?;

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
    {
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
    }

    #[cfg(not(target_os = "macos"))]
    {
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
        localized_submenus.push((settings_menu.clone(), NativeMenuTitle::Settings));
    }

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
        localized_submenus,
        localized_predefined,
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

    for (submenu, title) in &items.localized_submenus {
        submenu
            .set_text(escaped_label(title.text(&labels)))
            .map_err(|_| "Native menu could not be synchronized".to_owned())?;
    }
    for (item, label) in &items.localized_predefined {
        item.set_text(escaped_label(label.text(&labels)))
            .map_err(|_| "Native menu could not be synchronized".to_owned())?;
    }

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

fn setup_error(message: &'static str) -> tauri::Error {
    let error: Box<dyn std::error::Error> = Box::new(std::io::Error::other(message));
    tauri::Error::Setup(error.into())
}

fn find_submenu(menu: &Menu<Wry>, default_title: &str) -> tauri::Result<Submenu<Wry>> {
    for item in menu.items()? {
        if let MenuItemKind::Submenu(submenu) = item
            && submenu.text()? == default_title
        {
            return Ok(submenu);
        }
    }
    Err(setup_error("a default native submenu is unavailable"))
}

fn find_submenu_by_id(menu: &Menu<Wry>, id: &str) -> tauri::Result<Submenu<Wry>> {
    match menu.get(id) {
        Some(MenuItemKind::Submenu(submenu)) => Ok(submenu),
        _ => Err(setup_error("a default native submenu is unavailable")),
    }
}

fn push_predefined(
    labels: &mut Vec<(PredefinedMenuItem<Wry>, NativeMenuLabel)>,
    submenu: &Submenu<Wry>,
    index: usize,
    label: NativeMenuLabel,
) -> tauri::Result<()> {
    let items = submenu.items()?;
    let Some(MenuItemKind::Predefined(item)) = items.get(index) else {
        return Err(setup_error("a default native menu action is unavailable"));
    };
    labels.push((item.clone(), label));
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

    use crate::{NativeMenuAction, NativeMenuLabels, NativeMenuRequest};

    use super::{NativeMenuState, escaped_label, sync};
    #[cfg(not(target_os = "macos"))]
    use super::{help_accelerator, settings_accelerator};

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
    fn syncing_an_unavailable_menu_reports_an_error() {
        assert!(
            sync(
                &NativeMenuState::default(),
                NativeMenuLabels::english(),
                false
            )
            .is_err()
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
