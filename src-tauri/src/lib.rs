use specta_typescript::Typescript;
use tauri_specta::{Builder, collect_commands};

#[tauri::command]
#[specta::specta]
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> Result<(), tauri::Error> {
    let builder = Builder::<tauri::Wry>::new().commands(collect_commands![greet]);

    #[cfg(debug_assertions)]
    builder
        .export(Typescript::default(), "../src/bindings.ts")
        .map_err(|error| {
            let setup_error: Box<dyn std::error::Error> = Box::new(std::io::Error::other(
                format!("failed to export TypeScript bindings: {error}"),
            ));
            tauri::Error::Setup(setup_error.into())
        })?;

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(builder.invoke_handler())
        .run(tauri::generate_context!())
}
