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
#[cfg(target_os = "linux")]
const MINIMIZE_WINDOW_ID: &str = "native-window-minimize";
#[cfg(target_os = "linux")]
const MAXIMIZE_WINDOW_ID: &str = "native-window-maximize";
#[cfg(target_os = "linux")]
const CLOSE_WINDOW_ID: &str = "native-window-close";
#[cfg(not(target_os = "macos"))]
const SETTINGS_SUBMENU_ID: &str = "native-settings-menu";

#[derive(Default)]
pub(crate) struct NativeMenuState(Mutex<Option<NativeMenuItems>>);

struct NativeMenuItems {
    #[cfg(target_os = "linux")]
    menu: Menu<Wry>,
    help: MenuItem<Wry>,
    general_settings: MenuItem<Wry>,
    provider_settings: MenuItem<Wry>,
    model_settings: MenuItem<Wry>,
    template_settings: MenuItem<Wry>,
    localized_submenus: Vec<(Submenu<Wry>, NativeMenuTitle)>,
    localized_predefined: Vec<(PredefinedMenuItem<Wry>, NativeMenuLabel)>,
    #[cfg(target_os = "linux")]
    linux_window_items: Vec<(MenuItem<Wry>, NativeMenuLabel)>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
    PasteAndMatchStyle,
    Delete,
    SelectAll,
    #[cfg(target_os = "macos")]
    Fullscreen,
    Minimize,
    #[cfg(not(target_os = "macos"))]
    Maximize,
    #[cfg(target_os = "macos")]
    Zoom,
    ShowAll,
    BringAllToFront,
    ActualSize,
    ZoomIn,
    ZoomOut,
    StartSpeaking,
    StopSpeaking,
    StartDictation,
    EmojiAndSymbols,
}

impl NativeMenuLabel {
    fn from_default_text(text: &str) -> Option<Self> {
        let text = if text == "Emoji & Symbols" {
            text.to_owned()
        } else {
            text.replace('&', "")
        };
        match text.as_str() {
            #[cfg(not(target_os = "macos"))]
            "About" => Some(Self::About),
            #[cfg(target_os = "macos")]
            "About Epikrise" => Some(Self::AboutApp),
            #[cfg(target_os = "macos")]
            "Services" => Some(Self::Services),
            #[cfg(target_os = "macos")]
            "Hide Epikrise" => Some(Self::HideApp),
            #[cfg(target_os = "macos")]
            "Hide Others" => Some(Self::HideOthers),
            #[cfg(target_os = "macos")]
            "Quit Epikrise" => Some(Self::QuitApp),
            #[cfg(target_os = "windows")]
            "Close" => Some(Self::Close),
            #[cfg(not(target_os = "windows"))]
            "Close Window" => Some(Self::CloseWindow),
            #[cfg(target_os = "windows")]
            "Exit" => Some(Self::Exit),
            "Undo" => Some(Self::Undo),
            "Redo" => Some(Self::Redo),
            "Cut" => Some(Self::Cut),
            "Copy" => Some(Self::Copy),
            "Paste" => Some(Self::Paste),
            "Paste and Match Style" => Some(Self::PasteAndMatchStyle),
            "Delete" => Some(Self::Delete),
            "Select All" => Some(Self::SelectAll),
            #[cfg(target_os = "macos")]
            "Toggle Full Screen" => Some(Self::Fullscreen),
            "Minimize" => Some(Self::Minimize),
            #[cfg(not(target_os = "macos"))]
            "Maximize" => Some(Self::Maximize),
            #[cfg(target_os = "macos")]
            "Zoom" => Some(Self::Zoom),
            "Show All" => Some(Self::ShowAll),
            "Bring All to Front" => Some(Self::BringAllToFront),
            "Actual Size" => Some(Self::ActualSize),
            "Zoom In" => Some(Self::ZoomIn),
            "Zoom Out" => Some(Self::ZoomOut),
            "Start Speaking" => Some(Self::StartSpeaking),
            "Stop Speaking" => Some(Self::StopSpeaking),
            "Start Dictation…" => Some(Self::StartDictation),
            "Emoji & Symbols" => Some(Self::EmojiAndSymbols),
            _ => None,
        }
    }

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
            Self::PasteAndMatchStyle => &labels.paste_and_match_style_action,
            Self::Delete => &labels.delete_action,
            Self::SelectAll => &labels.select_all_action,
            #[cfg(target_os = "macos")]
            Self::Fullscreen => &labels.fullscreen_action,
            Self::Minimize => &labels.minimize_action,
            #[cfg(not(target_os = "macos"))]
            Self::Maximize => &labels.maximize_action,
            #[cfg(target_os = "macos")]
            Self::Zoom => &labels.zoom_action,
            Self::ShowAll => &labels.show_all_action,
            Self::BringAllToFront => &labels.bring_all_to_front_action,
            Self::ActualSize => &labels.actual_size_action,
            Self::ZoomIn => &labels.zoom_in_action,
            Self::ZoomOut => &labels.zoom_out_action,
            Self::StartSpeaking => &labels.start_speaking_action,
            Self::StopSpeaking => &labels.stop_speaking_action,
            Self::StartDictation => &labels.start_dictation_action,
            Self::EmojiAndSymbols => &labels.emoji_and_symbols_action,
        }
    }
}

pub(crate) fn install(app: &AppHandle<Wry>) -> tauri::Result<NativeMenuState> {
    let menu = Menu::default(app)?;
    let labels = NativeMenuLabels::english();
    let edit_menu = find_submenu(&menu, "Edit")?;
    let window_menu = find_submenu_by_id(&menu, WINDOW_SUBMENU_ID)?;
    let help_menu = find_submenu_by_id(&menu, HELP_SUBMENU_ID)?;
    #[cfg(target_os = "linux")]
    let linux_window_items = replace_linux_window_actions(app, &window_menu, &labels)?;
    let mut localized_predefined = Vec::new();
    collect_predefined_labels(&menu, &mut localized_predefined)?;
    let mut localized_submenus = vec![
        (edit_menu.clone(), NativeMenuTitle::Edit),
        (window_menu.clone(), NativeMenuTitle::Window),
        (help_menu.clone(), NativeMenuTitle::Help),
    ];

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
    }

    #[cfg(target_os = "macos")]
    {
        let view_menu = find_submenu(&menu, "View")?;
        localized_submenus.push((view_menu.clone(), NativeMenuTitle::View));
        let Some(MenuItemKind::Submenu(_application_menu)) = menu.items()?.into_iter().next()
        else {
            return Err(setup_error("default macOS application menu is unavailable"));
        };
    }

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
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        {
            let mut help_position = None;
            for (position, item) in menu.items()?.into_iter().enumerate() {
                if let MenuItemKind::Submenu(submenu) = item
                    && submenu.text()? == "Help"
                {
                    help_position = Some(position);
                    break;
                }
            }
            let Some(help_position) = help_position else {
                return Err(setup_error("default Help menu is unavailable"));
            };
            menu.insert(&settings_menu, help_position)?;
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
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

    app.set_menu(menu.clone())?;

    Ok(NativeMenuState(Mutex::new(Some(NativeMenuItems {
        #[cfg(target_os = "linux")]
        menu,
        help,
        general_settings,
        provider_settings,
        model_settings,
        template_settings,
        localized_submenus,
        localized_predefined,
        #[cfg(target_os = "linux")]
        linux_window_items,
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
    #[cfg(target_os = "linux")]
    for (item, label) in &items.linux_window_items {
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
    #[cfg(target_os = "linux")]
    {
        // Reattach the GTK3 menu bar so its top-level labels reflect the new locale.
        items
            .menu
            .set_as_app_menu()
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

#[cfg(target_os = "linux")]
fn replace_linux_window_actions(
    app: &AppHandle<Wry>,
    window_menu: &Submenu<Wry>,
    labels: &NativeMenuLabels,
) -> tauri::Result<Vec<(MenuItem<Wry>, NativeMenuLabel)>> {
    let mut positions = Vec::new();
    for (position, item) in window_menu.items()?.into_iter().enumerate() {
        if let MenuItemKind::Predefined(item) = item
            && let Some(label) = NativeMenuLabel::from_default_text(&item.text()?)
            && matches!(
                label,
                NativeMenuLabel::Minimize
                    | NativeMenuLabel::Maximize
                    | NativeMenuLabel::CloseWindow
            )
        {
            positions.push((position, label));
        }
    }
    if positions.len() != 3 {
        return Err(setup_error("default Linux window actions are unavailable"));
    }

    for (position, _) in positions.iter().rev() {
        window_menu.remove_at(*position)?;
    }

    let mut items = Vec::with_capacity(positions.len());
    for (position, label) in positions {
        let (id, accelerator) = match label {
            NativeMenuLabel::Minimize => (MINIMIZE_WINDOW_ID, Some("Ctrl+M")),
            NativeMenuLabel::Maximize => (MAXIMIZE_WINDOW_ID, None),
            NativeMenuLabel::CloseWindow => (CLOSE_WINDOW_ID, Some("Alt+F4")),
            _ => return Err(setup_error("unexpected Linux window action")),
        };
        let item = MenuItem::with_id(
            app,
            id,
            escaped_label(label.text(labels)),
            true,
            accelerator,
        )?;
        window_menu.insert(&item, position)?;
        items.push((item, label));
    }
    Ok(items)
}

fn collect_predefined_labels(
    menu: &Menu<Wry>,
    labels: &mut Vec<(PredefinedMenuItem<Wry>, NativeMenuLabel)>,
) -> tauri::Result<()> {
    collect_predefined_from_items(menu.items()?, labels)
}

fn collect_predefined_from_items(
    items: Vec<MenuItemKind<Wry>>,
    labels: &mut Vec<(PredefinedMenuItem<Wry>, NativeMenuLabel)>,
) -> tauri::Result<()> {
    for item in items {
        match item {
            MenuItemKind::Submenu(submenu) => {
                collect_predefined_from_items(submenu.items()?, labels)?;
            }
            MenuItemKind::Predefined(item) => {
                if let Some(label) = NativeMenuLabel::from_default_text(&item.text()?) {
                    labels.push((item, label));
                }
            }
            MenuItemKind::MenuItem(_) | MenuItemKind::Check(_) | MenuItemKind::Icon(_) => {}
        }
    }
    Ok(())
}

pub(crate) fn dispatch(app: &AppHandle<Wry>, id: &str) {
    #[cfg(target_os = "linux")]
    if let Some(action) = LinuxWindowAction::from_id(id) {
        let Some(window) = app.get_webview_window("main") else {
            emit_unavailable(app);
            return;
        };
        let result = match action {
            LinuxWindowAction::Minimize => window.minimize(),
            LinuxWindowAction::Maximize => window.maximize(),
            LinuxWindowAction::Close => window.close(),
        };
        if result.is_err() {
            emit_unavailable(app);
        }
        return;
    }

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

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinuxWindowAction {
    Minimize,
    Maximize,
    Close,
}

#[cfg(target_os = "linux")]
impl LinuxWindowAction {
    fn from_id(id: &str) -> Option<Self> {
        match id {
            MINIMIZE_WINDOW_ID => Some(Self::Minimize),
            MAXIMIZE_WINDOW_ID => Some(Self::Maximize),
            CLOSE_WINDOW_ID => Some(Self::Close),
            _ => None,
        }
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

    #[cfg(target_os = "linux")]
    use super::{CLOSE_WINDOW_ID, LinuxWindowAction, MAXIMIZE_WINDOW_ID, MINIMIZE_WINDOW_ID};
    use super::{NativeMenuLabel, NativeMenuState, NativeMenuTitle, escaped_label, sync};
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
    fn native_menu_titles_use_the_selected_locale() {
        let mut labels = NativeMenuLabels::english();
        labels.edit_menu = "Bearbeiten".to_owned();
        labels.window_menu = "Fenster".to_owned();
        labels.help_menu = "Hilfe".to_owned();
        labels.settings_menu = "Einstellungen".to_owned();

        assert_eq!(NativeMenuTitle::Edit.text(&labels), "Bearbeiten");
        assert_eq!(NativeMenuTitle::Window.text(&labels), "Fenster");
        assert_eq!(NativeMenuTitle::Help.text(&labels), "Hilfe");
        #[cfg(not(target_os = "macos"))]
        assert_eq!(NativeMenuTitle::Settings.text(&labels), "Einstellungen");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_window_action_ids_are_stable() {
        assert_eq!(
            LinuxWindowAction::from_id(MINIMIZE_WINDOW_ID),
            Some(LinuxWindowAction::Minimize)
        );
        assert_eq!(
            LinuxWindowAction::from_id(MAXIMIZE_WINDOW_ID),
            Some(LinuxWindowAction::Maximize)
        );
        assert_eq!(
            LinuxWindowAction::from_id(CLOSE_WINDOW_ID),
            Some(LinuxWindowAction::Close)
        );
        assert_eq!(LinuxWindowAction::from_id("unknown"), None);
    }

    #[test]
    fn all_known_predefined_labels_are_localizable_without_position_assumptions() {
        for (default_text, label) in [
            ("Paste and Match Style", NativeMenuLabel::PasteAndMatchStyle),
            ("Delete", NativeMenuLabel::Delete),
            ("Select All", NativeMenuLabel::SelectAll),
            ("Show All", NativeMenuLabel::ShowAll),
            ("Bring All to Front", NativeMenuLabel::BringAllToFront),
            ("Actual Size", NativeMenuLabel::ActualSize),
            ("Zoom In", NativeMenuLabel::ZoomIn),
            ("Zoom Out", NativeMenuLabel::ZoomOut),
            ("Start Speaking", NativeMenuLabel::StartSpeaking),
            ("Stop Speaking", NativeMenuLabel::StopSpeaking),
            ("Start Dictation…", NativeMenuLabel::StartDictation),
            ("Emoji & Symbols", NativeMenuLabel::EmojiAndSymbols),
        ] {
            assert_eq!(
                NativeMenuLabel::from_default_text(default_text),
                Some(label),
                "{default_text}"
            );
        }
        assert_eq!(NativeMenuLabel::from_default_text("My Document"), None);
    }

    #[test]
    fn cached_predefined_labels_survive_locale_round_trips() {
        let cached_label = NativeMenuLabel::from_default_text("Select All").unwrap();
        let mut labels = NativeMenuLabels::english();

        labels.select_all_action = "Alles auswählen".to_owned();
        assert_eq!(cached_label.text(&labels), "Alles auswählen");
        assert_eq!(
            NativeMenuLabel::from_default_text(&labels.select_all_action),
            None
        );

        labels.select_all_action = "Select All".to_owned();
        assert_eq!(cached_label.text(&labels), "Select All");

        labels.select_all_action = "［Seelect Aall］".to_owned();
        assert_eq!(cached_label.text(&labels), "［Seelect Aall］");
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
