//! Document-owned assets and create-only conflict copies. No Session/Sidecar IO.

use std::io::Read;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};

use super::files_b64::write_unique_file;
use super::path_safety::{
    open_regular_file_no_follow, reject_managed_global_skill_mutation,
    resolve_existing_inside_workspace, resolve_inside_workspace, sanitize_filename,
    validate_external_read_path, validate_item_name, validate_workspace_root,
};

const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MarkdownImageSource {
    Path { path: String },
    Base64 { name: String, base64: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownImportedFile {
    pub path: String,
    pub name: String,
    pub size: usize,
    pub mime_type: String,
}

#[tauri::command]
pub async fn cmd_workspace_import_markdown_image(
    workspace: String,
    document_path: String,
    remaining_bytes: usize,
    source: MarkdownImageSource,
) -> Result<MarkdownImportedFile, String> {
    let root = validate_workspace_root(&workspace)?;
    let _mutation = super::acquire_edit_mutation(&root).await;
    tokio::task::spawn_blocking(move || {
        import_image(&root, &document_path, remaining_bytes, source)
    })
    .await
    .map_err(|error| format!("Image import status unknown: {}", error))?
}

fn document_location(
    root: &Path,
    relative: &str,
    require_existing: bool,
) -> Result<(PathBuf, String), String> {
    let lexical = resolve_inside_workspace(root, relative)?;
    reject_managed_global_skill_mutation(root, &lexical)?;
    let extension = lexical
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !matches!(
        extension.to_ascii_lowercase().as_str(),
        "md" | "markdown" | "mdown" | "mkd"
    ) {
        return Err("A Markdown document is required".to_string());
    }
    if require_existing {
        let document = resolve_existing_inside_workspace(root, relative)?;
        reject_managed_global_skill_mutation(root, &document)?;
        if !document.is_file() {
            return Err("Document is not a regular file".to_string());
        }
    }
    let stem = lexical
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("Invalid document filename")?;
    let parent = lexical.parent().ok_or("Invalid document directory")?;
    let parent_relative = parent
        .strip_prefix(root)
        .map_err(|_| "Document escaped workspace")?;
    // Copies of a deleted document are allowed, but its directory must exist.
    resolve_existing_inside_workspace(root, &parent_relative.to_string_lossy())?;
    Ok((parent.to_path_buf(), stem.to_string()))
}

fn import_image(
    root: &PathBuf,
    document_path: &str,
    remaining_bytes: usize,
    source: MarkdownImageSource,
) -> Result<MarkdownImportedFile, String> {
    let (parent, stem) = document_location(root, document_path, true)?;
    let cap = MAX_IMAGE_BYTES.min(remaining_bytes);
    if cap == 0 {
        return Err("Image batch size limit reached".to_string());
    }
    let (name, bytes) = match source {
        MarkdownImageSource::Path { path } => {
            let source = validate_external_read_path(&path)?;
            let file = open_regular_file_no_follow(&source, "image")?;
            let name = source
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or("Invalid image filename")?
                .to_string();
            let mut bytes = Vec::new();
            file.take(cap as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| format!("Image read failed: {}", error))?;
            (name, bytes)
        }
        MarkdownImageSource::Base64 { name, base64 } => {
            if base64.len() > cap.div_ceil(3) * 4 {
                return Err("Image too large".to_string());
            }
            let bytes = BASE64
                .decode(base64)
                .map_err(|_| "Invalid image base64".to_string())?;
            (name, bytes)
        }
    };
    if bytes.len() > cap {
        return Err("Image too large".to_string());
    }
    let safe_name = sanitize_filename(&name);
    validate_item_name(&safe_name)?;
    let mime_type = validate_image(&safe_name, &bytes)?;
    let directory_name = format!("{}_assets", stem);
    validate_item_name(&directory_name)?;
    let target = parent.join(directory_name);
    reject_managed_global_skill_mutation(root, &target)?;
    let relative = write_unique_file(&target, root, &safe_name, &bytes)?;
    Ok(MarkdownImportedFile {
        name: relative
            .rsplit('/')
            .next()
            .unwrap_or(&safe_name)
            .to_string(),
        path: relative,
        size: bytes.len(),
        mime_type: mime_type.to_string(),
    })
}

fn validate_image(name: &str, bytes: &[u8]) -> Result<&'static str, String> {
    use image::ImageFormat;
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension == "svg" {
        let text = std::str::from_utf8(bytes).map_err(|_| "Invalid SVG UTF-8")?;
        let mut reader = quick_xml::Reader::from_str(text);
        let mut depth = 0usize;
        let mut saw_root = false;
        loop {
            use quick_xml::events::Event;
            match reader.read_event().map_err(|_| "Invalid SVG XML")? {
                Event::Start(element) => {
                    if depth == 0 {
                        if saw_root || element.local_name().as_ref() != b"svg" {
                            return Err("Invalid SVG root".to_string());
                        }
                        saw_root = true;
                    }
                    depth += 1;
                }
                Event::Empty(element) if depth == 0 => {
                    if saw_root || element.local_name().as_ref() != b"svg" {
                        return Err("Invalid SVG root".to_string());
                    }
                    saw_root = true;
                }
                Event::End(_) => {
                    depth = depth.checked_sub(1).ok_or("Invalid SVG structure")?;
                }
                Event::DocType(_) => return Err("SVG document types are not supported".to_string()),
                Event::Text(text) if depth == 0 && !text.iter().all(u8::is_ascii_whitespace) => {
                    return Err("Invalid SVG text".to_string())
                }
                Event::Eof => break,
                _ => {}
            }
        }
        return if saw_root && depth == 0 {
            Ok("image/svg+xml")
        } else {
            Err("Invalid SVG structure".to_string())
        };
    }
    let expected = match extension.as_str() {
        "png" => (ImageFormat::Png, "image/png"),
        "jpg" | "jpeg" => (ImageFormat::Jpeg, "image/jpeg"),
        "gif" => (ImageFormat::Gif, "image/gif"),
        "webp" => (ImageFormat::WebP, "image/webp"),
        "bmp" => (ImageFormat::Bmp, "image/bmp"),
        "ico" => (ImageFormat::Ico, "image/x-icon"),
        _ => return Err("Unsupported image format".to_string()),
    };
    if image::guess_format(bytes).ok() != Some(expected.0) {
        return Err("Image content does not match its format".to_string());
    }
    Ok(expected.1)
}

#[tauri::command]
pub async fn cmd_workspace_save_markdown_copy(
    workspace: String,
    document_path: String,
    content: String,
) -> Result<MarkdownImportedFile, String> {
    if content.len() > MAX_DOCUMENT_BYTES {
        return Err("Content too large".to_string());
    }
    let root = validate_workspace_root(&workspace)?;
    let _mutation = super::acquire_edit_mutation(&root).await;
    tokio::task::spawn_blocking(move || {
        let (parent, stem) = document_location(&root, &document_path, false)?;
        let name = format!("{}_local-copy.md", stem);
        let relative = write_unique_file(&parent, &root, &name, content.as_bytes())?;
        Ok(MarkdownImportedFile {
            name: relative.rsplit('/').next().unwrap_or(&name).to_string(),
            path: relative,
            size: content.len(),
            mime_type: "text/markdown".to_string(),
        })
    })
    .await
    .map_err(|error| format!("Copy save status unknown: {}", error))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;
    use std::fs;

    struct Workspace(PathBuf);
    impl Workspace {
        fn new() -> Self {
            let path = make_test_workspace("markdown_assets");
            fs::create_dir(path.join("docs")).unwrap();
            fs::write(path.join("docs/报告.md"), "# Original").unwrap();
            Self(path)
        }
        fn name(&self) -> String {
            self.0.to_string_lossy().to_string()
        }
    }
    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn png() -> MarkdownImageSource {
        MarkdownImageSource::Base64 {
            name: "截图.png".into(),
            base64: BASE64.encode(b"\x89PNG\r\n\x1a\nimage"),
        }
    }

    #[tokio::test]
    async fn imports_into_current_document_assets_without_overwriting() {
        let ws = Workspace::new();
        let first = cmd_workspace_import_markdown_image(
            ws.name(),
            "docs/报告.md".into(),
            MAX_IMAGE_BYTES,
            png(),
        )
        .await
        .unwrap();
        let second = cmd_workspace_import_markdown_image(
            ws.name(),
            "docs/报告.md".into(),
            MAX_IMAGE_BYTES,
            png(),
        )
        .await
        .unwrap();
        assert_eq!(first.path, "docs/报告_assets/截图.png");
        assert_eq!(second.path, "docs/报告_assets/截图_1.png");
        assert_eq!(first.mime_type, "image/png");
        assert_eq!(
            fs::read(ws.0.join(first.path)).unwrap(),
            fs::read(ws.0.join(second.path)).unwrap()
        );
        assert_eq!(
            fs::read_to_string(ws.0.join("docs/报告.md")).unwrap(),
            "# Original"
        );
    }

    #[tokio::test]
    async fn validates_bytes_and_batch_allowance_before_creating_assets() {
        let ws = Workspace::new();
        assert!(
            cmd_workspace_import_markdown_image(ws.name(), "docs/报告.md".into(), 4, png())
                .await
                .is_err()
        );
        let fake = MarkdownImageSource::Base64 {
            name: "fake.png".into(),
            base64: BASE64.encode(b"not an image"),
        };
        assert!(cmd_workspace_import_markdown_image(
            ws.name(),
            "docs/报告.md".into(),
            MAX_IMAGE_BYTES,
            fake
        )
        .await
        .is_err());
        assert!(!ws.0.join("docs/报告_assets").exists());
    }

    #[tokio::test]
    async fn copies_paths_directly_and_leaves_the_source() {
        let ws = Workspace::new();
        let image = ws.0.join("source.gif");
        fs::write(&image, b"GIF89a123456789").unwrap();
        let result = cmd_workspace_import_markdown_image(
            ws.name(),
            "docs/报告.md".into(),
            MAX_IMAGE_BYTES,
            MarkdownImageSource::Path {
                path: image.to_string_lossy().to_string(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            fs::read(&image).unwrap(),
            fs::read(ws.0.join(result.path)).unwrap()
        );
    }

    #[tokio::test]
    async fn saves_exact_copies_even_after_original_was_deleted() {
        let ws = Workspace::new();
        fs::remove_file(ws.0.join("docs/报告.md")).unwrap();
        let raw = "\u{feff}# Draft\r\n![x](报告_assets/a.png)\n";
        let first = cmd_workspace_save_markdown_copy(ws.name(), "docs/报告.md".into(), raw.into())
            .await
            .unwrap();
        let second =
            cmd_workspace_save_markdown_copy(ws.name(), "docs/报告.md".into(), "next".into())
                .await
                .unwrap();
        assert_eq!(first.path, "docs/报告_local-copy.md");
        assert_eq!(fs::read_to_string(ws.0.join(first.path)).unwrap(), raw);
        assert_eq!(second.path, "docs/报告_local-copy_1.md");
    }

    #[test]
    fn validates_svg_without_resolving_entities() {
        assert_eq!(
            validate_image(
                "a.svg",
                b"<svg xmlns=\"http://www.w3.org/2000/svg\"><path/></svg>"
            )
            .unwrap(),
            "image/svg+xml"
        );
        assert!(validate_image(
            "a.svg",
            b"<!DOCTYPE svg [<!ENTITY x SYSTEM 'file:///private'>]><svg>&x;</svg>"
        )
        .is_err());
        assert!(validate_image("a.svg", b"<svg><path></svg>").is_err());
        assert!(validate_image("a.svg", b"<html/>").is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_source_and_destination_symlinks() {
        use std::os::unix::fs::symlink;
        let ws = Workspace::new();
        fs::write(ws.0.join("original.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        symlink(ws.0.join("original.png"), ws.0.join("linked.png")).unwrap();
        assert!(cmd_workspace_import_markdown_image(
            ws.name(),
            "docs/报告.md".into(),
            MAX_IMAGE_BYTES,
            MarkdownImageSource::Path {
                path: ws.0.join("linked.png").to_string_lossy().to_string()
            }
        )
        .await
        .is_err());
        fs::create_dir(ws.0.join("elsewhere")).unwrap();
        symlink(ws.0.join("elsewhere"), ws.0.join("docs/报告_assets")).unwrap();
        assert!(cmd_workspace_import_markdown_image(
            ws.name(),
            "docs/报告.md".into(),
            MAX_IMAGE_BYTES,
            png()
        )
        .await
        .is_err());
        assert_eq!(fs::read_dir(ws.0.join("elsewhere")).unwrap().count(), 0);
    }

    #[test]
    fn concurrent_unique_writes_publish_complete_distinct_files() {
        let ws = Workspace::new();
        let mut workers = Vec::new();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        for index in 0..8 {
            let root = ws.0.clone();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                let content = vec![index; 1024];
                let target = root.join("images");
                barrier.wait();
                let path = write_unique_file(&target, &root, "same.png", &content).unwrap();
                assert_eq!(fs::read(root.join(&path)).unwrap(), content);
                path
            }));
        }
        let paths: std::collections::HashSet<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(paths.len(), 8);
        assert_eq!(fs::read_dir(ws.0.join("images")).unwrap().count(), 8);
    }
}
