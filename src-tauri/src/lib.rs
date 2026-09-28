use pdfium_render::prelude::{PdfRenderConfig, Pdfium};
use serde::{Deserialize, Serialize};
use specta_typescript::Typescript;
use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsString,
    io::{Seek, SeekFrom, Write},
    path::Path,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager, State, path::BaseDirectory};
use tauri_plugin_shell::ShellExt;
use tauri_specta::{Builder, Event, collect_commands, collect_events};
use tokio_util::sync::CancellationToken;

use epikrise_core::{ClinicalTemplate, TemplateError};
use epikrise_llm::{
    ChatMessage, GenaiLlmClient, KeyringCredentialStore, LlmClient, LlmError, MessageRole,
    ProviderProfile,
};

static PDFIUM: OnceLock<Result<Pdfium, ()>> = OnceLock::new();

struct SensitiveImageFile(tempfile::NamedTempFile);

#[derive(Default)]
struct GenerationRegistry(Mutex<HashMap<String, CancellationToken>>);

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(untagged)]
enum TemplateValue {
    Text(String),
    Boolean(bool),
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct GenerationDelta {
    request_id: String,
    content: String,
}

impl Event for GenerationDelta {
    const NAME: &'static str = "generation://delta";
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct GenerationDone {
    request_id: String,
    content: String,
}

impl Event for GenerationDone {
    const NAME: &'static str = "generation://done";
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct GenerationError {
    request_id: String,
    error: LlmError,
}

impl Event for GenerationError {
    const NAME: &'static str = "generation://error";
}

impl Drop for SensitiveImageFile {
    fn drop(&mut self) {
        let file = self.0.as_file_mut();
        let Ok(length) = file.metadata().map(|metadata| metadata.len()) else {
            return;
        };
        if file.seek(SeekFrom::Start(0)).is_err() {
            return;
        }

        let zeros = [0_u8; 8192];
        let mut remaining = length;
        while remaining > 0 {
            let chunk_length = remaining.min(zeros.len() as u64) as usize;
            if file.write_all(&zeros[..chunk_length]).is_err() {
                break;
            }
            remaining -= chunk_length as u64;
        }
        let _ = file.sync_all();
    }
}

#[tauri::command]
#[specta::specta]
fn validate_template(bytes: Vec<u8>) -> Result<ClinicalTemplate, TemplateError> {
    ClinicalTemplate::from_json(&bytes)
}

#[tauri::command]
#[specta::specta]
fn render_template_system_prompt(
    template: ClinicalTemplate,
    values: BTreeMap<String, TemplateValue>,
    enabled_section_ids: Vec<String>,
) -> Result<String, TemplateError> {
    let values = values
        .into_iter()
        .map(|(name, value)| {
            let value = match value {
                TemplateValue::Text(value) => serde_json::Value::String(value),
                TemplateValue::Boolean(value) => serde_json::Value::Bool(value),
            };
            (name, value)
        })
        .collect();
    template.render_system_prompt_with_sections(&values, &enabled_section_ids)
}

#[tauri::command]
#[specta::specta]
fn create_case_session(id: String, template_id: String) -> epikrise_core::CaseSession {
    epikrise_core::CaseSession::new(id, template_id)
}

#[tauri::command]
#[specta::specta]
fn extract_raw_text(
    text: String,
) -> Result<epikrise_core::ExtractedBlock, epikrise_ingest::IngestError> {
    epikrise_ingest::extract_raw_text(text)
}

#[tauri::command]
#[specta::specta]
fn extract_text_file(
    file_name: String,
    bytes: Vec<u8>,
) -> Result<epikrise_core::ExtractedBlock, epikrise_ingest::IngestError> {
    epikrise_ingest::extract_text_file(file_name, bytes)
}

#[tauri::command]
#[specta::specta]
fn extract_file(
    app: AppHandle,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<epikrise_core::ExtractedBlock, epikrise_ingest::IngestError> {
    epikrise_ingest::extract_file_with_ocr(file_name, bytes, |pdf, pages| {
        ocr_pdf_pages(&app, pdf, pages)
    })
}

#[tauri::command]
#[specta::specta]
async fn test_provider(profile: ProviderProfile) -> Result<(), LlmError> {
    let client = GenaiLlmClient::new(std::sync::Arc::new(KeyringCredentialStore));
    client
        .complete(
            &profile,
            &[ChatMessage {
                role: MessageRole::User,
                content: "Reply with OK.".to_owned(),
            }],
        )
        .await
        .map(|_| ())
}

#[tauri::command]
#[specta::specta]
async fn generate(
    app: AppHandle,
    registry: State<'_, GenerationRegistry>,
    request_id: String,
    profile: ProviderProfile,
    messages: Vec<ChatMessage>,
) -> Result<(), LlmError> {
    let request_id = uuid::Uuid::parse_str(&request_id)
        .map_err(|_| LlmError::InvalidRequest)?
        .to_string();
    let cancellation = CancellationToken::new();
    {
        let mut requests = registry.0.lock().map_err(|_| LlmError::Internal)?;
        if requests.contains_key(&request_id) {
            return Err(LlmError::InvalidRequest);
        }
        requests.insert(request_id.clone(), cancellation.clone());
    }

    let client = GenaiLlmClient::new(std::sync::Arc::new(KeyringCredentialStore));
    let app_for_deltas = app.clone();
    let delta_request_id = request_id.clone();
    let mut emit_delta = move |content| {
        let _ = GenerationDelta {
            request_id: delta_request_id.clone(),
            content,
        }
        .emit(&app_for_deltas);
    };
    let result = client
        .stream(&profile, &messages, cancellation, &mut emit_delta)
        .await;

    registry
        .0
        .lock()
        .map_err(|_| LlmError::Internal)?
        .remove(&request_id);

    match result {
        Ok(content) => GenerationDone {
            request_id,
            content,
        }
        .emit(&app)
        .map_err(|_| LlmError::Internal),
        Err(error) => {
            let _ = GenerationError {
                request_id,
                error: error.clone(),
            }
            .emit(&app);
            Err(error)
        }
    }
}

#[tauri::command]
#[specta::specta]
fn cancel_generation(
    request_id: String,
    registry: State<'_, GenerationRegistry>,
) -> Result<bool, LlmError> {
    let request_id = uuid::Uuid::parse_str(&request_id)
        .map_err(|_| LlmError::InvalidRequest)?
        .to_string();
    let requests = registry.0.lock().map_err(|_| LlmError::Internal)?;
    let Some(cancellation) = requests.get(&request_id) else {
        return Ok(false);
    };
    cancellation.cancel();
    Ok(true)
}

fn ocr_pdf_pages(
    app: &AppHandle,
    bytes: &[u8],
    page_numbers: &[u32],
) -> Result<Vec<String>, epikrise_ingest::IngestError> {
    let resources = app
        .path()
        .resolve("resources/ocr", BaseDirectory::Resource)
        .map_err(|_| epikrise_ingest::IngestError::PdfOcrUnavailable)?;
    let pdfium_path = resources
        .join("pdfium")
        .join(Pdfium::pdfium_platform_library_name());
    let tessdata_dir = resources.join("tessdata");

    ocr_pdf_pages_with(
        bytes,
        page_numbers,
        &pdfium_path,
        &tessdata_dir,
        |image_path, tessdata_dir| {
            let command = app
                .shell()
                .sidecar("tesseract")
                .map_err(|_| epikrise_ingest::IngestError::PdfOcrUnavailable)?;
            let args: [OsString; 6] = [
                image_path.as_os_str().to_owned(),
                "stdout".into(),
                "-l".into(),
                "deu+eng".into(),
                "--tessdata-dir".into(),
                tessdata_dir.as_os_str().to_owned(),
            ];
            let output = std::process::Command::from(command.args(args))
                .output()
                .map_err(|_| epikrise_ingest::IngestError::PdfOcrUnavailable)?;
            if !output.status.success() {
                return Err(epikrise_ingest::IngestError::PdfOcrFailed);
            }
            String::from_utf8(output.stdout).map_err(|_| epikrise_ingest::IngestError::PdfOcrFailed)
        },
    )
}

fn ocr_pdf_pages_with<F>(
    bytes: &[u8],
    page_numbers: &[u32],
    pdfium_path: &Path,
    tessdata_dir: &Path,
    mut recognize: F,
) -> Result<Vec<String>, epikrise_ingest::IngestError>
where
    F: FnMut(&Path, &Path) -> Result<String, epikrise_ingest::IngestError>,
{
    let pdfium = PDFIUM
        .get_or_init(|| {
            Pdfium::bind_to_library(pdfium_path)
                .map(Pdfium::new)
                .map_err(|_| ())
        })
        .as_ref()
        .map_err(|_| epikrise_ingest::IngestError::PdfOcrUnavailable)?;
    let document = pdfium
        .load_pdf_from_byte_vec(bytes.to_vec(), None)
        .map_err(|_| epikrise_ingest::IngestError::PdfOcrFailed)?;
    let mut recognized_pages = Vec::with_capacity(page_numbers.len());

    for page_number in page_numbers {
        let page_index = page_number
            .checked_sub(1)
            .and_then(|page| i32::try_from(page).ok())
            .ok_or(epikrise_ingest::IngestError::PdfOcrFailed)?;
        let image = document
            .pages()
            .get(page_index)
            .and_then(|page| {
                page.render_with_config(
                    &PdfRenderConfig::new()
                        .set_target_width(1800)
                        .set_maximum_width(2200)
                        .set_maximum_height(3000),
                )?
                .as_image()
            })
            .map_err(|_| epikrise_ingest::IngestError::PdfOcrFailed)?;
        let temp_file = tempfile::Builder::new()
            .prefix("epikrise-ocr-")
            .suffix(".png")
            .tempfile()
            .map(SensitiveImageFile)
            .map_err(|_| epikrise_ingest::IngestError::PdfOcrFailed)?;
        image
            .save(temp_file.0.path())
            .map_err(|_| epikrise_ingest::IngestError::PdfOcrFailed)?;
        recognized_pages.push(recognize(temp_file.0.path(), tessdata_dir)?);
    }

    Ok(recognized_pages)
}

#[tauri::command]
#[specta::specta]
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> Result<(), tauri::Error> {
    let builder = Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            cancel_generation,
            create_case_session,
            extract_file,
            extract_raw_text,
            extract_text_file,
            generate,
            greet,
            render_template_system_prompt,
            test_provider,
            validate_template
        ])
        .events(collect_events![
            GenerationDelta,
            GenerationDone,
            GenerationError
        ]);

    #[cfg(debug_assertions)]
    builder
        .export(Typescript::default(), "../src/bindings.ts")
        .map_err(|error| {
            let setup_error: Box<dyn std::error::Error> = Box::new(std::io::Error::other(format!(
                "failed to export TypeScript bindings: {error}"
            )));
            tauri::Error::Setup(setup_error.into())
        })?;

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(GenerationRegistry::default())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            Ok(())
        })
        .run(tauri::generate_context!())
}

#[cfg(test)]
mod tests {
    use super::ocr_pdf_pages_with;
    use std::{path::PathBuf, process::Command};

    #[test]
    #[ignore = "requires the local PDFium, Tesseract, and deu/eng OCR resources"]
    fn renders_a_synthetic_pdf_and_recognizes_its_text() {
        let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/ocr");
        let pdfium_path = resources.join("pdfium/libpdfium.so");
        let tessdata_dir = resources.join("tessdata");
        let pdf = synthetic_text_pdf("OCR TEST 123");
        let recognized = ocr_pdf_pages_with(
            &pdf,
            &[1],
            &pdfium_path,
            &tessdata_dir,
            |image_path, tessdata_dir| {
                let output = Command::new("tesseract")
                    .arg(image_path)
                    .arg("stdout")
                    .args(["-l", "deu+eng", "--tessdata-dir"])
                    .arg(tessdata_dir)
                    .output()
                    .map_err(|_| epikrise_ingest::IngestError::PdfOcrUnavailable)?;
                assert!(
                    output.status.success(),
                    "Tesseract failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                String::from_utf8(output.stdout)
                    .map_err(|_| epikrise_ingest::IngestError::PdfOcrFailed)
            },
        )
        .expect("synthetic PDF should render and OCR");

        assert!(recognized[0].contains("OCR"), "{recognized:?}");
        assert!(recognized[0].contains("123"), "{recognized:?}");
    }

    fn synthetic_text_pdf(text: &str) -> Vec<u8> {
        let stream = format!("BT /F1 32 Tf 72 720 Td ({text}) Tj ET");
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".to_owned(),
            format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", index + 1).as_bytes());
        }
        let xref_offset = pdf.len();
        pdf.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
        pdf.extend_from_slice(b"0000000000 65535 f \n");
        for offset in offsets {
            pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        pdf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        pdf
    }
}
