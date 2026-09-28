//! Extraction pipeline turning raw inputs into text blocks with provenance.
//!
//! Deliberately free of any Tauri dependency so it can be unit-tested standalone.

#![forbid(unsafe_code)]

use epikrise_core::{ExtractedBlock, InputProvenance};
use serde::Serialize;
use specta::Type;
use thiserror::Error;

#[derive(Debug, Error, Serialize, Type, PartialEq, Eq)]
#[serde(tag = "key", rename_all = "snake_case")]
pub enum IngestError {
    #[error("input is empty")]
    EmptyInput,
    #[error("file is not valid UTF-8 text")]
    InvalidUtf8,
    #[error("unsupported binary file type: {mime}")]
    UnsupportedBinary { mime: String },
    #[error("text contains unsupported control characters")]
    UnsupportedControlCharacters,
}

/// Extracts UTF-8 text; the filename is provenance only and never selects a parser.
pub fn extract_text_file(file_name: String, bytes: Vec<u8>) -> Result<ExtractedBlock, IngestError> {
    if let Some(kind) = infer::get(&bytes) {
        return Err(IngestError::UnsupportedBinary {
            mime: kind.mime_type().to_owned(),
        });
    }

    let text = String::from_utf8(bytes).map_err(|_| IngestError::InvalidUtf8)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    if text.trim().is_empty() {
        return Err(IngestError::EmptyInput);
    }
    if text
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(IngestError::UnsupportedControlCharacters);
    }

    Ok(ExtractedBlock::new(
        uuid::Uuid::new_v4().to_string(),
        InputProvenance::File { name: file_name },
        text.to_owned(),
    ))
}

pub fn extract_raw_text(text: String) -> Result<ExtractedBlock, IngestError> {
    if text.trim().is_empty() {
        return Err(IngestError::EmptyInput);
    }

    Ok(ExtractedBlock::new(
        uuid::Uuid::new_v4().to_string(),
        InputProvenance::RawText,
        text,
    ))
}

#[cfg(test)]
mod tests {
    use super::{IngestError, extract_raw_text, extract_text_file};
    use epikrise_core::InputProvenance;

    #[test]
    fn extracts_nonempty_text_without_mutating_it() {
        let content = "  Finding one\nFinding two  ".to_owned();

        let block = extract_raw_text(content.clone()).expect("nonempty text should extract");

        assert!(!block.id.is_empty());
        assert_eq!(block.round, 0);
        assert_eq!(block.provenance, InputProvenance::RawText);
        assert_eq!(block.content, content);
    }

    #[test]
    fn rejects_empty_or_whitespace_only_text() {
        assert_eq!(
            extract_raw_text(String::new()),
            Err(IngestError::EmptyInput)
        );
        assert_eq!(
            extract_raw_text(" \n\t ".to_owned()),
            Err(IngestError::EmptyInput)
        );
    }

    #[test]
    fn extracts_utf8_text_without_using_filename_as_a_format_hint() {
        let content = "Diagnosis,Finding\nI10,Hypertension";

        let block = extract_text_file("report.csv".to_owned(), content.as_bytes().to_vec())
            .expect("UTF-8 text should extract");

        assert_eq!(
            block.provenance,
            InputProvenance::File {
                name: "report.csv".to_owned()
            }
        );
        assert_eq!(block.content, content);
    }

    #[test]
    fn rejects_detected_binary_even_when_named_as_text() {
        let error = extract_text_file("report.txt".to_owned(), b"%PDF-1.7\n".to_vec())
            .expect_err("PDF bytes should not be interpreted as text");

        assert_eq!(
            error,
            IngestError::UnsupportedBinary {
                mime: "application/pdf".to_owned()
            }
        );
    }

    #[test]
    fn rejects_invalid_utf8_and_embedded_binary_controls() {
        assert_eq!(
            extract_text_file("report.txt".to_owned(), vec![0xff]),
            Err(IngestError::InvalidUtf8)
        );
        assert_eq!(
            extract_text_file("report.txt".to_owned(), b"text\0data".to_vec()),
            Err(IngestError::UnsupportedControlCharacters)
        );
    }
}
