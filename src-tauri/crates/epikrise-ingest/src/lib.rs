//! Extraction pipeline turning raw inputs into text blocks with provenance.
//!
//! Deliberately free of any Tauri dependency so it can be unit-tested standalone.

#![forbid(unsafe_code)]

use calamine::{Data, Reader as WorkbookReader, Xlsx, open_workbook_from_rs};
use epikrise_core::{ExtractedBlock, InputProvenance};
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde::Serialize;
use specta::Type;
use std::io::{Cursor, Read};
use thiserror::Error;
use zip::ZipArchive;

const MAX_DOCX_DOCUMENT_XML_BYTES: u64 = 16 * 1024 * 1024;

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
    #[error("PDF text extraction failed")]
    PdfExtractionFailed,
    #[error("PDF contains no extractable text")]
    NoTextExtracted,
    #[error("invalid DOCX archive")]
    InvalidDocxArchive,
    #[error("DOCX is missing word/document.xml")]
    MissingDocxDocument,
    #[error("DOCX document XML exceeds the size limit")]
    DocxDocumentTooLarge,
    #[error("DOCX document XML is invalid")]
    InvalidDocxXml,
    #[error("XLSX workbook is invalid")]
    InvalidXlsx,
    #[error("XLSX workbook contains no worksheets")]
    NoXlsxWorksheets,
    #[error("XLSX workbook contains no extractable text")]
    NoXlsxText,
}

pub fn extract_file(file_name: String, bytes: Vec<u8>) -> Result<ExtractedBlock, IngestError> {
    match infer::get(&bytes).map(|kind| kind.mime_type()) {
        Some("application/pdf") => extract_pdf_file(file_name, bytes),
        Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") => {
            extract_xlsx_file(file_name, bytes)
        }
        Some("application/zip")
        | Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document") => {
            extract_docx_file(file_name, bytes)
        }
        Some(mime) => Err(IngestError::UnsupportedBinary {
            mime: mime.to_owned(),
        }),
        None => extract_text_file(file_name, bytes),
    }
}

fn extract_xlsx_file(file_name: String, bytes: Vec<u8>) -> Result<ExtractedBlock, IngestError> {
    let cursor = Cursor::new(bytes);
    let mut workbook: Xlsx<_> =
        open_workbook_from_rs(cursor).map_err(|_| IngestError::InvalidXlsx)?;
    let sheet_names = workbook.sheet_names();
    if sheet_names.is_empty() {
        return Err(IngestError::NoXlsxWorksheets);
    }

    let mut output = String::new();
    for sheet_name in sheet_names {
        let range = workbook
            .worksheet_range(&sheet_name)
            .map_err(|_| IngestError::InvalidXlsx)?;
        let mut sheet_text = String::new();
        for row in range.rows() {
            let cells: Vec<String> = row.iter().map(Data::to_string).collect();
            let Some(last_nonempty) = cells.iter().rposition(|cell| !cell.trim().is_empty()) else {
                continue;
            };
            sheet_text.push_str(
                &cells[..=last_nonempty]
                    .iter()
                    .map(|cell| cell.replace(['\t', '\r', '\n'], " "))
                    .collect::<Vec<_>>()
                    .join("\t"),
            );
            sheet_text.push('\n');
        }
        if !sheet_text.is_empty() {
            if !output.is_empty() {
                output.push('\n');
            }
            output.push_str("[Sheet: ");
            output.push_str(&sheet_name);
            output.push_str("]\n");
            output.push_str(&sheet_text);
        }
    }
    if output.trim().is_empty() {
        return Err(IngestError::NoXlsxText);
    }

    Ok(ExtractedBlock::new(
        uuid::Uuid::new_v4().to_string(),
        InputProvenance::File { name: file_name },
        output,
    ))
}

fn extract_pdf_file(file_name: String, bytes: Vec<u8>) -> Result<ExtractedBlock, IngestError> {
    let text =
        pdf_extract::extract_text_from_mem(&bytes).map_err(|_| IngestError::PdfExtractionFailed)?;
    if text.trim().is_empty() {
        return Err(IngestError::NoTextExtracted);
    }

    Ok(ExtractedBlock::new(
        uuid::Uuid::new_v4().to_string(),
        InputProvenance::File { name: file_name },
        text,
    ))
}

fn extract_docx_file(file_name: String, bytes: Vec<u8>) -> Result<ExtractedBlock, IngestError> {
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|_| IngestError::InvalidDocxArchive)?;
    let mut document = archive
        .by_name("word/document.xml")
        .map_err(|_| IngestError::MissingDocxDocument)?;
    if document.size() > MAX_DOCX_DOCUMENT_XML_BYTES {
        return Err(IngestError::DocxDocumentTooLarge);
    }

    let mut xml = Vec::new();
    (&mut document)
        .take(MAX_DOCX_DOCUMENT_XML_BYTES + 1)
        .read_to_end(&mut xml)
        .map_err(|_| IngestError::InvalidDocxArchive)?;
    if xml.len() as u64 > MAX_DOCX_DOCUMENT_XML_BYTES {
        return Err(IngestError::DocxDocumentTooLarge);
    }

    let text = extract_docx_xml_text(&xml)?;
    if text.trim().is_empty() {
        return Err(IngestError::NoTextExtracted);
    }

    Ok(ExtractedBlock::new(
        uuid::Uuid::new_v4().to_string(),
        InputProvenance::File { name: file_name },
        text,
    ))
}

fn extract_docx_xml_text(xml: &[u8]) -> Result<String, IngestError> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut output = String::new();
    let mut in_text = false;

    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|_| IngestError::InvalidDocxXml)?
        {
            Event::Start(element) => match element.local_name().as_ref() {
                "t" => in_text = true,
                "tab" => output.push('\t'),
                "br" | "cr" => output.push('\n'),
                _ => {}
            },
            Event::Empty(element) => match element.local_name().as_ref() {
                "tab" => output.push('\t'),
                "br" | "cr" => output.push('\n'),
                _ => {}
            },
            Event::Text(text) if in_text => {
                let decoded = text.xml10_content();
                output.push_str(&decoded);
            }
            Event::GeneralRef(reference) if in_text => {
                if let Some(character) = reference
                    .resolve_char_ref()
                    .map_err(|_| IngestError::InvalidDocxXml)?
                {
                    output.push(character);
                } else {
                    output.push(match reference.xml10_content().as_ref() {
                        "amp" => '&',
                        "lt" => '<',
                        "gt" => '>',
                        "quot" => '"',
                        "apos" => '\'',
                        _ => return Err(IngestError::InvalidDocxXml),
                    });
                }
            }
            Event::End(element) => match element.local_name().as_ref() {
                "t" => in_text = false,
                "p" if !output.is_empty() && !output.ends_with('\n') => output.push('\n'),
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }

    Ok(output)
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
    use super::{IngestError, extract_file, extract_raw_text, extract_text_file};
    use epikrise_core::InputProvenance;
    use std::io::{Cursor, Write};
    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

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

    #[test]
    fn extracts_text_from_a_pdf_by_content_signature() {
        let pdf = text_pdf("Synthetic PDF finding");

        let block = extract_file("not-a-pdf.txt".to_owned(), pdf)
            .expect("PDF content should be extracted regardless of filename");

        assert_eq!(
            block.provenance,
            InputProvenance::File {
                name: "not-a-pdf.txt".to_owned()
            }
        );
        assert!(block.content.contains("Synthetic PDF finding"));
    }

    #[test]
    fn reports_malformed_pdf_and_pdf_without_text() {
        assert_eq!(
            extract_file(
                "broken.pdf".to_owned(),
                b"%PDF-1.7\nnot a document".to_vec()
            ),
            Err(IngestError::PdfExtractionFailed)
        );
        assert_eq!(
            extract_file("scan.pdf".to_owned(), text_pdf("")),
            Err(IngestError::NoTextExtracted)
        );
    }

    #[test]
    fn extracts_text_runs_and_structure_from_docx_by_archive_content() {
        let bytes = docx_file(
            "<w:document xmlns:w=\"urn:word\"><w:body><w:p><w:r><w:t>Diagnosis &amp; history</w:t></w:r></w:p><w:p><w:r><w:t>Finding</w:t><w:tab/><w:t>Two</w:t></w:r></w:p></w:body></w:document>",
        );

        let block = extract_file("misleading.txt".to_owned(), bytes)
            .expect("DOCX content should be extracted regardless of filename");

        assert_eq!(block.content, "Diagnosis & history\nFinding\tTwo\n");
        assert_eq!(
            block.provenance,
            InputProvenance::File {
                name: "misleading.txt".to_owned()
            }
        );
    }

    #[test]
    fn reports_invalid_docx_and_xlsx_archives() {
        assert_eq!(
            extract_file("broken.docx".to_owned(), b"PK\x03\x04broken".to_vec()),
            Err(IngestError::InvalidDocxArchive)
        );
        assert_eq!(
            extract_file(
                "workbook.docx".to_owned(),
                zip_file("xl/workbook.xml", "<workbook/>")
            ),
            Err(IngestError::InvalidXlsx)
        );
    }

    #[test]
    fn extracts_rows_and_sheet_names_from_xlsx_by_content() {
        let bytes = xlsx_file(&[
            (
                "Diagnoses",
                "<row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>Diagnosis</t></is></c><c r=\"B1\" t=\"inlineStr\"><is><t>Finding</t></is></c></row><row r=\"2\"><c r=\"A2\" t=\"inlineStr\"><is><t>I10</t></is></c><c r=\"B2\" t=\"inlineStr\"><is><t>Hypertension</t></is></c></row>",
            ),
            (
                "Medication",
                "<row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>Drug</t></is></c><c r=\"B1\"><v>5</v></c></row>",
            ),
        ]);

        let block = extract_file("workbook.bin".to_owned(), bytes)
            .expect("XLSX content should extract regardless of filename");

        assert!(
            block
                .content
                .contains("[Sheet: Diagnoses]\nDiagnosis\tFinding")
        );
        assert!(block.content.contains("I10\tHypertension"));
        assert!(block.content.contains("[Sheet: Medication]\nDrug\t5"));
        assert_eq!(
            block.provenance,
            InputProvenance::File {
                name: "workbook.bin".to_owned()
            }
        );
    }

    #[test]
    fn reports_invalid_and_empty_xlsx_workbooks() {
        assert_eq!(
            extract_file("broken.xlsx".to_owned(), xlsx_file(&[])),
            Err(IngestError::NoXlsxWorksheets)
        );
        assert_eq!(
            extract_file("invalid.xlsx".to_owned(), xlsx_file(&[("Empty", "")])),
            Err(IngestError::NoXlsxText)
        );
    }

    fn docx_file(document_xml: &str) -> Vec<u8> {
        zip_file("word/document.xml", document_xml)
    }

    fn zip_file(name: &str, content: &str) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(cursor);
        writer
            .start_file(name, SimpleFileOptions::default())
            .expect("test archive entry should be created");
        writer
            .write_all(content.as_bytes())
            .expect("test XML should be written");
        writer
            .finish()
            .expect("test archive should finish")
            .into_inner()
    }

    fn xlsx_file(sheets: &[(&str, &str)]) -> Vec<u8> {
        let mut entries = vec![
            (
                "[Content_Types].xml".to_owned(),
                "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/></Types>".to_owned(),
            ),
            (
                "_rels/.rels".to_owned(),
                "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>".to_owned(),
            ),
        ];
        let workbook_sheets = sheets
            .iter()
            .enumerate()
            .map(|(index, (name, _))| {
                format!(
                    "<sheet name=\"{name}\" sheetId=\"{}\" r:id=\"rId{}\"/>",
                    index + 1,
                    index + 1
                )
            })
            .collect::<String>();
        entries.push((
            "xl/workbook.xml".to_owned(),
            format!("<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets>{workbook_sheets}</sheets></workbook>"),
        ));
        let relationships = sheets
            .iter()
            .enumerate()
            .map(|(index, _)| {
                format!("<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{}.xml\"/>", index + 1, index + 1)
            })
            .collect::<String>();
        entries.push((
            "xl/_rels/workbook.xml.rels".to_owned(),
            format!("<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{relationships}</Relationships>"),
        ));
        for (index, (_, rows)) in sheets.iter().enumerate() {
            entries.push((
                format!("xl/worksheets/sheet{}.xml", index + 1),
                format!("<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>{rows}</sheetData></worksheet>"),
            ));
        }

        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, contents) in entries {
            writer
                .start_file(name, SimpleFileOptions::default())
                .expect("XLSX fixture entry should be created");
            writer
                .write_all(contents.as_bytes())
                .expect("XLSX fixture content should be written");
        }
        writer
            .finish()
            .expect("XLSX fixture archive should finish")
            .into_inner()
    }

    fn text_pdf(text: &str) -> Vec<u8> {
        let escaped = text
            .replace('\\', "\\\\")
            .replace('(', "\\(")
            .replace(')', "\\)");
        let stream = format!("BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET");
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_owned(),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
            format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
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
