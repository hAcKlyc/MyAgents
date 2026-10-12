//! Unified process cleanup using `sysinfo` (native API).
//!
//! Replaces the legacy PowerShell/WMI-based Windows cleanup (which spawned
//! ~6 PowerShell processes per invocation, each cold-starting .NET + WMI
//! for 1–3 s) and the Unix `pgrep` path. The legacy Windows path blocked
//! Tauri `setup()` on the main thread for 5–15 s on first launch, which
//! directly caused the "frontend freeze" user reports.
//!
//! Recovery-only pit-of-success property: after the previous process owner is
//! known to be dead, callers pass a list of [`ProcessPattern`] and get back a
//! [`CleanupReport`]. No ad-hoc shell invocations. Matches are closed under
//! descendants-by-PPID, which catches crash residuals behind an intermediate
//! `cmd.exe`. Live Sidecar / Plugin Bridge shutdown must instead retain and
//! terminate the exact birth-time [`crate::process_cmd::ChildTree`] authority;
//! it must never infer ownership from a whole-machine argv match.
//!
//! Performance: on a clean first launch (zero matches), the single
//! `sysinfo` enumeration completes in ~10–50 ms vs ~5–15 s for the old
//! PowerShell chain. On restarts with live children, ~50–200 ms total.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System};

/// A substring pattern tested against a process's full command line (the
/// `argv` array joined by space).
///
/// Patterns MUST use forward slashes for path components even when targeting
/// Windows paths — the matcher normalizes `\` → `/` before comparison so a
/// single pattern handles both separator conventions.
#[derive(Debug, Clone, Copy)]
pub struct ProcessPattern {
    pub name: &'static str,
    pub pattern: &'static str,
}

impl ProcessPattern {
    pub const fn new(name: &'static str, pattern: &'static str) -> Self {
        Self { name, pattern }
    }
}

#[derive(Debug, Default, Clone)]
pub struct CleanupReport {
    /// Processes whose own command line matched a pattern.
    pub matched_roots: usize,
    /// Additional descendants (via PPID) killed alongside matched roots.
    pub descendants: usize,
    /// Processes actually terminated successfully.
    pub killed: usize,
    /// Processes still alive after the termination deadline.
    pub residual: usize,
    /// PIDs still alive after the termination deadline. Includes descendant
    /// processes that may not match MyAgents command-line/root patterns
    /// themselves, so update shutdown can keep verifying them explicitly.
    pub residual_pids: Vec<u32>,
    /// Total wall-clock time spent in this call.
    pub elapsed: Duration,
}

#[derive(Debug, Clone)]
pub struct ProcessMatch {
    pub pid: u32,
    pub name: String,
    pub reason: String,
    pub exe: Option<String>,
    pub cmd: String,
}

impl CleanupReport {
    pub fn total_targets(&self) -> usize {
        self.matched_roots + self.descendants
    }
}

/// Normalize a command-line string or pattern for substring matching:
/// backslashes → forward slashes (so one pattern covers both separator
/// conventions), and lowercase (so we match Windows' case-insensitive
/// filesystem behavior, reproducing the prior PowerShell `-like` semantics).
fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c == '\\' {
            out.push('/');
        } else {
            for lc in c.to_lowercase() {
                out.push(lc);
            }
        }
    }
    out
}

fn normalize_path_boundary(s: &str) -> String {
    let stripped = s
        .strip_prefix(r"\\?\")
        .or_else(|| s.strip_prefix(r"//?/"))
        .unwrap_or(s);
    normalize(stripped).trim_end_matches('/').to_string()
}

fn normalized_roots(roots: &[PathBuf]) -> Vec<String> {
    roots
        .iter()
        .filter_map(|root| {
            let normalized = normalize_path_boundary(&root.to_string_lossy());
            if normalized.is_empty() {
                None
            } else {
                Some(normalized)
            }
        })
        .collect()
}

fn is_under_root(candidate: &str, root: &str) -> bool {
    candidate == root
        || candidate
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn contains_root_reference(haystack: &str, root: &str) -> bool {
    let mut offset = 0usize;
    while let Some(found) = haystack[offset..].find(root) {
        let start = offset + found;
        let end = start + root.len();
        let before_ok = start == 0
            || haystack[..start].chars().next_back().is_some_and(|c| {
                c.is_whitespace() || c == '"' || c == '\'' || c == '/' || c == '='
            });
        let after_ok = end == haystack.len()
            || haystack[end..]
                .chars()
                .next()
                .is_some_and(|c| c == '/' || c.is_whitespace() || c == '"' || c == '\'');
        if before_ok && after_ok {
            return true;
        }
        offset = end;
    }
    false
}

fn process_match_reason(
    cmd_norm: &str,
    exe_norm: Option<&str>,
    patterns: &[String],
    roots: &[String],
) -> Option<String> {
    for pattern in patterns {
        if cmd_norm.contains(pattern.as_str()) {
            return Some(format!("cmd contains '{}'", pattern));
        }
    }

    for root in roots {
        if let Some(exe) = exe_norm {
            if is_under_root(exe, root) {
                return Some(format!("exe under '{}'", root));
            }
        }
        if contains_root_reference(cmd_norm, root) {
            return Some(format!("cmd references '{}'", root));
        }
    }

    None
}

/// Enumerate, terminate, and confirm death of all processes whose command
/// line matches any of `patterns`, plus their descendants by PPID.
///
/// This is the one and only process-cleanup entry point in the app. Use
/// it for both startup-time stale cleanup and shutdown-time orphan
/// cleanup. Always excludes the current process PID.
///
/// Wait budget for confirmed termination: **3 s**. Any process still alive
/// after that is counted in `residual` and logged by callers.
pub fn kill_stale_processes(patterns: &[ProcessPattern]) -> CleanupReport {
    kill_stale_processes_with_roots(patterns, &[])
}

/// Enumerate, terminate, and confirm death of all processes matching command
/// line patterns or running from/with argv references to one of `protected_roots`.
///
/// The roots path is used by the Windows updater shutdown path: anything still
/// executing from the current MyAgents install/resource directory can hold
/// files that NSIS needs to overwrite, even if its argv no longer includes a
/// legacy marker.
pub fn kill_stale_processes_with_roots(
    patterns: &[ProcessPattern],
    protected_roots: &[PathBuf],
) -> CleanupReport {
    let started = Instant::now();
    let mut system = System::new();
    // Refresh with CMD info so Process::cmd() is populated.
    // `remove_dead_processes=true` — IMPORTANT: when false, sysinfo keeps
    // stale entries in the map even after the process has exited, and our
    // later liveness polling loop would always see "alive" and wait the
    // full deadline. Verified against sysinfo 0.33 source (common/system.rs).
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cmd(sysinfo::UpdateKind::Always)
            .with_exe(sysinfo::UpdateKind::Always),
    );

    let self_pid = Pid::from_u32(std::process::id());

    // Build PPID → children map once (sysinfo gives us flat list).
    let mut children_of: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, proc) in system.processes() {
        if let Some(parent) = proc.parent() {
            children_of.entry(parent).or_default().push(*pid);
        }
    }

    // Pre-normalize patterns once — saves per-process string allocation.
    let norm_patterns: Vec<String> = patterns.iter().map(|p| normalize(p.pattern)).collect();
    let norm_roots = normalized_roots(protected_roots);

    // Find root matches by command-line pattern.
    let mut roots: HashSet<Pid> = HashSet::new();
    for (pid, proc) in system.processes() {
        if *pid == self_pid {
            continue;
        }
        let cmd_raw: String = proc
            .cmd()
            .iter()
            .map(|os| os.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        let cmd_norm = normalize(&cmd_raw);
        let exe_norm = proc
            .exe()
            .map(|p| normalize_path_boundary(&p.to_string_lossy()));
        if cmd_raw.is_empty() && exe_norm.is_none() {
            continue;
        }
        if process_match_reason(&cmd_norm, exe_norm.as_deref(), &norm_patterns, &norm_roots)
            .is_some()
        {
            roots.insert(*pid);
        }
    }
    let matched_roots = roots.len();

    // BFS: collect all descendants of matched roots.
    let mut to_kill: HashSet<Pid> = roots.clone();
    let mut queue: Vec<Pid> = roots.iter().copied().collect();
    while let Some(p) = queue.pop() {
        if let Some(kids) = children_of.get(&p) {
            for kid in kids {
                if *kid == self_pid {
                    continue;
                }
                if to_kill.insert(*kid) {
                    queue.push(*kid);
                }
            }
        }
    }
    let descendants = to_kill.len().saturating_sub(matched_roots);

    if to_kill.is_empty() {
        return CleanupReport {
            elapsed: started.elapsed(),
            ..Default::default()
        };
    }

    // Terminate: TerminateProcess on Windows / SIGKILL on Unix.
    let mut killed = 0;
    for pid in &to_kill {
        if let Some(proc) = system.process(*pid) {
            if proc.kill() {
                killed += 1;
            }
        }
    }

    // Confirm death. TerminateProcess is synchronous in theory but the
    // kernel handle-closure finalizer can lag a few ms. 3 s deadline
    // covers worst-case; in practice this loop exits in <50 ms.
    //
    // CRITICAL: `remove_dead_processes=true` in the refresh call — sysinfo
    // otherwise keeps dead PIDs in its internal HashMap and every poll
    // would see the process as still present, forcing us to wait the full
    // deadline on every real cleanup run. With `true`, dead PIDs are
    // purged from the map and `system.process(pid)` correctly returns
    // None once the kernel releases the handle.
    let deadline = started + Duration::from_secs(3);
    let kill_slice: Vec<Pid> = to_kill.iter().copied().collect();
    let residual_pids: Vec<u32>;
    loop {
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&kill_slice),
            true,
            ProcessRefreshKind::nothing(),
        );
        let alive: Vec<Pid> = kill_slice
            .iter()
            .copied()
            .filter(|pid| system.process(*pid).is_some())
            .collect();
        if alive.is_empty() || Instant::now() >= deadline {
            residual_pids = alive.iter().map(|pid| pid.as_u32()).collect();
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    CleanupReport {
        matched_roots,
        descendants,
        killed,
        residual: residual_pids.len(),
        residual_pids,
        elapsed: started.elapsed(),
    }
}

/// Test if any live process still matches any of `patterns` (excluding self).
///
/// Used by the update-shutdown path to verify an earlier termination pass
/// actually completed before handing control off to the NSIS installer.
pub fn has_matching_processes(patterns: &[ProcessPattern]) -> bool {
    has_matching_processes_with_roots(patterns, &[])
}

pub fn has_matching_processes_with_roots(
    patterns: &[ProcessPattern],
    protected_roots: &[PathBuf],
) -> bool {
    !find_matching_processes_with_roots(patterns, protected_roots).is_empty()
}

pub fn find_matching_processes_with_roots(
    patterns: &[ProcessPattern],
    protected_roots: &[PathBuf],
) -> Vec<ProcessMatch> {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cmd(sysinfo::UpdateKind::Always)
            .with_exe(sysinfo::UpdateKind::Always),
    );
    let self_pid = Pid::from_u32(std::process::id());
    let norm_patterns: Vec<String> = patterns.iter().map(|p| normalize(p.pattern)).collect();
    let norm_roots = normalized_roots(protected_roots);
    let mut matches = Vec::new();
    for (pid, proc) in system.processes() {
        if *pid == self_pid {
            continue;
        }
        let cmd_raw: String = proc
            .cmd()
            .iter()
            .map(|os| os.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        let cmd_norm = normalize(&cmd_raw);
        let exe = proc.exe().map(|p| p.to_string_lossy().into_owned());
        let exe_norm = exe.as_deref().map(normalize_path_boundary);
        if cmd_raw.is_empty() && exe_norm.is_none() {
            continue;
        }
        if let Some(reason) =
            process_match_reason(&cmd_norm, exe_norm.as_deref(), &norm_patterns, &norm_roots)
        {
            matches.push(ProcessMatch {
                pid: pid.as_u32(),
                name: proc.name().to_string_lossy().into_owned(),
                reason,
                exe,
                cmd: cmd_raw,
            });
        }
    }
    matches
}

pub fn find_live_processes_by_pid(pids: &[u32]) -> Vec<ProcessMatch> {
    let sysinfo_pids: Vec<Pid> = pids.iter().copied().map(Pid::from_u32).collect();
    if sysinfo_pids.is_empty() {
        return Vec::new();
    }

    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&sysinfo_pids),
        true,
        ProcessRefreshKind::nothing()
            .with_cmd(sysinfo::UpdateKind::Always)
            .with_exe(sysinfo::UpdateKind::Always),
    );
    sysinfo_pids
        .iter()
        .filter_map(|pid| {
            system
                .process(*pid)
                // Linux keeps a killed orphan visible as a zombie until its
                // reaper runs. It owns no executable resources and cannot be
                // killed again, so it must not block shutdown convergence.
                .filter(|proc| proc.status() != ProcessStatus::Zombie)
                .map(|proc| {
                    let cmd_raw: String = proc
                        .cmd()
                        .iter()
                        .map(|os| os.to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join(" ");
                    ProcessMatch {
                        pid: pid.as_u32(),
                        name: proc.name().to_string_lossy().into_owned(),
                        reason: "residual descendant after kill".to_string(),
                        exe: proc.exe().map(|p| p.to_string_lossy().into_owned()),
                        cmd: cmd_raw,
                    }
                })
        })
        .collect()
}

/// Query whether a specific PID corresponds to a MyAgents process.
/// Uses the executable path (`GetModuleFileNameExW` underneath), so it is
/// reliable whether the process was spawned via shortcut, installer, or
/// direct path. Only the current executable can own a replacement lock;
/// a different product or a recycled PID must never be killed.
pub fn is_myagents_pid(pid: u32) -> bool {
    let mut system = System::new();
    let only: [Pid; 1] = [Pid::from_u32(pid)];
    // remove_dead_processes=true so that a dead PID returns None from
    // system.process() below rather than a stale entry.
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&only),
        true,
        ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
    );
    let Some(proc) = system.process(Pid::from_u32(pid)) else {
        return false;
    };
    // Prefer exe_path (full path) — sysinfo falls back to name() internally.
    let haystack: String = proc
        .exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| proc.name().to_string_lossy().into_owned());
    // A recycled PID or another product's binary is never replacement authority.
    // Compare the actual executable, not a brand substring shared by both builds.
    std::env::current_exe().ok().is_some_and(|current| {
        normalize_path_boundary(&haystack)
            == normalize_path_boundary(&current.to_string_lossy())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moxbot_recovery_roots_exclude_original_app_and_sdk() {
        let roots = normalized_roots(&[
            PathBuf::from("/Applications/MoX bot.app/Contents/Resources"),
            PathBuf::from("/Users/alice/.moxbot"),
        ]);
        for command in [
            "/Applications/MyAgents.app/Contents/Resources/nodejs/bin/node --myagents-sidecar",
            "node /Applications/MyAgents.app/Contents/Resources/claude-agent-sdk/cli.js",
            "node /Users/alice/.myagents/mcp/server.js",
            "node /Users/alice/.moxbot-backup/mcp/server.js",
        ] {
            assert!(process_match_reason(&normalize(command), None, &[], &roots).is_none());
        }
        assert!(process_match_reason(
            &normalize("node /Applications/MoX bot.app/Contents/Resources/server-dist.js --moxbot-sidecar"),
            None, &[], &roots,
        ).is_some());
        assert!(process_match_reason(
            &normalize("node /Users/alice/.moxbot/mcp/server.js"), None, &[], &roots,
        ).is_some());
    }

    #[test]
    fn root_match_accepts_windows_separator_variants() {
        let roots = normalized_roots(&[PathBuf::from(
            r"C:\Users\alice\AppData\Local\MyAgents\resources",
        )]);
        assert_eq!(
            process_match_reason(
                "c:/users/alice/appdata/local/myagents/resources/nodejs/node.exe server-dist.js",
                Some("c:/users/alice/appdata/local/myagents/resources/nodejs/node.exe"),
                &[],
                &roots,
            )
            .as_deref(),
            Some("exe under 'c:/users/alice/appdata/local/myagents/resources'")
        );
    }

    #[test]
    fn root_match_strips_extended_length_prefix() {
        let roots = normalized_roots(&[PathBuf::from(
            r"\\?\C:\Users\alice\AppData\Local\MyAgents\resources",
        )]);
        assert!(process_match_reason(
            "node c:/users/alice/appdata/local/myagents/resources/plugin-bridge-dist.mjs",
            None,
            &[],
            &roots,
        )
        .is_some());
    }

    #[test]
    fn root_match_does_not_match_prefix_siblings_by_exe() {
        let roots = normalized_roots(&[PathBuf::from(
            r"C:\Users\alice\AppData\Local\MyAgents\resources",
        )]);
        assert!(process_match_reason(
            "",
            Some("c:/users/alice/appdata/local/myagents/resources-old/node.exe"),
            &[],
            &roots,
        )
        .is_none());
    }

    #[test]
    fn root_match_does_not_match_prefix_siblings_by_cmd() {
        let roots = normalized_roots(&[PathBuf::from(
            r"C:\Users\alice\AppData\Local\MyAgents\resources",
        )]);
        assert!(process_match_reason(
            "node c:/users/alice/appdata/local/myagents/resources-old/server-dist.js",
            None,
            &[],
            &roots,
        )
        .is_none());
    }

    #[test]
    fn root_match_does_not_require_command_line_when_exe_matches() {
        let roots = normalized_roots(&[PathBuf::from(
            r"C:\Users\alice\AppData\Local\MyAgents\resources",
        )]);
        assert!(process_match_reason(
            "",
            Some("c:/users/alice/appdata/local/myagents/resources/nodejs/node.exe"),
            &[],
            &roots,
        )
        .is_some());
    }

    #[test]
    fn root_match_accepts_file_url_command_arguments() {
        let roots = normalized_roots(&[PathBuf::from(
            r"C:\Users\alice\AppData\Local\MyAgents\resources",
        )]);
        assert!(process_match_reason(
            "node --import=file:///c:/users/alice/appdata/local/myagents/resources/tsx-runtime/loader.mjs",
            None,
            &[],
            &roots,
        )
        .is_some());
    }
}
