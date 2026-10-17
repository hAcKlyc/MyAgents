use std::collections::HashSet;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{ipc::Response as IpcResponse, AppHandle};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

use crate::sidecar::{
    get_tab_server_url, start_global_sidecar, ManagedSidecarManager, GLOBAL_SIDECAR_ID,
};
use crate::ulog_warn;
use crate::workspace_files::path_safety::{
    atomic_write_file, resolve_inside_workspace, validate_workspace_root,
};

use super::{
    authorized_bytes_request, authorized_multipart_data_request, read_local_file_no_follow,
    require_session, safe_local_filename, safe_local_name, session_space_segment, url_component,
    SpaceCommandResult,
};

pub(crate) const MAX_SKILL_ZIP_BYTES: usize = 50 * 1024 * 1024;
const MAX_SKILL_ZIP_ENTRIES: usize = 512;
const MAX_SKILL_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES: u64 = 50 * 1024 * 1024;
const SKILL_INSTALL_CONFLICT_ERROR: &str = "SKILL_INSTALL_CONFLICT";
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceInstallSkillInput {
    pub skill_id: String,
    pub skill_name: String,
    pub target: SpaceSkillInstallTarget,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceUploadSkillInput {
    pub file_path: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub skill_id: Option<String>,
    #[serde(default)]
    pub source: Option<SpaceSkillSourceMetaInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSkillSourceMetaInput {
    #[serde(rename = "type")]
    pub source_type: String,
    pub url: String,
    #[serde(default)]
    pub resolved_url: Option<String>,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    #[serde(rename = "ref")]
    pub ref_name: Option<String>,
    #[serde(default)]
    pub effective_ref: Option<String>,
    #[serde(default)]
    pub root_path: Option<String>,
    #[serde(default)]
    pub skill_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceListLocalSkillsInput {
    #[serde(default)]
    pub projects: Vec<SpaceLocalSkillProjectInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceLocalSkillProjectInput {
    pub workspace_path: String,
    #[serde(default)]
    pub workspace_label: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceLocalSkillSummary {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub folder_name: String,
    pub path: String,
    pub skill_md_path: String,
    pub scope: String,
    pub workspace_path: Option<String>,
    pub workspace_label: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceInspectSkillSourceInput {
    pub file_path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceExportSkillFromUrlInput {
    pub url: String,
    #[serde(default)]
    pub confirmed_selection: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCleanupSkillExportPackagesInput {
    #[serde(default)]
    pub file_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSkillSourceInspection {
    pub name: String,
    pub description: Option<String>,
    pub file_count: usize,
    pub package_size_bytes: usize,
    pub package_hash: String,
    pub source_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SpaceSkillInstallTarget {
    Global,
    Project,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceInstallSkillResult {
    pub installed_name: String,
    pub installed_path: String,
    pub target: String,
}

#[tauri::command]
pub async fn cmd_space_install_skill(
    input: SpaceInstallSkillInput,
) -> SpaceCommandResult<SpaceInstallSkillResult> {
    let session = require_session()?;
    let install_root = match input.target {
        SpaceSkillInstallTarget::Global => {
            let root = crate::app_dirs::myagents_data_dir()
                .ok_or_else(|| "Home dir not found".to_string())?
                .join("skills");
            fs::create_dir_all(&root).map_err(|e| format!("Failed to create skills dir: {}", e))?;
            root
        }
        SpaceSkillInstallTarget::Project => {
            let workspace = input
                .workspace_path
                .as_deref()
                .ok_or_else(|| "workspacePath is required for project install".to_string())?;
            let workspace_root = validate_workspace_root(workspace)?;
            let root = resolve_inside_workspace(&workspace_root, ".claude/skills")?;
            fs::create_dir_all(&root)
                .map_err(|e| format!("Failed to create project skills dir: {}", e))?;
            root
        }
    };
    let base_name = safe_local_name(&input.skill_name);
    let target_dir = install_root.join(&base_name);
    if skill_install_target_exists(&target_dir)? && !input.overwrite {
        return Err(SKILL_INSTALL_CONFLICT_ERROR.into());
    }

    let bytes = authorized_bytes_request(
        &session,
        &format!("/api/skills/{}/package.zip", url_component(&input.skill_id)),
    )
    .await?;
    if bytes.len() > MAX_SKILL_ZIP_BYTES {
        return Err(format!("Skill package exceeds {} bytes", MAX_SKILL_ZIP_BYTES).into());
    }
    let staging_dir = install_root.join(format!(
        ".{}.myagents-installing-{}",
        base_name,
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("Failed to create skill staging dir: {}", e))?;
    if let Err(error) = extract_skill_zip(&bytes, &staging_dir) {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(error.into());
    }
    let commit_lock = install_root.join(format!(".{base_name}.myagents-install.lock"));
    let commit_staging = staging_dir.clone();
    let commit_target = target_dir.clone();
    let overwrite = input.overwrite;
    let commit_result = crate::utils::file_lock::with_file_lock(
        &commit_lock,
        crate::utils::file_lock::FileLockOptions::default(),
        move || {
            Ok(commit_staged_skill_install(
                &commit_staging,
                &commit_target,
                overwrite,
            ))
        },
    )
    .await
    .map_err(String::from)
    .and_then(|result| result);
    if let Err(error) = commit_result {
        let _ = remove_skill_install_entry(&staging_dir);
        return Err(error.into());
    }
    let target = match input.target {
        SpaceSkillInstallTarget::Global => "global",
        SpaceSkillInstallTarget::Project => "project",
    }
    .to_string();
    Ok(SpaceInstallSkillResult {
        installed_name: base_name,
        installed_path: target_dir.to_string_lossy().to_string(),
        target,
    })
}

#[tauri::command]
pub async fn cmd_space_list_local_skills(
    input: SpaceListLocalSkillsInput,
) -> Result<Vec<SpaceLocalSkillSummary>, String> {
    let mut items = Vec::new();
    if let Some(home) = dirs::home_dir() {
        scan_local_skill_dir(
            &home.join(crate::app_dirs::APP_DATA_DIR_NAME).join("skills"),
            "global",
            None,
            None,
            &mut items,
        )?;
    }
    for project in input.projects {
        let workspace = match validate_workspace_root(project.workspace_path.trim()) {
            Ok(workspace) => workspace,
            Err(_) => continue,
        };
        let root = resolve_inside_workspace(&workspace, ".claude/skills")?;
        scan_local_skill_dir(
            &root,
            "project",
            Some(workspace.to_string_lossy().to_string()),
            project.workspace_label,
            &mut items,
        )?;
    }
    Ok(items)
}

#[tauri::command]
pub async fn cmd_space_inspect_skill_source(
    input: SpaceInspectSkillSourceInput,
) -> Result<SpaceSkillSourceInspection, String> {
    let package = build_skill_upload_package(input.file_path.trim())?;
    inspect_skill_package(&package.bytes, input.file_path.trim())
}

#[tauri::command]
pub async fn cmd_space_export_skill_from_url(
    app_handle: AppHandle,
    state: tauri::State<'_, ManagedSidecarManager>,
    input: SpaceExportSkillFromUrlInput,
) -> Result<Value, String> {
    if input.url.trim().is_empty() {
        return Err("url is required".to_string());
    }
    let manager = state.inner().clone();
    let server_url = tauri::async_runtime::spawn_blocking(move || {
        start_global_sidecar(&app_handle, &manager)?;
        get_tab_server_url(&manager, GLOBAL_SIDECAR_ID)
    })
    .await
    .map_err(|e| format!("start global sidecar task failed: {e:?}"))??;
    let client = crate::local_http::json_client(Duration::from_secs(90));
    let response = client
        .post(format!("{}/api/skill/export-from-url", server_url))
        .json(&input)
        .send()
        .await
        .map_err(|e| format!("Skill URL export request failed: {}", e))?;
    let status = response.status();
    let value = response
        .json::<Value>()
        .await
        .map_err(|e| format!("Invalid Skill URL export response: {}", e))?;
    if !status.is_success() || value.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Skill URL export failed")
            .to_string());
    }
    Ok(value)
}

#[tauri::command]
pub async fn cmd_space_cleanup_skill_export_packages(
    input: SpaceCleanupSkillExportPackagesInput,
) -> Result<(), String> {
    for path in input.file_paths {
        cleanup_skill_export_path(&path)?;
    }
    Ok(())
}

fn add_optional_form_text(
    form: reqwest::multipart::Form,
    name: &'static str,
    value: Option<&str>,
) -> reqwest::multipart::Form {
    if let Some(trimmed) = value.map(str::trim).filter(|value| !value.is_empty()) {
        form.text(name, trimmed.to_string())
    } else {
        form
    }
}

fn add_skill_source_form_fields(
    mut form: reqwest::multipart::Form,
    source: Option<&SpaceSkillSourceMetaInput>,
) -> reqwest::multipart::Form {
    let Some(source) = source else {
        return form;
    };
    form = add_optional_form_text(form, "sourceType", Some(source.source_type.as_str()));
    form = add_optional_form_text(form, "sourceUrl", Some(source.url.as_str()));
    form = add_optional_form_text(form, "sourceResolvedUrl", source.resolved_url.as_deref());
    form = add_optional_form_text(form, "sourceOwner", source.owner.as_deref());
    form = add_optional_form_text(form, "sourceRepo", source.repo.as_deref());
    form = add_optional_form_text(form, "sourceRef", source.ref_name.as_deref());
    form = add_optional_form_text(form, "sourceEffectiveRef", source.effective_ref.as_deref());
    form = add_optional_form_text(form, "sourceRootPath", source.root_path.as_deref());
    add_optional_form_text(form, "sourceSkillName", source.skill_name.as_deref())
}

#[tauri::command]
pub async fn cmd_space_upload_skill(input: SpaceUploadSkillInput) -> SpaceCommandResult<Value> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::upload_skill(input).map_err(Into::into);
    }
    let session = require_session()?;
    let source_path = input.file_path.trim().to_string();
    let package = build_skill_upload_package(input.file_path.trim())?;
    let file_part = reqwest::multipart::Part::bytes(package.bytes)
        .file_name(package.filename)
        .mime_str("application/zip")
        .map_err(|e| format!("Failed to build skill upload part: {}", e))?;
    let mut form = reqwest::multipart::Form::new().part("file", file_part);
    if let Some(name) = input.name.as_deref().filter(|s| !s.trim().is_empty()) {
        form = form.text("name", name.trim().to_string());
    }
    if let Some(description) = input
        .description
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        form = form.text("description", description.trim().to_string());
    }
    form = add_skill_source_form_fields(form, input.source.as_ref());
    let path = if let Some(skill_id) = input.skill_id.as_deref().filter(|s| !s.trim().is_empty()) {
        format!("/api/skills/{}/revisions", url_component(skill_id.trim()))
    } else {
        format!("/api/spaces/{}/skills", session_space_segment(&session))
    };
    let result = authorized_multipart_data_request(&session, &path, form).await;
    if result.is_ok() {
        cleanup_skill_export_path(&source_path)?;
    }
    result
}

#[tauri::command]
pub async fn cmd_space_download_skill_zip(
    input: SpaceInstallSkillInput,
) -> SpaceCommandResult<IpcResponse> {
    if crate::space_cloud_mock::is_enabled() {
        return Ok(IpcResponse::new(
            crate::space_cloud_mock::skill_package_bytes(&input.skill_id)?,
        ));
    }
    let session = require_session()?;
    let bytes = authorized_bytes_request(
        &session,
        &format!("/api/skills/{}/package.zip", url_component(&input.skill_id)),
    )
    .await?;
    Ok(IpcResponse::new(bytes))
}

fn safe_skill_archive_name(value: &str) -> String {
    let name = safe_local_filename(value);
    if name.is_empty() {
        "skill.zip".to_string()
    } else if name.ends_with(".zip") {
        name
    } else {
        let stem = name
            .strip_suffix(".skill")
            .or_else(|| name.strip_suffix(".md"))
            .unwrap_or(&name);
        format!("{}.zip", stem)
    }
}

#[derive(Debug)]
struct ParsedSkillFrontmatter {
    name: Option<String>,
    description: Option<String>,
}

fn parse_skill_frontmatter(content: &str) -> ParsedSkillFrontmatter {
    let normalized = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = normalized.lines();
    if lines.next() != Some("---") {
        return ParsedSkillFrontmatter {
            name: None,
            description: None,
        };
    }
    let mut body = String::new();
    for line in lines {
        if line.trim() == "---" {
            let value = serde_yaml::from_str::<serde_yaml::Value>(&body).ok();
            let mapping = value.and_then(|value| match value {
                serde_yaml::Value::Mapping(mapping) => Some(mapping),
                _ => None,
            });
            let get_string = |key: &str| -> Option<String> {
                mapping
                    .as_ref()
                    .and_then(|map| map.get(&serde_yaml::Value::String(key.to_string())))
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
            };
            return ParsedSkillFrontmatter {
                name: get_string("name"),
                description: get_string("description"),
            };
        }
        body.push_str(line);
        body.push('\n');
    }
    ParsedSkillFrontmatter {
        name: None,
        description: None,
    }
}

fn heading_title(content: &str) -> Option<String> {
    content.lines().find_map(|line| {
        line.trim()
            .strip_prefix("# ")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    })
}

fn zip_entry_is_symlink(mode: Option<u32>) -> bool {
    mode.is_some_and(|mode| (mode & 0o170000) == 0o120000)
}

struct SkillUploadPackage {
    bytes: Vec<u8>,
    filename: String,
}

fn skill_url_export_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| {
        home.join(crate::app_dirs::APP_DATA_DIR_NAME)
            .join("tmp")
            .join("skill-url-export")
    })
}

fn cleanup_skill_export_path(raw_path: &str) -> Result<(), String> {
    let Some(root) = skill_url_export_root() else {
        return Ok(());
    };
    let path = PathBuf::from(raw_path.trim());
    if !path.is_absolute() || !path.starts_with(&root) {
        return Ok(());
    }
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("Failed to inspect staged Skill package: {}", e)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(());
    }
    fs::remove_file(&path).map_err(|e| format!("Failed to remove staged Skill package: {}", e))?;
    let mut cursor = path.parent().map(Path::to_path_buf);
    while let Some(dir) = cursor {
        if dir == root {
            break;
        }
        if fs::remove_dir(&dir).is_err() {
            break;
        }
        cursor = dir.parent().map(Path::to_path_buf);
    }
    Ok(())
}

fn build_skill_upload_package(raw_path: &str) -> Result<SkillUploadPackage, String> {
    let file_path = PathBuf::from(raw_path);
    if !file_path.is_absolute() {
        return Err("Skill source path must be absolute".to_string());
    }
    let metadata = fs::symlink_metadata(&file_path)
        .map_err(|e| format!("Failed to inspect skill source: {}", e))?;
    if metadata.file_type().is_symlink() {
        return Err("Skill source path must not be a symlink".to_string());
    }
    if metadata.is_dir() {
        return build_skill_package_from_dir(&file_path);
    }
    if !metadata.is_file() {
        return Err("Skill source path must be a file or directory".to_string());
    }
    let ext = file_path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "zip" | "skill" => {
            if metadata.len() > MAX_SKILL_ZIP_BYTES as u64 {
                return Err(format!("Skill zip exceeds {} bytes", MAX_SKILL_ZIP_BYTES));
            }
            let bytes =
                read_local_file_no_follow(&file_path, MAX_SKILL_ZIP_BYTES as u64, "Skill package")?;
            validate_skill_zip_bytes(&bytes)?;
            let filename = file_path
                .file_name()
                .and_then(|name| name.to_str())
                .map(safe_skill_archive_name)
                .unwrap_or_else(|| "skill.zip".to_string());
            Ok(SkillUploadPackage { bytes, filename })
        }
        "md" => build_skill_package_from_md_file(&file_path),
        _ => Err("Skill upload requires a .zip, .skill, .md file, or a Skill folder".to_string()),
    }
}

fn build_skill_package_from_md_file(path: &Path) -> Result<SkillUploadPackage, String> {
    let text = String::from_utf8(read_local_file_no_follow(
        path,
        MAX_SKILL_FILE_BYTES,
        "Skill markdown",
    )?)
    .map_err(|_| "Skill markdown must be valid UTF-8".to_string())?;
    let parsed = parse_skill_frontmatter(&text);
    let name = parsed
        .name
        .as_deref()
        .ok_or_else(|| "不是有效 Skill".to_string())?;
    let mut bytes = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut bytes);
        zip.start_file("SKILL.md", SimpleFileOptions::default())
            .map_err(|e| format!("Failed to create skill package: {}", e))?;
        zip.write_all(text.as_bytes())
            .map_err(|e| format!("Failed to write skill package: {}", e))?;
        zip.finish()
            .map_err(|e| format!("Failed to finish skill package: {}", e))?;
    }
    validate_skill_zip_bytes(bytes.get_ref())?;
    Ok(SkillUploadPackage {
        bytes: bytes.into_inner(),
        filename: safe_skill_archive_name(name),
    })
}

fn build_skill_package_from_dir(root: &Path) -> Result<SkillUploadPackage, String> {
    let skill_md = root.join("SKILL.md");
    let skill_md_meta = fs::symlink_metadata(&skill_md)
        .map_err(|_| "Skill folder must contain SKILL.md".to_string())?;
    if skill_md_meta.file_type().is_symlink() {
        return Err("Skill folder SKILL.md must not be a symlink".to_string());
    }
    if !skill_md_meta.is_file() {
        return Err("Skill folder must contain a file named SKILL.md".to_string());
    }

    let mut files = Vec::<(PathBuf, Vec<u8>)>::new();
    collect_skill_dir_files(root, root, &mut files)?;
    let mut bytes = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut bytes);
        let options = SimpleFileOptions::default();
        for (relative, data) in files {
            let name = relative
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            zip.start_file(name, options)
                .map_err(|e| format!("Failed to create skill package: {}", e))?;
            zip.write_all(&data)
                .map_err(|e| format!("Failed to write skill package: {}", e))?;
        }
        zip.finish()
            .map_err(|e| format!("Failed to finish skill package: {}", e))?;
    }
    validate_skill_zip_bytes(bytes.get_ref())?;
    let folder_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skill");
    Ok(SkillUploadPackage {
        bytes: bytes.into_inner(),
        filename: safe_skill_archive_name(folder_name),
    })
}

fn collect_skill_dir_files(
    root: &Path,
    dir: &Path,
    out: &mut Vec<(PathBuf, Vec<u8>)>,
) -> Result<(), String> {
    if out.len() > MAX_SKILL_ZIP_ENTRIES {
        return Err(format!(
            "Skill folder has too many entries (max {})",
            MAX_SKILL_ZIP_ENTRIES
        ));
    }
    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read Skill folder: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read Skill folder entry: {}", e))?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') || name_str == "__MACOSX" {
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|e| format!("Failed to inspect Skill folder entry: {}", e))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Skill contains a symlink and cannot be published: {}",
                path.display()
            ));
        }
        if metadata.is_dir() {
            collect_skill_dir_files(root, &path, out)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        if metadata.len() > MAX_SKILL_FILE_BYTES {
            return Err(format!(
                "Skill file exceeds {} bytes: {}",
                MAX_SKILL_FILE_BYTES,
                path.display()
            ));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "Skill file path escaped source folder".to_string())?
            .to_path_buf();
        safe_zip_relative_path(&relative.to_string_lossy())?;
        let data = read_local_file_no_follow(&path, MAX_SKILL_FILE_BYTES, "Skill file")?;
        out.push((relative, data));
        let total = out.iter().try_fold(0u64, |sum, (_, data)| {
            sum.checked_add(data.len() as u64)
                .ok_or_else(|| "Skill package size overflow".to_string())
        })?;
        if total > MAX_SKILL_TOTAL_BYTES {
            return Err(format!(
                "Skill package exceeds {} bytes",
                MAX_SKILL_TOTAL_BYTES
            ));
        }
    }
    Ok(())
}

fn validate_skill_zip_bytes(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_SKILL_ZIP_BYTES {
        return Err(format!("Skill zip exceeds {} bytes", MAX_SKILL_ZIP_BYTES));
    }
    let root_prefix = find_skill_root_prefix(bytes)?;
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Invalid skill zip: {}", e))?;
    if archive.len() > MAX_SKILL_ZIP_ENTRIES {
        return Err(format!(
            "Skill zip has too many entries (max {})",
            MAX_SKILL_ZIP_ENTRIES
        ));
    }
    let mut seen = HashSet::new();
    let mut total_size = 0u64;
    let mut has_skill_md = false;
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("Invalid zip entry: {}", e))?;
        if zip_entry_is_symlink(entry.unix_mode()) {
            return Err(format!(
                "Skill zip entry must not be a symlink: {}",
                entry.name()
            ));
        }
        if entry.is_dir() {
            continue;
        }
        if entry.size() > MAX_SKILL_FILE_BYTES {
            return Err(format!(
                "Skill zip entry exceeds {} bytes: {}",
                MAX_SKILL_FILE_BYTES,
                entry.name()
            ));
        }
        total_size = total_size
            .checked_add(entry.size())
            .ok_or_else(|| "Skill zip total size overflow".to_string())?;
        if total_size > MAX_SKILL_TOTAL_BYTES {
            return Err(format!(
                "Skill zip expands beyond {} bytes",
                MAX_SKILL_TOTAL_BYTES
            ));
        }
        let entry_name = entry.name().replace('\\', "/");
        if !entry_name.starts_with(&root_prefix) {
            continue;
        }
        let relative = &entry_name[root_prefix.len()..];
        if relative.is_empty() {
            continue;
        }
        let safe = safe_zip_relative_path(relative)?;
        if safe == Path::new("SKILL.md") {
            has_skill_md = true;
        }
        if !seen.insert(safe.clone()) {
            return Err(format!("Duplicate skill zip entry: {}", safe.display()));
        }
    }
    if !has_skill_md {
        return Err("Skill zip must contain SKILL.md".to_string());
    }
    Ok(())
}

fn inspect_skill_package(
    bytes: &[u8],
    source_path: &str,
) -> Result<SpaceSkillSourceInspection, String> {
    validate_skill_zip_bytes(bytes)?;
    let root_prefix = find_skill_root_prefix(bytes)?;
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Invalid skill zip: {}", e))?;
    let mut file_count = 0usize;
    let mut skill_md_text = String::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Invalid zip entry: {}", e))?;
        if zip_entry_is_symlink(entry.unix_mode()) {
            return Err(format!(
                "Skill zip entry must not be a symlink: {}",
                entry.name()
            ));
        }
        if entry.is_dir() {
            continue;
        }
        let entry_name = entry.name().replace('\\', "/");
        if !entry_name.starts_with(&root_prefix) {
            continue;
        }
        let relative = &entry_name[root_prefix.len()..];
        if relative.is_empty() {
            continue;
        }
        file_count += 1;
        if relative.eq_ignore_ascii_case("SKILL.md") {
            entry
                .read_to_string(&mut skill_md_text)
                .map_err(|e| format!("Failed to read SKILL.md from package: {}", e))?;
        }
    }
    let parsed = parse_skill_frontmatter(&skill_md_text);
    let name = parsed
        .name
        .or_else(|| heading_title(&skill_md_text))
        .ok_or_else(|| "不是有效 Skill".to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let package_hash = format!("{:x}", hasher.finalize());
    Ok(SpaceSkillSourceInspection {
        name,
        description: parsed.description,
        file_count,
        package_size_bytes: bytes.len(),
        package_hash,
        source_path: source_path.to_string(),
    })
}

fn scan_local_skill_dir(
    root: &Path,
    scope: &str,
    workspace_path: Option<String>,
    workspace_label: Option<String>,
    out: &mut Vec<SpaceLocalSkillSummary>,
) -> Result<(), String> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("Failed to read local Skills: {}", e)),
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        let folder_name = entry.file_name().to_string_lossy().to_string();
        if folder_name.starts_with('.') {
            continue;
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        let skill_md_meta = match fs::symlink_metadata(&skill_md) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if skill_md_meta.file_type().is_symlink() || !skill_md_meta.is_file() {
            continue;
        }
        if skill_md_meta.len() > MAX_SKILL_FILE_BYTES {
            continue;
        }
        let content = read_local_file_no_follow(&skill_md, MAX_SKILL_FILE_BYTES, "Skill markdown")
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .unwrap_or_default();
        let parsed = parse_skill_frontmatter(&content);
        let name = parsed
            .name
            .or_else(|| heading_title(&content))
            .unwrap_or_else(|| folder_name.clone());
        out.push(SpaceLocalSkillSummary {
            id: format!("{}:{}", scope, path.to_string_lossy()),
            name,
            description: parsed.description,
            folder_name,
            path: path.to_string_lossy().to_string(),
            skill_md_path: skill_md.to_string_lossy().to_string(),
            scope: scope.to_string(),
            workspace_path: workspace_path.clone(),
            workspace_label: workspace_label.clone(),
        });
    }
    out.sort_by(|a, b| {
        a.scope
            .cmp(&b.scope)
            .then_with(|| a.workspace_label.cmp(&b.workspace_label))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(())
}

fn skill_install_target_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Failed to inspect install target: {error}")),
    }
}

fn remove_skill_install_entry(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            remove_skill_install_symlink(path, &metadata.file_type())
                .map_err(|error| format!("Failed to remove Skill symlink: {error}"))
        }
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path)
            .map_err(|error| format!("Failed to remove Skill directory: {error}")),
        Ok(_) => {
            fs::remove_file(path).map_err(|error| format!("Failed to remove Skill path: {error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to inspect Skill path: {error}")),
    }
}

#[cfg(windows)]
fn remove_skill_install_symlink(path: &Path, file_type: &fs::FileType) -> std::io::Result<()> {
    use std::os::windows::fs::FileTypeExt;

    if file_type.is_symlink_dir() {
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    }
}

#[cfg(not(windows))]
fn remove_skill_install_symlink(path: &Path, _file_type: &fs::FileType) -> std::io::Result<()> {
    fs::remove_file(path)
}

fn commit_staged_skill_install(
    staging_dir: &Path,
    target_dir: &Path,
    overwrite: bool,
) -> Result<(), String> {
    let target_exists = skill_install_target_exists(target_dir)?;
    if target_exists && !overwrite {
        return Err(SKILL_INSTALL_CONFLICT_ERROR.to_string());
    }
    if !target_exists {
        return fs::rename(staging_dir, target_dir)
            .map_err(|error| format!("Failed to commit skill install: {error}"));
    }

    let target_name = target_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("skill");
    let backup_dir = target_dir.with_file_name(format!(
        ".{target_name}.myagents-replacing-{}",
        uuid::Uuid::new_v4()
    ));
    fs::rename(target_dir, &backup_dir)
        .map_err(|error| format!("Failed to stage existing Skill: {error}"))?;
    if let Err(error) = fs::rename(staging_dir, target_dir) {
        let rollback_error = fs::rename(&backup_dir, target_dir).err();
        if let Some(rollback_error) = rollback_error {
            return Err(format!(
                "Failed to commit skill install: {error}; failed to restore previous Skill: {rollback_error}"
            ));
        }
        return Err(format!("Failed to commit skill install: {error}"));
    }
    if let Err(error) = remove_skill_install_entry(&backup_dir) {
        ulog_warn!(
            "[space] Skill installed but old staging directory could not be removed {}: {}",
            backup_dir.display(),
            error
        );
    }
    Ok(())
}

fn extract_skill_zip(bytes: &[u8], target_dir: &Path) -> Result<(), String> {
    let root_prefix = find_skill_root_prefix(bytes)?;
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Invalid skill zip: {}", e))?;
    if archive.len() > MAX_SKILL_ZIP_ENTRIES {
        return Err(format!(
            "Skill zip has too many entries (max {})",
            MAX_SKILL_ZIP_ENTRIES
        ));
    }
    let mut seen = HashSet::new();
    let mut total_size = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Invalid zip entry: {}", e))?;
        if entry.is_dir() {
            continue;
        }
        if entry.size() > MAX_SKILL_FILE_BYTES {
            return Err(format!(
                "Skill zip entry exceeds {} bytes: {}",
                MAX_SKILL_FILE_BYTES,
                entry.name()
            ));
        }
        total_size = total_size
            .checked_add(entry.size())
            .ok_or_else(|| "Skill zip total size overflow".to_string())?;
        if total_size > MAX_SKILL_TOTAL_BYTES {
            return Err(format!(
                "Skill zip expands beyond {} bytes",
                MAX_SKILL_TOTAL_BYTES
            ));
        }
        let entry_name = entry.name().replace('\\', "/");
        if !entry_name.starts_with(&root_prefix) {
            continue;
        }
        let relative = &entry_name[root_prefix.len()..];
        if relative.is_empty() {
            continue;
        }
        let safe = safe_zip_relative_path(relative)?;
        if !seen.insert(safe.clone()) {
            return Err(format!("Duplicate skill zip entry: {}", safe.display()));
        }
        let target = target_dir.join(&safe);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create skill subdir: {}", e))?;
        }
        let mut data = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut data)
            .map_err(|e| format!("Failed to read skill zip entry: {}", e))?;
        atomic_write_file(&target, &data)?;
    }
    if !target_dir.join("SKILL.md").is_file() {
        return Err("Skill zip did not extract a SKILL.md".to_string());
    }
    Ok(())
}

fn find_skill_root_prefix(bytes: &[u8]) -> Result<String, String> {
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Invalid skill zip: {}", e))?;
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("Invalid zip entry: {}", e))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        if name == "SKILL.md" {
            return Ok(String::new());
        }
        if let Some(prefix) = name.strip_suffix("SKILL.md") {
            return Ok(prefix.to_string());
        }
    }
    Err("Skill zip must contain SKILL.md".to_string())
}

fn safe_zip_relative_path(relative: &str) -> Result<PathBuf, String> {
    if Path::new(relative).is_absolute() {
        return Err("Zip entry uses absolute path".to_string());
    }
    let mut out = PathBuf::new();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err("Zip entry escapes install directory".to_string());
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err("Zip entry path is empty".to_string());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_install_conflict_keeps_existing_directory_unchanged() {
        let root = tempfile::tempdir().expect("skill install root");
        let target = root.path().join("shared-skill");
        let staging = root.path().join(".shared-skill.installing");
        fs::create_dir_all(&target).expect("existing target");
        fs::create_dir_all(&staging).expect("staging target");
        fs::write(target.join("SKILL.md"), "old").expect("old Skill");
        fs::write(staging.join("SKILL.md"), "new").expect("new Skill");

        assert_eq!(
            commit_staged_skill_install(&staging, &target, false).unwrap_err(),
            SKILL_INSTALL_CONFLICT_ERROR
        );
        assert_eq!(
            fs::read_to_string(target.join("SKILL.md")).expect("old Skill remains"),
            "old"
        );
    }

    #[test]
    fn confirmed_skill_install_replaces_the_whole_directory() {
        let root = tempfile::tempdir().expect("skill install root");
        let target = root.path().join("shared-skill");
        let staging = root.path().join(".shared-skill.installing");
        fs::create_dir_all(&target).expect("existing target");
        fs::create_dir_all(&staging).expect("staging target");
        fs::write(target.join("SKILL.md"), "old").expect("old Skill");
        fs::write(target.join("stale.txt"), "stale").expect("stale file");
        fs::write(staging.join("SKILL.md"), "new").expect("new Skill");

        commit_staged_skill_install(&staging, &target, true).expect("replace Skill");

        assert_eq!(
            fs::read_to_string(target.join("SKILL.md")).expect("new Skill installed"),
            "new"
        );
        assert!(!target.join("stale.txt").exists());
        assert!(!staging.exists());
        assert!(fs::read_dir(root.path())
            .expect("install root")
            .all(|entry| !entry
                .expect("install entry")
                .file_name()
                .to_string_lossy()
                .contains("myagents-replacing")));
    }

    #[test]
    fn failed_skill_install_commit_restores_the_previous_directory() {
        let root = tempfile::tempdir().expect("skill install root");
        let target = root.path().join("shared-skill");
        let missing_staging = root.path().join(".shared-skill.missing");
        fs::create_dir_all(&target).expect("existing target");
        fs::write(target.join("SKILL.md"), "old").expect("old Skill");

        let error = commit_staged_skill_install(&missing_staging, &target, true)
            .expect_err("missing staging must fail");

        assert!(error.contains("Failed to commit skill install"));
        assert_eq!(
            fs::read_to_string(target.join("SKILL.md")).expect("old Skill restored"),
            "old"
        );
        assert!(fs::read_dir(root.path())
            .expect("install root")
            .all(|entry| !entry
                .expect("install entry")
                .file_name()
                .to_string_lossy()
                .contains("myagents-replacing")));
    }

    #[cfg(unix)]
    #[test]
    fn confirmed_skill_install_replaces_a_symlink_without_following_it() {
        let root = tempfile::tempdir().expect("skill install root");
        let external = tempfile::tempdir().expect("external target");
        let target = root.path().join("shared-skill");
        let staging = root.path().join(".shared-skill.installing");
        fs::write(external.path().join("sentinel"), "untouched").expect("external sentinel");
        std::os::unix::fs::symlink(external.path(), &target).expect("target symlink");
        fs::create_dir_all(&staging).expect("staging target");
        fs::write(staging.join("SKILL.md"), "new").expect("new Skill");

        commit_staged_skill_install(&staging, &target, true).expect("replace symlink slot");

        assert!(target.is_dir());
        assert!(!fs::symlink_metadata(&target)
            .expect("installed target")
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(external.path().join("sentinel")).expect("external untouched"),
            "untouched"
        );
    }
}
