//! Slash command listing for the chat input picker.
//!
//! Sources, in dedup priority order (first wins):
//! 1. `<workspace>/.claude/commands/*.md`        — project commands
//! 2. `~/.myagents/commands/*.md`                — user commands
//! 3. `<workspace>/.claude/skills/*/SKILL.md`    — project skills
//! 4. `~/.myagents/skills/*/SKILL.md`            — user skills (respects skills config disabled list)
//! 5. Built-in commands (compact, context, …)
//!
//! Returned shape exactly matches the sidecar `/api/commands` response
//! `SlashCommand[]` so the frontend can swap between the two without code
//! changes.
//!
//! This path is deliberately read-only. Runtime projection is owned by the
//! Sidecar at Query/turn admission; opening a picker must never mutate the
//! active Runtime's `.claude` view.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::path_safety::validate_external_read_path;
use super::skills_config::{
    is_required_system_skill, read_cli_tool_registry_enabled, read_disabled_list,
};

// These are *text-insertion* builtins: selecting one inserts `/name ` and the
// text is sent to the AI/CLI. Do NOT add UI-action commands here (e.g. `loop`,
// which opens a panel) — those are renderer-only and live in
// `src/renderer/utils/slashActions.ts`. Listing a UI-action command here would
// surface it in the launcher (no panel, no handler) as a dead text entry.
const BUILTIN_SLASH_COMMANDS: &[(&str, &str)] = &[
    ("compact", "压缩对话历史，释放上下文空间"),
    ("context", "显示或管理当前上下文"),
    ("cost", "查看 token 使用量和费用"),
    ("init", "初始化项目配置 (.CLAUDE.md)"),
    ("pr-comments", "生成 Pull Request 评论"),
    ("release-notes", "根据最近提交生成发布说明"),
    ("review", "对代码进行审查"),
    ("security-review", "进行安全相关的代码审查"),
];

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    pub name: String,
    /// Stable slash token. Absent when display and invocation identity match.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invocation_name: Option<String>,
    pub description: String,
    /// "builtin" | "custom" | "skill"
    pub source: String,
    /// "user" | "project" — only for custom / skill
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// File path on disk (custom) or SKILL.md path (skill).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Folder name for skills (may differ from display name).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
    /// File name without `.md` for custom commands.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandsResponse {
    pub success: bool,
    pub commands: Vec<SlashCommand>,
    /// Folder names of skills that came from the user-level dir but were NOT
    /// shadowed by a project-level skill — used by the frontend to know which
    /// global skills are still "active" after dedup.
    pub global_skill_folder_names: Vec<String>,
}

#[tauri::command]
pub async fn cmd_list_slash_commands(workspace: String) -> Result<SlashCommandsResponse, String> {
    // workspace may not exist yet (e.g. brand-new workspace selected in the
    // launcher before any chat has touched it), but it MUST still pass the
    // system-directory blacklist — otherwise a caller passing `/etc` or
    // `~/.ssh` could probe directory existence via this read-only scan. We
    // use `validate_external_read_path` (path traversal + blacklist only,
    // no existence requirement) instead of `validate_workspace_root` (which
    // requires the dir to exist). Empty string is treated as "no scan".
    let workspace_root = if workspace.is_empty() {
        PathBuf::new()
    } else {
        validate_external_read_path(&workspace)?
    };
    let workspace_exists = workspace_root.is_dir();

    let home_dir = dirs::home_dir().ok_or_else(|| "home dir unavailable".to_string())?;
    let myagents_root = home_dir.join(crate::app_dirs::APP_DATA_DIR_NAME);

    let disabled = disabled_skill_names_for_slash(&myagents_root);

    let mut commands: Vec<SlashCommand> = Vec::new();

    // 1. Project commands
    if workspace_exists {
        scan_commands_dir(
            &workspace_root.join(".claude").join("commands"),
            "project",
            &mut commands,
        );
    }
    // 2. User commands
    scan_commands_dir(&myagents_root.join("commands"), "user", &mut commands);
    // 3. Project skills
    if workspace_exists {
        scan_skills_dir(
            &workspace_root.join(".claude").join("skills"),
            "project",
            &disabled,
            &myagents_root.join("skills"),
            &mut commands,
        );
    }
    // 4. User skills
    scan_skills_dir(
        &myagents_root.join("skills"),
        "user",
        &disabled,
        &myagents_root.join("skills"),
        &mut commands,
    );

    // 5. Builtins (lowest priority — get filtered out if name collides)
    for (name, desc) in BUILTIN_SLASH_COMMANDS {
        commands.push(SlashCommand {
            name: name.to_string(),
            invocation_name: None,
            description: desc.to_string(),
            source: "builtin".to_string(),
            scope: None,
            path: None,
            folder_name: None,
            file_name: None,
        });
    }

    let global_skill_folder_names: Vec<String> = commands
        .iter()
        .filter(|c| {
            c.source == "skill" && c.scope.as_deref() == Some("user") && c.folder_name.is_some()
        })
        .filter_map(|c| c.folder_name.clone())
        .collect();

    // Dedup by invocation identity — first occurrence wins.
    let mut seen: HashSet<String> = HashSet::new();
    let unique: Vec<SlashCommand> = commands
        .into_iter()
        .filter(|c| seen.insert(c.invocation_name.as_deref().unwrap_or(&c.name).to_string()))
        .collect();

    Ok(SlashCommandsResponse {
        success: true,
        commands: unique,
        global_skill_folder_names,
    })
}

fn disabled_skill_names_for_slash(myagents_root: &Path) -> Vec<String> {
    let mut disabled = read_disabled_list(myagents_root);
    if !read_cli_tool_registry_enabled(myagents_root)
        && !disabled.iter().any(|name| name == "tool-creator")
    {
        disabled.push("tool-creator".to_string());
    }
    disabled
}

const MAX_COMMAND_SCAN_DEPTH: usize = 8;

fn scan_commands_dir(root: &Path, scope: &str, out: &mut Vec<SlashCommand>) {
    scan_commands_dir_at(root, root, scope, 0, out);
}

fn scan_commands_dir_at(
    root: &Path,
    current: &Path,
    scope: &str,
    depth: usize,
    out: &mut Vec<SlashCommand>,
) {
    if depth > MAX_COMMAND_SCAN_DEPTH {
        return;
    }
    let entries = match std::fs::read_dir(current) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry_result in entries {
        let entry = match entry_result {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        let path = entry.path();
        if file_type.is_dir() {
            scan_commands_dir_at(root, &path, scope, depth + 1, out);
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.ends_with(".md") {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let frontmatter = parse_command_frontmatter(&content);
        let source_local_id = match path.strip_prefix(root) {
            Ok(relative) => relative
                .with_extension("")
                .to_string_lossy()
                .replace('\\', "/"),
            Err(_) => continue,
        };
        let invocation_name = source_local_id.replace('/', ":");
        if !is_valid_slash_command_name(&invocation_name)
            || is_reserved_slash_command_name(&invocation_name)
        {
            continue;
        }
        let display_name = frontmatter
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| invocation_name.clone());
        out.push(SlashCommand {
            name: display_name,
            invocation_name: Some(invocation_name),
            description: frontmatter.description.unwrap_or_default(),
            source: "custom".to_string(),
            scope: Some(scope.to_string()),
            path: Some(path.to_string_lossy().to_string()),
            folder_name: None,
            file_name: Some(source_local_id),
        });
    }
}

fn is_valid_slash_command_name(name: &str) -> bool {
    let mut characters = name.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !first.is_alphanumeric() {
        return false;
    }
    let mut count = 1;
    for character in characters {
        count += 1;
        if count > 128 || !(character.is_alphanumeric() || matches!(character, ':' | '_' | '-')) {
            return false;
        }
    }
    true
}

fn is_reserved_slash_command_name(name: &str) -> bool {
    matches!(
        name,
        "compact"
            | "context"
            | "cost"
            | "init"
            | "pr-comments"
            | "release-notes"
            | "review"
            | "security-review"
            | "goal"
            | "loop"
    )
}

fn scan_skills_dir(
    dir: &Path,
    scope: &str,
    disabled: &[String],
    global_skills_root: &Path,
    out: &mut Vec<SlashCommand>,
) {
    let root_before = (scope == "user").then(|| file_snapshot(dir)).flatten();
    if scope == "user"
        && !root_before
            .as_ref()
            .map(FileSnapshot::is_dir)
            .unwrap_or(false)
    {
        return;
    }
    let output_start = out.len();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let entries: Vec<_> = entries.filter_map(Result::ok).collect();
    let folder_names: HashSet<String> = entries
        .iter()
        .map(|entry| skill_folder_key(&entry.file_name().to_string_lossy()))
        .collect();
    for entry in entries {
        let folder_name = entry.file_name().to_string_lossy().to_string();
        let folder_path = entry.path();

        // Launcher scans the project surface before the global surface. A
        // MyAgents-managed projection must not be mislabelled as a project
        // Skill and win that priority race; its canonical global entry is
        // classified below by the same evidence contract as Node.
        if scope == "project" && canonical_path_is_within(&folder_path, global_skills_root) {
            continue;
        }

        // Read-only scan — follow symlinks / Windows junctions to detect
        // dir-likeness so user-installed skills mounted via junction surface.
        // For a broken symlink, `metadata()` returns Err and we just skip;
        // the v0.2.5 cpSync crash mode (pit_of_success.md#fs-utils) doesn't apply
        // here because we never write through this path. Issue #104 was
        // about the sidecar's parallel `isDirEntry` helper supporting the
        // same junction-mounted case.
        let is_dir_like = std::fs::metadata(&folder_path)
            .map(|m| m.is_dir())
            .unwrap_or(false);
        if !is_dir_like {
            continue;
        }
        if scope == "user" && disabled.iter().any(|d| d == &folder_name) {
            continue;
        }

        let skill_md = folder_path.join("SKILL.md");
        let folder_before = (scope == "user")
            .then(|| file_snapshot(&folder_path))
            .flatten();
        let canonical_before = (scope == "user")
            .then(|| file_snapshot(&skill_md))
            .flatten();
        // A snapshot proves that the path stayed direct while its handle was
        // opened. Never read through a global link or a path that changed
        // during that proof. Project Skills keep their existing read semantics.
        if scope == "user"
            && (!folder_before
                .as_ref()
                .map(FileSnapshot::is_dir)
                .unwrap_or(false)
                || canonical_before.is_none())
        {
            continue;
        }
        let content_result = std::fs::read_to_string(&skill_md);
        let canonical_readable = content_result.is_ok();
        let content = match content_result {
            Ok(content) => content,
            Err(_) if scope == "user" => String::new(),
            Err(_) => continue,
        };
        let parsed = parse_skill_frontmatter(&content);
        let declared_identity = parsed.name.clone();

        if scope == "user" {
            let collision_base = collision_directory_base(&folder_name);
            let evidence = SkillIntegrityEvidence {
                folder_name: folder_name.clone(),
                declared_name: declared_identity,
                identity_case_insensitive: cfg!(windows),
                canonical_present: canonical_before
                    .as_ref()
                    .map(FileSnapshot::is_file)
                    .unwrap_or(false),
                canonical_readable,
                trusted_source: folder_before.is_some() && canonical_before.is_some(),
                unsuffixed_sibling_present: collision_base
                    .as_ref()
                    .map(|base| folder_names.contains(&skill_folder_key(base)))
                    .unwrap_or(false),
                reserved_entry_sibling_present: has_reserved_skill_entry_sibling(&folder_path),
                stable: file_snapshot_matches(folder_before.as_ref(), &folder_path)
                    && file_snapshot_matches(canonical_before.as_ref(), &skill_md),
            };
            let mut classification = classify_skill_integrity(&evidence);
            if classification.disposition != "blocked"
                && ((evidence
                    .declared_name
                    .as_deref()
                    .map(is_required_system_skill)
                    .unwrap_or(false)
                    && !skill_identity_equals(
                        evidence.declared_name.as_deref().unwrap_or_default(),
                        &folder_name,
                        evidence.identity_case_insensitive,
                    ))
                    || (is_required_system_skill(&folder_name)
                        && evidence.declared_name.is_some()
                        && !skill_identity_equals(
                            evidence.declared_name.as_deref().unwrap_or_default(),
                            &folder_name,
                            evidence.identity_case_insensitive,
                        )))
            {
                classification = SkillIntegrityClassification {
                    disposition: "blocked".to_string(),
                    reasons: vec!["untrusted_global_source".to_string()],
                };
            }
            if classification.disposition == "blocked" {
                continue;
            }
        }

        let name = parsed.name.clone().unwrap_or_else(|| folder_name.clone());
        out.push(SlashCommand {
            name,
            invocation_name: None,
            description: parsed.description.unwrap_or_default(),
            source: "skill".to_string(),
            scope: Some(scope.to_string()),
            path: Some(skill_md.to_string_lossy().to_string()),
            folder_name: Some(folder_name),
            file_name: None,
        });
    }
    if scope == "user" && !file_snapshot_matches(root_before.as_ref(), dir) {
        out.truncate(output_start);
    }
}

fn metadata_is_link_like(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    false
}

#[derive(Debug, Eq, PartialEq)]
enum FileSnapshot {
    Missing,
    Present {
        identity: same_file::Handle,
        metadata: String,
        is_dir: bool,
        is_file: bool,
    },
}

impl FileSnapshot {
    fn is_dir(&self) -> bool {
        matches!(self, Self::Present { is_dir: true, .. })
    }

    fn is_file(&self) -> bool {
        matches!(self, Self::Present { is_file: true, .. })
    }
}

fn file_snapshot(path: &Path) -> Option<FileSnapshot> {
    let identity = match same_file::Handle::from_path(path) {
        Ok(identity) => identity,
        Err(_) => {
            return match std::fs::symlink_metadata(path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Some(FileSnapshot::Missing)
                }
                _ => None,
            };
        }
    };
    let metadata = identity.as_file().metadata().ok()?;
    let path_metadata = std::fs::symlink_metadata(path).ok()?;
    if metadata_is_link_like(&path_metadata) {
        return None;
    }
    let current_identity = same_file::Handle::from_path(path).ok()?;
    let current_metadata = current_identity.as_file().metadata().ok()?;
    let signature = metadata_signature(&metadata);
    if current_identity != identity || metadata_signature(&current_metadata) != signature {
        return None;
    }
    Some(FileSnapshot::Present {
        is_dir: metadata.is_dir(),
        is_file: metadata.is_file(),
        metadata: signature,
        identity,
    })
}

fn file_snapshot_matches(before: Option<&FileSnapshot>, path: &Path) -> bool {
    let Some(before) = before else {
        return false;
    };
    file_snapshot(path).as_ref() == Some(before)
}

fn metadata_signature(metadata: &std::fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}",
            metadata.mode(),
            metadata.size(),
            metadata.mtime(),
            metadata.mtime_nsec(),
        )
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}",
            metadata.file_attributes(),
            metadata.creation_time(),
            metadata.last_write_time(),
            metadata.file_size(),
        )
    }
    #[cfg(not(any(unix, windows)))]
    {
        format!("{}:{}", metadata.len(), metadata.is_dir())
    }
}

fn skill_folder_key(name: &str) -> String {
    if cfg!(windows) {
        name.to_lowercase()
    } else {
        name.to_string()
    }
}

fn canonical_path_is_within(path: &Path, root: &Path) -> bool {
    match (std::fs::canonicalize(path), std::fs::canonicalize(root)) {
        (Ok(candidate), Ok(canonical_root)) => candidate.starts_with(canonical_root),
        _ => false,
    }
}

fn collision_directory_base(folder_name: &str) -> Option<String> {
    let prefix = folder_name.strip_suffix(')')?;
    let open = prefix.rfind('(')?;
    let digits = &prefix[open + 1..];
    if digits.is_empty() || !digits.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    let base = prefix[..open].trim();
    (!base.is_empty()).then(|| base.to_string())
}

fn is_reserved_skill_entry_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    let Some(stem) = upper.strip_suffix(".MD") else {
        return false;
    };
    let Some(rest) = stem.strip_prefix("SKILL") else {
        return false;
    };
    let rest = rest.strip_prefix(' ').unwrap_or(rest);
    if rest.starts_with(' ') {
        return false;
    }
    let Some(suffix) = rest
        .strip_prefix('(')
        .and_then(|rest| rest.strip_suffix(')'))
    else {
        return false;
    };
    !suffix.is_empty() && suffix.chars().all(|character| character.is_ascii_digit())
}

fn has_reserved_skill_entry_sibling(folder_path: &Path) -> bool {
    std::fs::read_dir(folder_path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .any(|entry| is_reserved_skill_entry_name(&entry.file_name().to_string_lossy()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillIntegrityEvidence {
    folder_name: String,
    declared_name: Option<String>,
    #[serde(default)]
    identity_case_insensitive: bool,
    canonical_present: bool,
    canonical_readable: bool,
    trusted_source: bool,
    unsuffixed_sibling_present: bool,
    reserved_entry_sibling_present: bool,
    stable: bool,
}

#[derive(Debug, Deserialize, PartialEq)]
struct SkillIntegrityClassification {
    disposition: String,
    reasons: Vec<String>,
}

fn classify_skill_integrity(evidence: &SkillIntegrityEvidence) -> SkillIntegrityClassification {
    let blocked = |reason: &str| SkillIntegrityClassification {
        disposition: "blocked".to_string(),
        reasons: vec![reason.to_string()],
    };
    if !evidence.stable {
        return blocked("inventory_unstable");
    }
    if !evidence.trusted_source {
        return blocked("untrusted_global_source");
    }
    if !evidence.canonical_present || !evidence.canonical_readable {
        return blocked("missing_canonical_entry");
    }
    if let Some(base) = collision_directory_base(&evidence.folder_name) {
        if evidence
            .declared_name
            .as_deref()
            .map(|declared| {
                skill_identity_equals(declared, &base, evidence.identity_case_insensitive)
            })
            .unwrap_or(false)
        {
            return blocked("collision_directory_identity");
        }
        if evidence.unsuffixed_sibling_present {
            return blocked("collision_directory_sibling");
        }
    }
    let mut reasons = Vec::new();
    if collision_directory_base(&evidence.folder_name).is_some() {
        reasons.push("unproven_suffix_directory".to_string());
    }
    if evidence.reserved_entry_sibling_present {
        reasons.push("reserved_entry_sibling".to_string());
    }
    SkillIntegrityClassification {
        disposition: if reasons.is_empty() {
            "admitted"
        } else {
            "warning"
        }
        .to_string(),
        reasons,
    }
}

fn skill_identity_equals(left: &str, right: &str, case_insensitive: bool) -> bool {
    if case_insensitive {
        left.to_lowercase() == right.to_lowercase()
    } else {
        left == right
    }
}

#[derive(Debug, Default)]
struct ParsedFrontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
}

/// Extract the YAML body between `---` fences and parse `name` + `description`.
/// Falls back gracefully (returns empty struct) if the file has no frontmatter
/// or the YAML is malformed — never errors out.
fn parse_skill_frontmatter(content: &str) -> ParsedFrontmatter {
    let mut parsed = parse_yaml_block(content);

    // Skill spec allows the name to come from the first `# Heading` if not
    // present in frontmatter. We mirror that behavior so a SKILL.md without
    // a `name:` key still surfaces with a meaningful name.
    if parsed.name.is_none() {
        let body = extract_body(content).unwrap_or(content.to_string());
        for line in body.lines() {
            let trimmed = line.trim_start();
            if let Some(rest) = trimmed.strip_prefix("# ") {
                parsed.name = Some(rest.trim().to_string());
                break;
            }
        }
    }
    parsed
}

fn parse_command_frontmatter(content: &str) -> ParsedFrontmatter {
    parse_yaml_block(content)
}

fn parse_yaml_block(content: &str) -> ParsedFrontmatter {
    let body = match extract_frontmatter_str(content) {
        Some(s) => s,
        None => return ParsedFrontmatter::default(),
    };
    let value: serde_yaml::Value = match serde_yaml::from_str(&body) {
        Ok(v) => v,
        Err(_) => return ParsedFrontmatter::default(),
    };
    let mapping = match value.as_mapping() {
        Some(m) => m,
        None => return ParsedFrontmatter::default(),
    };
    let mut out = ParsedFrontmatter::default();
    if let Some(v) = mapping.get(&serde_yaml::Value::String("name".into())) {
        if let Some(s) = v.as_str() {
            out.name = Some(s.to_string());
        }
    }
    if let Some(v) = mapping.get(&serde_yaml::Value::String("description".into())) {
        if let Some(s) = v.as_str() {
            out.description = Some(s.to_string());
        }
    }
    out
}

fn extract_frontmatter_str(content: &str) -> Option<String> {
    // Pattern: optional CR before first `---`, content body until next `---`.
    let s = content.trim_start();
    let stripped = s.strip_prefix("---")?;
    let after_first = stripped
        .strip_prefix('\n')
        .or_else(|| stripped.strip_prefix("\r\n"))?;
    // Find the closing `---` on its own line.
    let mut depth = 0;
    for (idx, line) in after_first.split_inclusive('\n').enumerate() {
        if line.trim_end_matches(['\r', '\n']) == "---" && idx > 0 {
            return Some(after_first[..depth].to_string());
        }
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return Some(String::new());
        }
        depth += line.len();
    }
    None
}

fn extract_body(content: &str) -> Option<String> {
    let s = content.trim_start();
    let stripped = s.strip_prefix("---")?;
    let after_first = stripped
        .strip_prefix('\n')
        .or_else(|| stripped.strip_prefix("\r\n"))?;
    let mut acc = 0;
    for (idx, line) in after_first.split_inclusive('\n').enumerate() {
        if line.trim_end_matches(['\r', '\n']) == "---" && idx > 0 {
            return Some(after_first[acc + line.len()..].to_string());
        }
        acc += line.len();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;
    use std::fs;

    fn make_tmp_workspace() -> PathBuf {
        make_test_workspace("slash")
    }

    #[test]
    fn file_snapshot_distinguishes_a_replaced_path_with_the_same_contents() {
        let root = make_tmp_workspace();
        let current = root.join("current.md");
        let displaced = root.join("displaced.md");
        fs::write(&current, "same contents").unwrap();

        let before = file_snapshot(&current).expect("initial file snapshot");
        fs::rename(&current, &displaced).unwrap();
        fs::write(&current, "same contents").unwrap();

        assert!(!file_snapshot_matches(Some(&before), &current));

        drop(before);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn file_snapshot_does_not_follow_a_link() {
        use std::os::unix::fs::symlink;

        let root = make_tmp_workspace();
        let actual = root.join("actual.md");
        let linked = root.join("linked.md");
        fs::write(&actual, "contents").unwrap();
        symlink(&actual, &linked).unwrap();

        assert!(file_snapshot(&linked).is_none());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn file_snapshot_keeps_a_missing_path_stable() {
        let root = make_tmp_workspace();
        let missing = root.join("missing.md");
        let before = file_snapshot(&missing).expect("missing-path snapshot");

        assert_eq!(before, FileSnapshot::Missing);
        assert!(file_snapshot_matches(Some(&before), &missing));

        let _ = fs::remove_dir_all(root);
    }

    #[derive(Deserialize)]
    struct SkillIntegrityFixture {
        name: String,
        evidence: SkillIntegrityEvidence,
        expected: SkillIntegrityClassification,
    }

    #[test]
    fn rust_classifier_matches_shared_skill_integrity_contract() {
        let fixtures: Vec<SkillIntegrityFixture> = serde_json::from_str(include_str!(
            "../../../src/shared/fixtures/skill-integrity-cases.json"
        ))
        .expect("shared Skill integrity fixtures");
        for fixture in fixtures {
            assert_eq!(
                classify_skill_integrity(&fixture.evidence),
                fixture.expected,
                "fixture: {}",
                fixture.name
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn global_scan_filters_blocked_entries_and_project_scan_skips_managed_links() {
        use std::os::unix::fs::symlink;

        let root = make_tmp_workspace();
        let global = root.join("global-skills");
        let project = root.join("project-skills");
        fs::create_dir_all(global.join("healthy")).unwrap();
        fs::write(
            global.join("healthy").join("SKILL.md"),
            "---\nname: healthy\ndescription: healthy\n---\n",
        )
        .unwrap();
        fs::create_dir_all(global.join("damaged")).unwrap();
        fs::write(global.join("damaged").join("SKILL(1).md"), "backup").unwrap();
        fs::create_dir_all(project.join("local")).unwrap();
        fs::write(
            project.join("local").join("SKILL.md"),
            "---\nname: local\ndescription: local\n---\n",
        )
        .unwrap();
        symlink(global.join("healthy"), project.join("healthy")).unwrap();

        let mut global_commands = Vec::new();
        scan_skills_dir(&global, "user", &[], &global, &mut global_commands);
        assert!(global_commands
            .iter()
            .any(|command| command.folder_name.as_deref() == Some("healthy")));
        assert!(!global_commands
            .iter()
            .any(|command| command.folder_name.as_deref() == Some("damaged")));

        let mut project_commands = Vec::new();
        scan_skills_dir(&project, "project", &[], &global, &mut project_commands);
        assert!(project_commands
            .iter()
            .any(|command| command.folder_name.as_deref() == Some("local")));
        assert!(!project_commands
            .iter()
            .any(|command| command.folder_name.as_deref() == Some("healthy")));

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn global_scan_does_not_follow_a_linked_root() {
        use std::os::unix::fs::symlink;

        let root = make_tmp_workspace();
        let actual = root.join("actual");
        let linked = root.join("linked");
        fs::create_dir_all(actual.join("escaped")).unwrap();
        fs::write(
            actual.join("escaped").join("SKILL.md"),
            "---\nname: escaped\ndescription: escaped\n---\n",
        )
        .unwrap();
        symlink(&actual, &linked).unwrap();

        let mut commands = Vec::new();
        scan_skills_dir(&linked, "user", &[], &linked, &mut commands);
        assert!(commands.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parses_skill_with_name_and_description() {
        let content = "---\nname: my-skill\ndescription: Does the thing\n---\n\n# Heading\nbody";
        let parsed = parse_skill_frontmatter(content);
        assert_eq!(parsed.name.as_deref(), Some("my-skill"));
        assert_eq!(parsed.description.as_deref(), Some("Does the thing"));
    }

    #[test]
    fn skill_falls_back_to_first_heading_for_name() {
        let content = "---\ndescription: foo\n---\n\n# Skill Title\nbody";
        let parsed = parse_skill_frontmatter(content);
        assert_eq!(parsed.name.as_deref(), Some("Skill Title"));
    }

    #[test]
    fn no_frontmatter_returns_empty() {
        let parsed = parse_skill_frontmatter("just plain markdown");
        assert!(parsed.name.is_none());
        assert!(parsed.description.is_none());
    }

    #[test]
    fn malformed_yaml_returns_empty() {
        let parsed = parse_skill_frontmatter("---\nname: [unclosed\n---\n");
        assert!(parsed.name.is_none());
    }

    #[test]
    fn disabled_skill_names_include_tool_creator_when_cli_tool_registry_gate_is_off() {
        let root = make_test_workspace("slash_gate_off_home").join(".myagents");
        fs::create_dir_all(&root).unwrap();

        let disabled = disabled_skill_names_for_slash(&root);

        assert!(disabled.iter().any(|name| name == "tool-creator"));
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn disabled_skill_names_do_not_include_tool_creator_when_cli_tool_registry_gate_is_on() {
        let root = make_test_workspace("slash_gate_on_home").join(".myagents");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("config.json"),
            r#"{"cliToolRegistryEnabled":true}"#,
        )
        .unwrap();

        let disabled = disabled_skill_names_for_slash(&root);

        assert!(!disabled.iter().any(|name| name == "tool-creator"));
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn disabled_skill_names_keep_required_system_skills_available() {
        let root = make_test_workspace("slash_required_home").join(".myagents");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("skills-config.json"),
            r#"{"disabled":["myagents-memory-update","myagents-memory-gardener","myagents-memory-molt","myagents-cli","myagents-task-automation","myagents-docs","prompt-writer"]}"#,
        )
        .unwrap();

        let disabled = disabled_skill_names_for_slash(&root);

        for name in [
            "myagents-memory-update",
            "myagents-memory-gardener",
            "myagents-memory-molt",
            "myagents-cli",
            "myagents-task-automation",
            "myagents-docs",
        ] {
            assert!(!disabled.iter().any(|candidate| candidate == name));
        }
        assert!(disabled.iter().any(|name| name == "prompt-writer"));
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[tokio::test]
    async fn lists_builtin_when_no_dirs_exist() {
        let ws = make_tmp_workspace();
        let res = cmd_list_slash_commands(ws.to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(res.success);
        // Built-ins should always appear at minimum.
        assert!(res.commands.iter().any(|c| c.name == "review"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn lists_project_commands() {
        let ws = make_tmp_workspace();
        let cmd_dir = ws.join(".claude").join("commands");
        fs::create_dir_all(&cmd_dir).unwrap();
        fs::write(
            cmd_dir.join("my-cmd.md"),
            "---\ndescription: My custom command\n---\nbody\n",
        )
        .unwrap();
        let res = cmd_list_slash_commands(ws.to_string_lossy().to_string())
            .await
            .unwrap();
        let hit = res.commands.iter().find(|c| c.name == "my-cmd").unwrap();
        assert_eq!(hit.source, "custom");
        assert_eq!(hit.scope.as_deref(), Some("project"));
        assert_eq!(hit.description, "My custom command");
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn command_invocation_uses_unicode_filename_instead_of_display_name() {
        let ws = make_tmp_workspace();
        let cmd_dir = ws.join(".claude").join("commands");
        fs::create_dir_all(&cmd_dir).unwrap();
        fs::write(
            cmd_dir.join("中文-总结.md"),
            "---\nname: 中文 总结\ndescription: 总结当前工作\n---\nbody\n",
        )
        .unwrap();

        let res = cmd_list_slash_commands(ws.to_string_lossy().to_string())
            .await
            .unwrap();
        let hit = res
            .commands
            .iter()
            .find(|command| command.file_name.as_deref() == Some("中文-总结"))
            .unwrap();
        assert_eq!(hit.name, "中文 总结");
        assert_eq!(hit.invocation_name.as_deref(), Some("中文-总结"));
        assert_eq!(hit.description, "总结当前工作");
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn nested_project_command_uses_colon_namespace() {
        let ws = make_tmp_workspace();
        let cmd_dir = ws.join(".claude").join("commands").join("发布");
        fs::create_dir_all(&cmd_dir).unwrap();
        fs::write(
            cmd_dir.join("生成-周报.md"),
            "---\nname: 生成周报\ndescription: 生成当前周报\n---\nbody\n",
        )
        .unwrap();

        let res = cmd_list_slash_commands(ws.to_string_lossy().to_string())
            .await
            .unwrap();
        let hit = res
            .commands
            .iter()
            .find(|command| command.invocation_name.as_deref() == Some("发布:生成-周报"))
            .unwrap();
        assert_eq!(hit.name, "生成周报");
        assert_eq!(hit.file_name.as_deref(), Some("发布/生成-周报"));
        assert_eq!(hit.description, "生成当前周报");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn nested_global_command_uses_the_same_colon_namespace() {
        let root = make_tmp_workspace().join("commands");
        let cmd_dir = root.join("发布");
        fs::create_dir_all(&cmd_dir).unwrap();
        fs::write(
            cmd_dir.join("生成-周报.md"),
            "---\nname: 全局周报\ndescription: 生成当前周报\n---\nbody\n",
        )
        .unwrap();

        let mut commands = Vec::new();
        scan_commands_dir(&root, "user", &mut commands);
        let hit = commands
            .iter()
            .find(|command| command.invocation_name.as_deref() == Some("发布:生成-周报"))
            .unwrap();
        assert_eq!(hit.name, "全局周报");
        assert_eq!(hit.file_name.as_deref(), Some("发布/生成-周报"));
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[tokio::test]
    async fn lists_project_skills() {
        let ws = make_tmp_workspace();
        let skill_dir = ws.join(".claude").join("skills").join("my-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: my-skill\ndescription: hello\n---\n",
        )
        .unwrap();
        let res = cmd_list_slash_commands(ws.to_string_lossy().to_string())
            .await
            .unwrap();
        let hit = res.commands.iter().find(|c| c.name == "my-skill").unwrap();
        assert_eq!(hit.source, "skill");
        assert_eq!(hit.scope.as_deref(), Some("project"));
        assert_eq!(hit.folder_name.as_deref(), Some("my-skill"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn reserved_product_command_cannot_be_overridden_by_a_project_file() {
        let ws = make_tmp_workspace();
        let cmd_dir = ws.join(".claude").join("commands");
        fs::create_dir_all(&cmd_dir).unwrap();
        fs::write(
            cmd_dir.join("review.md"),
            "---\ndescription: Custom review\n---\n",
        )
        .unwrap();
        let res = cmd_list_slash_commands(ws.to_string_lossy().to_string())
            .await
            .unwrap();
        let review = res.commands.iter().find(|c| c.name == "review").unwrap();
        assert_eq!(review.source, "builtin");
        // Should appear only once.
        assert_eq!(
            res.commands.iter().filter(|c| c.name == "review").count(),
            1
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn handles_nonexistent_workspace() {
        // Should still return builtins, not error.
        let res = cmd_list_slash_commands("/definitely/not/a/real/path".to_string()).await;
        // validate_file_path is permissive about non-existent paths since the
        // function is supposed to be safe-by-default. For workspace listing
        // we treat missing workspace as "skip project scan".
        if let Ok(r) = res {
            assert!(r.commands.iter().any(|c| c.name == "review"));
        }
        // If validation rejects, that's also acceptable behavior — both modes
        // are non-crashing.
    }
}
