//! Extraction pipeline turning raw inputs into text blocks with provenance.
//!
//! Deliberately free of any Tauri dependency so it can be unit-tested standalone.

#![forbid(unsafe_code)]

use calamine::{Data, Reader as WorkbookReader, Xlsx, open_workbook_from_rs};
use epikrise_core::{ExtractedBlock, ExtractionMethod, InputProvenance};
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use rtf_parser_tt::{ControlWord, Lexer, Parser, Token};
use serde::Serialize;
use specta::Type;
use std::{
    io::{Cursor, Read},
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use thiserror::Error;
use zip::ZipArchive;

const MAX_DOCX_DOCUMENT_XML_BYTES: u64 = 16 * 1024 * 1024;
const MIN_PDF_CHARACTERS_PER_PAGE: usize = 40;
const MAX_URL_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
const MAX_URL_REDIRECTS: usize = 3;
const MAX_IMAGE_INPUT_BYTES: usize = 20 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 8_192;

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
    #[error("PDF pages {pages:?} require OCR")]
    PdfOcrRequired { pages: Vec<u32> },
    #[error("PDF OCR runtime is unavailable")]
    PdfOcrUnavailable,
    #[error("PDF OCR failed")]
    PdfOcrFailed,
    #[error("scanned PDF contains too many pages for vision fallback")]
    PdfVisionTooManyPages,
    #[error("scanned PDF exceeds the vision attachment size limit")]
    PdfVisionTooLarge,
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
    #[error("HTML conversion failed")]
    HtmlConversionFailed,
    #[error("HTML contains no extractable text")]
    NoHtmlText,
    #[error("RTF document is invalid")]
    InvalidRtf,
    #[error("RTF document contains no extractable text")]
    NoRtfText,
    #[error("URL must use HTTP or HTTPS without credentials")]
    InvalidUrl,
    #[error("URL resolves to a private or reserved address")]
    UnsafeUrl,
    #[error("URL request failed")]
    UrlRequestFailed,
    #[error("URL response exceeded the size limit")]
    UrlResponseTooLarge,
    #[error("URL redirected too many times")]
    TooManyUrlRedirects,
    #[error("URL did not return extractable HTML or text")]
    UnsupportedUrlContent,
    #[error("image input exceeds the size or dimension limit")]
    ImageTooLarge,
    #[error("image format is unsupported; use PNG or JPEG")]
    UnsupportedImage,
    #[error("image data could not be decoded")]
    InvalidImage,
    #[error("image OCR runtime is unavailable")]
    ImageOcrUnavailable,
    #[error("image OCR failed or returned no text")]
    ImageOcrFailed,
}

pub async fn extract_url(address: String) -> Result<ExtractedBlock, IngestError> {
    let mut current_url = validate_url(&address)?;
    for redirect_count in 0..=MAX_URL_REDIRECTS {
        let host = current_url.host_str().ok_or(IngestError::InvalidUrl)?;
        let port = current_url
            .port_or_known_default()
            .ok_or(IngestError::InvalidUrl)?;
        let resolved = tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| IngestError::UrlRequestFailed)?
            .collect::<Vec<SocketAddr>>();
        if resolved.is_empty() || resolved.iter().any(|address| !is_public_ip(address.ip())) {
            return Err(IngestError::UnsafeUrl);
        }

        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .no_proxy()
            .resolve_to_addrs(host, &resolved)
            .build()
            .map_err(|_| IngestError::UrlRequestFailed)?;
        let mut response = client
            .get(current_url.clone())
            .header(reqwest::header::USER_AGENT, "Epikrise/0.1")
            .send()
            .await
            .map_err(|_| IngestError::UrlRequestFailed)?;

        if response.status().is_redirection() {
            if redirect_count == MAX_URL_REDIRECTS {
                return Err(IngestError::TooManyUrlRedirects);
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(IngestError::UrlRequestFailed)?;
            current_url = validate_url(
                current_url
                    .join(location)
                    .map_err(|_| IngestError::InvalidUrl)?
                    .as_str(),
            )?;
            continue;
        }
        if !response.status().is_success() {
            return Err(IngestError::UrlRequestFailed);
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_URL_RESPONSE_BYTES as u64)
        {
            return Err(IngestError::UrlResponseTooLarge);
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| IngestError::UrlRequestFailed)?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_URL_RESPONSE_BYTES {
                return Err(IngestError::UrlResponseTooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }

        let text = match content_type.as_str() {
            "text/html" | "application/xhtml+xml" => {
                extract_readable_html(&bytes, current_url.as_str())?
            }
            "text/plain" => String::from_utf8(bytes).map_err(|_| IngestError::InvalidUtf8)?,
            _ => return Err(IngestError::UnsupportedUrlContent),
        };
        if text.trim().is_empty() {
            return Err(IngestError::NoHtmlText);
        }
        return Ok(ExtractedBlock::new(
            uuid::Uuid::new_v4().to_string(),
            InputProvenance::Url {
                address: current_url.to_string(),
            },
            text,
        ));
    }
    Err(IngestError::TooManyUrlRedirects)
}

fn extract_readable_html(bytes: &[u8], document_url: &str) -> Result<String, IngestError> {
    let html = std::str::from_utf8(bytes).map_err(|_| IngestError::InvalidUtf8)?;
    let mut readability = dom_smoothie::Readability::new(
        html,
        Some(document_url),
        Some(dom_smoothie::Config {
            max_elements_to_parse: 50_000,
            char_threshold: 100,
            text_mode: dom_smoothie::TextMode::Markdown,
            ..dom_smoothie::Config::default()
        }),
    )
    .map_err(|_| IngestError::HtmlConversionFailed)?;
    let article = readability
        .parse()
        .map_err(|_| IngestError::HtmlConversionFailed)?;
    let text = article.text_content.trim();
    if text.is_empty() {
        return Err(IngestError::NoHtmlText);
    }
    Ok(text.to_owned())
}

fn validate_url(address: &str) -> Result<url::Url, IngestError> {
    let parsed = url::Url::parse(address).map_err(|_| IngestError::InvalidUrl)?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(IngestError::InvalidUrl);
    }
    Ok(parsed)
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [first, second, third, _] = address.octets();
            !(address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_unspecified()
                || address.is_broadcast()
                || address.is_multicast()
                || first == 0
                || first >= 240
                || (first == 100 && (64..=127).contains(&second))
                || (first == 192 && second == 0 && (third == 0 || third == 2))
                || (first == 192 && second == 88 && third == 99)
                || (first == 198 && (second == 18 || second == 19))
                || (first == 198 && second == 51 && third == 100)
                || (first == 203 && second == 0 && third == 113))
        }
        IpAddr::V6(address) => {
            let segments = address.segments();
            !(address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || (segments[0] & 0xe000) != 0x2000
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] == 0x2001 && segments[1] <= 0x01ff)
                || segments[0] == 0x2002
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || address
                    .to_ipv4_mapped()
                    .is_some_and(|mapped| !is_public_ip(IpAddr::V4(mapped))))
        }
    }
}

pub fn extract_image_with_ocr<F>(
    file_name: String,
    bytes: &[u8],
    recognize: F,
) -> Result<ExtractedBlock, IngestError>
where
    F: FnOnce(&[u8]) -> Result<String, IngestError>,
{
    let (normalized, _) = normalize_image(bytes)?;
    let text = recognize(&normalized)?;
    if text.trim().is_empty() {
        return Err(IngestError::ImageOcrFailed);
    }
    let mut block = ExtractedBlock::new(
        uuid::Uuid::new_v4().to_string(),
        InputProvenance::File { name: file_name },
        text,
    );
    block.extraction_method = ExtractionMethod::Ocr;
    Ok(block)
}

pub fn extract_image_for_vision(
    file_name: String,
    bytes: &[u8],
) -> Result<ExtractedBlock, IngestError> {
    let (normalized, mime_type) = normalize_image(bytes)?;
    let mut block = ExtractedBlock::new(
        uuid::Uuid::new_v4().to_string(),
        InputProvenance::File {
            name: file_name.clone(),
        },
        "Image attached for visual analysis.",
    );
    block.extraction_method = ExtractionMethod::Vision;
    block.images.push(epikrise_core::ImageAttachment {
        mime_type,
        data: normalized,
        name: file_name,
    });
    Ok(block)
}

fn normalize_image(bytes: &[u8]) -> Result<(Vec<u8>, String), IngestError> {
    if bytes.len() > MAX_IMAGE_INPUT_BYTES {
        return Err(IngestError::ImageTooLarge);
    }
    match infer::get(bytes).map(|kind| kind.mime_type()) {
        Some("image/png" | "image/jpeg") => {}
        _ => return Err(IngestError::UnsupportedImage),
    }
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| IngestError::InvalidImage)?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| IngestError::InvalidImage)?;
    let mut normalized = Cursor::new(Vec::new());
    decoded
        .write_to(&mut normalized, image::ImageFormat::Png)
        .map_err(|_| IngestError::InvalidImage)?;
    Ok((normalized.into_inner(), "image/png".to_owned()))
}

pub fn extract_file(file_name: String, bytes: Vec<u8>) -> Result<ExtractedBlock, IngestError> {
    match infer::get(&bytes).map(|kind| kind.mime_type()) {
        Some("application/pdf") => extract_pdf_file(file_name, bytes),
        Some("text/html") => extract_html_file(file_name, bytes),
        Some("application/rtf") => extract_rtf_file(file_name, bytes),
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

pub fn extract_file_with_ocr<F>(
    file_name: String,
    bytes: Vec<u8>,
    ocr_pages: F,
) -> Result<ExtractedBlock, IngestError>
where
    F: FnOnce(&[u8], &[u32]) -> Result<Vec<String>, IngestError>,
{
    if infer::get(&bytes).map(|kind| kind.mime_type()) != Some("application/pdf") {
        return extract_file(file_name, bytes);
    }

    let mut pages = extract_pdf_pages(&bytes)?;
    if pages.is_empty() {
        return Err(IngestError::NoTextExtracted);
    }
    let sparse_pages = sparse_pdf_pages(&pages);
    let extraction_method = if sparse_pages.is_empty() {
        ExtractionMethod::Parsed
    } else {
        ExtractionMethod::Ocr
    };
    if !sparse_pages.is_empty() {
        let recognized_pages = ocr_pages(&bytes, &sparse_pages)?;
        if recognized_pages.len() != sparse_pages.len() {
            return Err(IngestError::PdfOcrFailed);
        }
        for (page_number, recognized_text) in sparse_pages.iter().zip(recognized_pages) {
            let Some(page_text) = pages.get_mut((*page_number - 1) as usize) else {
                return Err(IngestError::PdfOcrFailed);
            };
            if recognized_text.trim().is_empty() {
                return Err(IngestError::PdfOcrFailed);
            }
            if recognized_text.trim() != page_text.trim() {
                page_text.push('\n');
                page_text.push_str(recognized_text.trim());
            }
        }
    }

    let text = pages.join("\n");
    if text.trim().is_empty() {
        return Err(IngestError::NoTextExtracted);
    }

    let mut block = ExtractedBlock::new(
        uuid::Uuid::new_v4().to_string(),
        InputProvenance::File { name: file_name },
        text,
    );
    block.extraction_method = extraction_method;
    Ok(block)
}

fn extract_html_file(file_name: String, bytes: Vec<u8>) -> Result<ExtractedBlock, IngestError> {
    let text = html2text::from_read(bytes.as_slice(), 120)
        .map_err(|_| IngestError::HtmlConversionFailed)?;
    if text.trim().is_empty() {
        return Err(IngestError::NoHtmlText);
    }

    Ok(ExtractedBlock::new(
        uuid::Uuid::new_v4().to_string(),
        InputProvenance::File { name: file_name },
        text,
    ))
}

fn extract_rtf_file(file_name: String, bytes: Vec<u8>) -> Result<ExtractedBlock, IngestError> {
    let source = String::from_utf8(bytes).map_err(|_| IngestError::InvalidUtf8)?;
    let tokens = Lexer::scan(&source).map_err(|_| IngestError::InvalidRtf)?;
    validate_rtf_unicode(&tokens)?;
    let document = Parser::new(tokens)
        .parse()
        .map_err(|_| IngestError::InvalidRtf)?;
    let text = document.get_text();
    if text.trim().is_empty() {
        return Err(IngestError::NoRtfText);
    }

    Ok(ExtractedBlock::new(
        uuid::Uuid::new_v4().to_string(),
        InputProvenance::File { name: file_name },
        text,
    ))
}

fn validate_rtf_unicode(tokens: &[Token<'_>]) -> Result<(), IngestError> {
    let mut index = 0;
    while index < tokens.len() {
        let Token::ControlSymbol((ControlWord::Unicode, property)) = &tokens[index] else {
            index += 1;
            continue;
        };

        let mut code_units = Vec::new();
        code_units.push(
            property
                .get_unicode_value()
                .map_err(|_| IngestError::InvalidRtf)?,
        );
        index += 1;
        while let Some(Token::ControlSymbol((ControlWord::Unicode, property))) = tokens.get(index) {
            code_units.push(
                property
                    .get_unicode_value()
                    .map_err(|_| IngestError::InvalidRtf)?,
            );
            index += 1;
        }
        String::from_utf16(&code_units).map_err(|_| IngestError::InvalidRtf)?;
    }
    Ok(())
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
    let pages = extract_pdf_pages(&bytes)?;
    if pages.is_empty() {
        return Err(IngestError::NoTextExtracted);
    }
    let pages_requiring_ocr = sparse_pdf_pages(&pages);
    if !pages_requiring_ocr.is_empty() {
        return Err(IngestError::PdfOcrRequired {
            pages: pages_requiring_ocr,
        });
    }
    let text = pages.join("\n");

    Ok(ExtractedBlock::new(
        uuid::Uuid::new_v4().to_string(),
        InputProvenance::File { name: file_name },
        text,
    ))
}

fn extract_pdf_pages(bytes: &[u8]) -> Result<Vec<String>, IngestError> {
    pdf_extract::extract_text_from_mem_by_pages(bytes).map_err(|_| IngestError::PdfExtractionFailed)
}

pub fn pdf_page_texts_and_ocr_targets(
    bytes: &[u8],
) -> Result<(Vec<String>, Vec<u32>), IngestError> {
    let pages = extract_pdf_pages(bytes)?;
    if pages.is_empty() {
        return Err(IngestError::NoTextExtracted);
    }
    let targets = sparse_pdf_pages(&pages);
    Ok((pages, targets))
}

fn sparse_pdf_pages(pages: &[String]) -> Vec<u32> {
    pages
        .iter()
        .enumerate()
        .filter(|(_, page)| {
            page.chars()
                .filter(|character| !character.is_whitespace())
                .count()
                < MIN_PDF_CHARACTERS_PER_PAGE
        })
        .map(|(index, _)| index as u32 + 1)
        .collect::<Vec<_>>()
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

    let mut block = ExtractedBlock::new(
        uuid::Uuid::new_v4().to_string(),
        InputProvenance::RawText,
        text,
    );
    block.extraction_method = ExtractionMethod::Manual;
    Ok(block)
}

#[cfg(test)]
mod tests {
    use super::{
        IngestError, extract_file, extract_file_with_ocr, extract_image_for_vision,
        extract_image_with_ocr, extract_raw_text, extract_readable_html, extract_text_file,
        extract_url, is_public_ip, pdf_page_texts_and_ocr_targets, validate_url,
    };
    use epikrise_core::{ExtractionMethod, InputProvenance};
    use std::{
        io::{Cursor, Write},
        net::IpAddr,
    };
    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    #[test]
    fn rejects_non_http_urls_and_embedded_credentials() {
        assert_eq!(
            validate_url("file:///etc/passwd"),
            Err(IngestError::InvalidUrl)
        );
        assert_eq!(
            validate_url("https://user:secret@example.org"),
            Err(IngestError::InvalidUrl)
        );
        assert!(validate_url("https://example.org/path").is_ok());
    }

    #[test]
    fn rejects_private_and_reserved_destination_addresses() {
        for address in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
        ] {
            let parsed = address
                .parse::<IpAddr>()
                .expect("test address should parse");
            assert!(!is_public_ip(parsed), "{address} must be blocked");
        }
        assert!(is_public_ip("1.1.1.1".parse().expect("public IPv4 parses")));
        assert!(is_public_ip(
            "2606:4700:4700::1111".parse().expect("public IPv6 parses")
        ));
    }

    #[tokio::test]
    async fn blocks_loopback_url_before_connecting() {
        assert_eq!(
            extract_url("http://127.0.0.1:8080/".to_owned()).await,
            Err(IngestError::UnsafeUrl)
        );
    }

    #[test]
    fn image_input_is_normalized_for_ocr_or_vision() {
        let mut image_bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut image_bytes, image::ImageFormat::Png)
            .expect("synthetic image should encode");
        let image_bytes = image_bytes.into_inner();

        let extracted = extract_image_with_ocr("screen.png".to_owned(), &image_bytes, |png| {
            assert_eq!(
                infer::get(png).map(|kind| kind.mime_type()),
                Some("image/png")
            );
            Ok("Recognized clinical finding".to_owned())
        })
        .expect("OCR output should be returned as text");
        assert_eq!(extracted.content, "Recognized clinical finding");
        assert_eq!(extracted.extraction_method, ExtractionMethod::Ocr);
        assert!(extracted.images.is_empty());

        let vision = extract_image_for_vision("screen.png".to_owned(), &image_bytes)
            .expect("vision fallback should produce a normalized image attachment");
        assert_eq!(vision.extraction_method, ExtractionMethod::Vision);
        assert_eq!(
            vision.images.first().map(|image| image.mime_type.as_str()),
            Some("image/png")
        );
        assert_eq!(
            infer::get(&vision.images[0].data).map(|kind| kind.mime_type()),
            Some("image/png")
        );

        let mut jpeg_bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut jpeg_bytes, image::ImageFormat::Jpeg)
            .expect("synthetic JPEG should encode");
        let jpeg_vision =
            extract_image_for_vision("screen.jpg".to_owned(), &jpeg_bytes.into_inner())
                .expect("JPEG should be normalized for vision");
        assert_eq!(
            jpeg_vision
                .images
                .first()
                .map(|image| image.mime_type.as_str()),
            Some("image/png")
        );
    }

    #[test]
    fn rejects_unsupported_image_data() {
        assert_eq!(
            extract_image_for_vision("screen.gif".to_owned(), b"not an image"),
            Err(IngestError::UnsupportedImage)
        );
    }

    #[test]
    fn extracts_nonempty_text_without_mutating_it() {
        let content = "  Finding one\nFinding two  ".to_owned();

        let block = extract_raw_text(content.clone()).expect("nonempty text should extract");

        assert!(!block.id.is_empty());
        assert_eq!(block.round, 0);
        assert_eq!(block.provenance, InputProvenance::RawText);
        assert_eq!(block.extraction_method, ExtractionMethod::Manual);
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
        let pdf = text_pdf("Synthetic PDF finding with enough text to pass the quality threshold.");

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
            Err(IngestError::PdfOcrRequired { pages: vec![1] })
        );
    }

    #[test]
    fn identifies_only_sparse_pdf_pages_for_ocr() {
        let pdf = text_pdf_pages(&[
            "This page contains enough extracted text to pass the quality threshold.",
            "Short",
            "This final page also contains enough text to pass the quality threshold.",
        ]);

        let (pages, vision_targets) =
            pdf_page_texts_and_ocr_targets(&pdf).expect("PDF pages should be classified");
        assert_eq!(pages.len(), 3);
        assert_eq!(vision_targets, vec![2]);
        assert_eq!(
            extract_file("mixed.pdf".to_owned(), pdf),
            Err(IngestError::PdfOcrRequired { pages: vec![2] })
        );
    }

    #[test]
    fn merges_ocr_text_only_into_sparse_pdf_pages_in_order() {
        let pdf = text_pdf_pages(&[
            "This page contains enough extracted text to pass the quality threshold.",
            "Short",
            "This final page also contains enough text to pass the quality threshold.",
        ]);
        let mut requested_pages = Vec::new();

        let block = extract_file_with_ocr("mixed.pdf".to_owned(), pdf, |_, pages| {
            requested_pages.extend_from_slice(pages);
            Ok(vec!["OCR text for page two".to_owned()])
        })
        .expect("sparse pages should be supplied by the OCR callback");

        assert_eq!(requested_pages, vec![2]);
        assert_eq!(block.extraction_method, ExtractionMethod::Ocr);
        assert!(block.content.contains("Short\nOCR text for page two"));
        assert!(
            block
                .content
                .contains("This final page also contains enough text")
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

    #[test]
    fn extracts_html_text_and_decodes_entities_by_content() {
        let html = b"<!doctype html><html><body><h1>Diagnoses</h1><p>Hypertension &amp; diabetes</p><script>ignored()</script></body></html>".to_vec();

        let block = extract_file("report.data".to_owned(), html)
            .expect("HTML should be extracted regardless of filename");

        assert!(block.content.contains("Diagnoses"));
        assert!(block.content.contains("Hypertension & diabetes"));
        assert!(!block.content.contains("ignored()"));
    }

    #[test]
    fn url_readability_excludes_navigation_and_footer_content() {
        let html = br#"<!doctype html><html><head><title>Clinical article</title></head><body>
            <nav><a href="/">Home</a> <a href="/news">News</a> Navigation-only label</nav>
            <article><h1>Study findings</h1>
                <p>The study reports a clinically relevant finding that was observed during follow-up. The patient remained stable, and the measurements were documented in the report.</p>
                <p>Additional examination results are described with their dates, values, and uncertainty. These details belong to the article body and should remain available for careful review.</p>
                <p>The authors conclude that the findings should be interpreted in context and do not establish a new diagnosis without further clinical assessment.</p>
            </article>
            <footer>Privacy policy Terms of service Footer-only label</footer>
        </body></html>"#;

        let text = extract_readable_html(html, "https://example.org/article")
            .expect("readability should extract the main article");

        assert!(text.contains("Study findings"));
        assert!(text.contains("clinically relevant finding"));
        assert!(!text.contains("Navigation-only label"));
        assert!(!text.contains("Footer-only label"));
    }

    #[test]
    fn extracts_rtf_text_and_special_characters_by_content() {
        let rtf = br#"{\rtf1\ansi Diagnosis\emdash finding {\b bold} \uc0\u252 berpr\uc0\u252 ft}"#
            .to_vec();

        let block = extract_file("report.data".to_owned(), rtf)
            .expect("RTF should be extracted regardless of filename");

        assert!(block.content.contains("Diagnosis—finding"));
        assert!(block.content.contains("bold"));
        assert!(block.content.contains("überprüft"), "{:?}", block.content);
    }

    #[test]
    fn rejects_invalid_and_empty_rtf_or_html_content() {
        assert_eq!(
            extract_file("broken.rtf".to_owned(), b"{\\rtf1 ".to_vec()),
            Err(IngestError::InvalidRtf)
        );
        assert_eq!(
            extract_file(
                "empty.rtf".to_owned(),
                br#"{\rtf1\ansi {\fonttbl\f0 Arial;}}"#.to_vec()
            ),
            Err(IngestError::NoRtfText)
        );
        assert_eq!(
            extract_file(
                "surrogate.rtf".to_owned(),
                br#"{\rtf1\ansi\uc0\u-10179}"#.to_vec()
            ),
            Err(IngestError::InvalidRtf)
        );
        assert_eq!(
            extract_file(
                "empty.html".to_owned(),
                b"<html><body></body></html>".to_vec()
            ),
            Err(IngestError::NoHtmlText)
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
        text_pdf_pages(&[text])
    }

    fn text_pdf_pages(pages: &[&str]) -> Vec<u8> {
        let font_object = pages.len() * 2 + 3;
        let page_references = (0..pages.len())
            .map(|index| format!("{} 0 R", index * 2 + 3))
            .collect::<Vec<_>>()
            .join(" ");
        let mut objects = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
            format!(
                "<< /Type /Pages /Kids [{page_references}] /Count {} >>",
                pages.len()
            ),
        ];
        for (index, text) in pages.iter().enumerate() {
            let escaped = text
                .replace('\\', "\\\\")
                .replace('(', "\\(")
                .replace(')', "\\)");
            let stream = format!("BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET");
            let page_object = index * 2 + 3;
            let content_object = page_object + 1;
            objects.push(format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font_object} 0 R >> >> /Contents {content_object} 0 R >>"
            ));
            objects.push(format!(
                "<< /Length {} >>\nstream\n{stream}\nendstream",
                stream.len()
            ));
        }
        objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned());
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
