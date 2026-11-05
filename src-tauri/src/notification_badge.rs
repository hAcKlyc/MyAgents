use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
use crate::ulog_debug;
use crate::ulog_warn;

const MAX_VISIBLE_BADGE_COUNT: u32 = 99;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationBadgeIncrement {
    pub id: String,
    pub source: String,
    pub created_at: i64,
    pub target: NotificationBadgeTarget,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum NotificationBadgeTarget {
    #[serde(rename = "session")]
    Session {
        session_id: String,
        workspace_path: String,
    },
    #[serde(rename = "task-center")]
    TaskCenter {
        #[serde(skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
    },
}

#[tauri::command]
pub fn cmd_set_notification_badge<R: Runtime>(app: AppHandle<R>, count: u32, enabled: bool) {
    apply_notification_badge(&app, count, enabled);
}

pub fn emit_badge_increment<R: Runtime>(app: &AppHandle<R>, increment: NotificationBadgeIncrement) {
    if let Err(e) = app.emit("notification:badge-increment", increment) {
        ulog_warn!("[NotificationBadge] Failed to emit badge increment: {}", e);
    }
}

fn apply_notification_badge<R: Runtime>(app: &AppHandle<R>, count: u32, enabled: bool) {
    let visible_count = if enabled { count } else { 0 };
    let label = badge_label(visible_count);

    #[cfg(target_os = "macos")]
    {
        if let Some(window) = app.get_window("main") {
            if let Err(e) = window.set_badge_label(label.clone()) {
                ulog_warn!("[NotificationBadge] Failed to set macOS Dock badge: {}", e);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(window) = app.get_window("main") {
            let icon = label
                .as_ref()
                .map(|_| build_windows_badge_icon(visible_count));
            if let Err(e) = window.set_overlay_icon(icon) {
                ulog_warn!(
                    "[NotificationBadge] Failed to set Windows taskbar overlay: {}",
                    e
                );
            }
        }
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        if let Some(window) = app.get_window("main") {
            let badge_count = label
                .as_ref()
                .map(|_| visible_count.min(MAX_VISIBLE_BADGE_COUNT) as i64);
            if let Err(e) = window.set_badge_count(badge_count) {
                ulog_debug!("[NotificationBadge] Badge count unsupported here: {}", e);
            }
        }
    }

    crate::tray::set_notification_projection(app, count, enabled);
}

fn badge_label(count: u32) -> Option<String> {
    if count == 0 {
        None
    } else if count > MAX_VISIBLE_BADGE_COUNT {
        Some(format!("{}+", MAX_VISIBLE_BADGE_COUNT))
    } else {
        Some(count.to_string())
    }
}

#[cfg(target_os = "windows")]
fn build_windows_badge_icon(count: u32) -> tauri::image::Image<'static> {
    const SIZE: u32 = 32;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    draw_circle(&mut rgba, SIZE, 16.0, 16.0, 15.0);
    draw_label_centered(&mut rgba, SIZE, &short_badge_text(count), 4, 16.0, 16.0);
    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}

#[cfg(target_os = "windows")]
fn short_badge_text(count: u32) -> String {
    if count > 9 {
        "9+".to_string()
    } else {
        count.max(1).to_string()
    }
}

#[cfg(target_os = "windows")]
fn draw_circle(rgba: &mut [u8], size: u32, center_x: f32, center_y: f32, radius: f32) {
    for y in 0..size {
        for x in 0..size {
            let dx = (x as f32 + 0.5) - center_x;
            let dy = (y as f32 + 0.5) - center_y;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist > radius + 1.0 {
                continue;
            }
            let edge_alpha = if dist <= radius {
                255
            } else {
                ((1.0 - (dist - radius)).clamp(0.0, 1.0) * 255.0).round() as u8
            };
            set_pixel(rgba, size, x, y, [239, 68, 68, edge_alpha]);
        }
    }
}

#[cfg(target_os = "windows")]
fn draw_label_centered(
    rgba: &mut [u8],
    size: u32,
    text: &str,
    scale: u32,
    center_x: f32,
    center_y: f32,
) {
    let chars: Vec<char> = text.chars().collect();
    let glyph_w = 3 * scale;
    let glyph_h = 5 * scale;
    let gap = scale.saturating_sub(1).max(1);
    let total_w = (chars.len() as u32 * glyph_w) + (chars.len().saturating_sub(1) as u32 * gap);
    let start_x = (center_x - (total_w as f32 / 2.0)).round().max(0.0) as u32;
    let start_y = (center_y - (glyph_h as f32 / 2.0)).round().max(0.0) as u32;

    for (idx, ch) in chars.iter().enumerate() {
        let glyph = digit_glyph(*ch);
        let glyph_x = start_x + idx as u32 * (glyph_w + gap);
        for (row, pattern) in glyph.iter().enumerate() {
            for (col, value) in pattern.as_bytes().iter().enumerate() {
                if *value != b'1' {
                    continue;
                }
                fill_rect(
                    rgba,
                    size,
                    glyph_x + col as u32 * scale,
                    start_y + row as u32 * scale,
                    scale,
                    scale,
                    [255, 255, 255, 255],
                );
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn digit_glyph(ch: char) -> [&'static str; 5] {
    match ch {
        '0' => ["111", "101", "101", "101", "111"],
        '1' => ["010", "110", "010", "010", "111"],
        '2' => ["111", "001", "111", "100", "111"],
        '3' => ["111", "001", "111", "001", "111"],
        '4' => ["101", "101", "111", "001", "001"],
        '5' => ["111", "100", "111", "001", "111"],
        '6' => ["111", "100", "111", "101", "111"],
        '7' => ["111", "001", "010", "010", "010"],
        '8' => ["111", "101", "111", "101", "111"],
        '9' => ["111", "101", "111", "001", "111"],
        '+' => ["000", "010", "111", "010", "000"],
        _ => ["000", "000", "000", "000", "000"],
    }
}

#[cfg(target_os = "windows")]
fn fill_rect(rgba: &mut [u8], size: u32, x: u32, y: u32, w: u32, h: u32, color: [u8; 4]) {
    for yy in y..(y + h).min(size) {
        for xx in x..(x + w).min(size) {
            set_pixel(rgba, size, xx, yy, color);
        }
    }
}

#[cfg(target_os = "windows")]
fn set_pixel(rgba: &mut [u8], size: u32, x: u32, y: u32, color: [u8; 4]) {
    let i = ((y * size + x) * 4) as usize;
    rgba[i..i + 4].copy_from_slice(&color);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn badge_label_caps_and_clears() {
        assert_eq!(badge_label(0), None);
        assert_eq!(badge_label(1).as_deref(), Some("1"));
        assert_eq!(badge_label(99).as_deref(), Some("99"));
        assert_eq!(badge_label(100).as_deref(), Some("99+"));
    }
}
