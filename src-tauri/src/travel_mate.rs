//! Opt-in travel mode for the desktop pet.
//!
//! This module is the single authority for travel state, deadlines and
//! persistence. Renderer windows only report attention state and present the
//! snapshot emitted by this owner.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use uuid::Uuid;

const SCHEMA_VERSION: u8 = 1;
const STORE_FILE: &str = "travel_mate.json";
const STORE_LOCK: &str = "travel_mate.json.lock";
const DEPARTURE_MIN_MS: i64 = 4 * 60 * 60 * 1_000;
const DEPARTURE_MAX_MS: i64 = 18 * 60 * 60 * 1_000;
const RETURN_MIN_MS: i64 = 20 * 60 * 1_000;
const RETURN_MAX_MS: i64 = 120 * 60 * 1_000;
const RETRY_MIN_MS: i64 = 5 * 60 * 1_000;
const RETRY_MAX_MS: i64 = 20 * 60 * 1_000;
const TICK_INTERVAL_SECS: u64 = 30;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PetSpecies {
    Cat,
    Dog,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PetIdentity {
    pub id: String,
    pub display_name: String,
    pub species: PetSpecies,
}

impl PetIdentity {
    fn fallback() -> Self {
        Self {
            id: "mino".into(),
            display_name: "Mino".into(),
            species: PetSpecies::Cat,
        }
    }

    fn sanitized(mut self) -> Self {
        self.id = bounded_text(&self.id, 64);
        self.display_name = bounded_text(&self.display_name, 64);
        if self.id.is_empty() {
            self.id = "pet".into();
        }
        if self.display_name.is_empty() {
            self.display_name = match self.species {
                PetSpecies::Cat => "小猫旅伴",
                PetSpecies::Dog => "小狗旅伴",
                PetSpecies::Other => "桌面旅伴",
            }
            .into();
        }
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PostcardMotif {
    pub kind: String,
    pub symbol: String,
    pub palette: [String; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TravelPostcard {
    pub trip_id: String,
    pub destination: String,
    pub headline: String,
    pub story: String,
    pub signature: String,
    pub motif: PostcardMotif,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TravelPhase {
    Disabled,
    HomeScheduled {
        #[serde(rename = "departureAtMs")]
        departure_at_ms: i64,
    },
    Away {
        #[serde(rename = "tripId")]
        trip_id: String,
        #[serde(rename = "departedAtMs")]
        departed_at_ms: i64,
        #[serde(rename = "returnAtMs")]
        return_at_ms: i64,
        #[serde(rename = "postcardSeed")]
        postcard_seed: u64,
        pet: PetIdentity,
    },
    ReturnedPendingPostcard {
        #[serde(rename = "tripId")]
        trip_id: String,
        postcard: TravelPostcard,
        #[serde(rename = "returnedAtMs")]
        returned_at_ms: i64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TravelSnapshot {
    pub version: u8,
    pub enabled: bool,
    pub phase: TravelPhase,
}

impl TravelSnapshot {
    pub fn disabled() -> Self {
        Self {
            version: SCHEMA_VERSION,
            enabled: false,
            phase: TravelPhase::Disabled,
        }
    }

    #[cfg(test)]
    fn scheduled(departure_at_ms: i64) -> Self {
        Self {
            version: SCHEMA_VERSION,
            enabled: true,
            phase: TravelPhase::HomeScheduled { departure_at_ms },
        }
    }

    #[cfg(test)]
    fn departure_at_ms(&self) -> Option<i64> {
        match self.phase {
            TravelPhase::HomeScheduled { departure_at_ms } => Some(departure_at_ms),
            _ => None,
        }
    }

    #[cfg(test)]
    fn return_at_ms(&self) -> Option<i64> {
        match self.phase {
            TravelPhase::Away { return_at_ms, .. } => Some(return_at_ms),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TravelEffect {
    Persist,
    HidePet,
    ShowPet,
    PresentPostcard,
}

#[derive(Debug, Clone)]
struct TravelTransition {
    snapshot: TravelSnapshot,
    effects: Vec<TravelEffect>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TravelAttention {
    pub has_pending_interaction: bool,
    pub is_blocked: bool,
    pub has_error: bool,
}

impl TravelAttention {
    fn can_depart(&self) -> bool {
        !(self.has_pending_interaction || self.is_blocked || self.has_error)
    }
}

#[derive(Debug)]
struct RuntimeState {
    snapshot: TravelSnapshot,
    attention: TravelAttention,
    current_pet: PetIdentity,
    loaded: bool,
    attention_ready: bool,
    hidden_trip: Option<String>,
    presented_trip: Option<String>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            snapshot: TravelSnapshot::disabled(),
            attention: TravelAttention::default(),
            current_pet: PetIdentity::fallback(),
            loaded: false,
            attention_ready: false,
            hidden_trip: None,
            presented_trip: None,
        }
    }
}

static RUNTIME: OnceLock<Mutex<RuntimeState>> = OnceLock::new();
static OPERATION: OnceLock<Mutex<()>> = OnceLock::new();

fn runtime() -> &'static Mutex<RuntimeState> {
    RUNTIME.get_or_init(|| Mutex::new(RuntimeState::default()))
}

fn operation_gate() -> &'static Mutex<()> {
    OPERATION.get_or_init(|| Mutex::new(()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn random_seed() -> u64 {
    let bytes = Uuid::new_v4().into_bytes();
    u64::from_le_bytes(bytes[..8].try_into().expect("UUID has eight leading bytes"))
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

fn scale_seed(seed: u64, minimum: i64, maximum: i64) -> i64 {
    let span = (maximum - minimum) as u128;
    minimum + ((span * seed as u128) / u64::MAX as u128) as i64
}

fn enable_travel(snapshot: TravelSnapshot, now: i64, seed: u64) -> TravelSnapshot {
    if snapshot.enabled && !matches!(snapshot.phase, TravelPhase::Disabled) {
        return snapshot;
    }
    TravelSnapshot {
        version: SCHEMA_VERSION,
        enabled: true,
        phase: TravelPhase::HomeScheduled {
            departure_at_ms: now + scale_seed(seed, DEPARTURE_MIN_MS, DEPARTURE_MAX_MS),
        },
    }
}

fn disable_travel(snapshot: TravelSnapshot) -> TravelTransition {
    if !snapshot.enabled && matches!(snapshot.phase, TravelPhase::Disabled) {
        return TravelTransition {
            snapshot,
            effects: Vec::new(),
        };
    }
    let should_recall = matches!(snapshot.phase, TravelPhase::Away { .. });
    let mut effects = vec![TravelEffect::Persist];
    if should_recall {
        effects.push(TravelEffect::ShowPet);
    }
    TravelTransition {
        snapshot: TravelSnapshot::disabled(),
        effects,
    }
}

fn create_postcard(trip_id: &str, seed: u64, pet: &PetIdentity) -> TravelPostcard {
    struct Place {
        name: &'static str,
        arrival: &'static str,
        encounter: [&'static str; 3],
        ending: &'static str,
        symbol: &'static str,
        palette: [&'static str; 3],
    }
    const PLACES: [Place; 6] = [
        Place {
            name: "西安城墙",
            arrival: "清晨的城砖还带着一点雨光。",
            encounter: [
                "我追着檐角的风铃走了半条老街。",
                "我在城墙根认识了一只爱散步的小狗。",
                "我在书院门口看了很久的云。",
            ],
            ending: "店主送了我一枚银杏书签。",
            symbol: "ginkgo",
            palette: ["#C8644B", "#F2D6B3", "#284B3F"],
        },
        Place {
            name: "青岛海边",
            arrival: "海风把早晨吹得亮晶晶的。",
            encounter: [
                "一只海鸥把我当成了码头的新邻居。",
                "我和沙滩上的脚印比赛跑到浪边。",
                "我听见旧灯塔在雾里轻轻响。",
            ],
            ending: "回来前，我把最好看的贝壳留在了口袋里。",
            symbol: "wave",
            palette: ["#3C7DA6", "#E7D7B7", "#F28C6A"],
        },
        Place {
            name: "成都茶馆",
            arrival: "竹椅旁飘着温暖的茶香。",
            encounter: [
                "我在窗台和一只橘猫交换了午睡位置。",
                "说书人的醒木一响，我的耳朵也跟着竖起来。",
                "我看大家慢慢把一个下午聊长。",
            ],
            ending: "老板给我的明信片盖了一枚熊猫印章。",
            symbol: "bamboo",
            palette: ["#52734D", "#D8C7A1", "#B85C4A"],
        },
        Place {
            name: "大理古城",
            arrival: "苍山的云落在白墙和青瓦之间。",
            encounter: [
                "我跟着一只花猫拐进开满花的小院。",
                "我在风里闻到好多陌生又好闻的味道。",
                "我坐在门槛上听了一首很慢的歌。",
            ],
            ending: "夕阳把归途涂成了蜂蜜色。",
            symbol: "cloud",
            palette: ["#6D8FA3", "#F1E3C6", "#C66B52"],
        },
        Place {
            name: "苏州园林",
            arrival: "窗格把午后的光切成安静的小块。",
            encounter: [
                "池边的锦鲤一路跟着我的影子。",
                "我沿着回廊认真巡逻了一圈。",
                "我在假山后发现一扇只给风走的小门。",
            ],
            ending: "临走时，荷叶上的水珠刚好滚进池里。",
            symbol: "lotus",
            palette: ["#47766B", "#E8DCC2", "#D67B76"],
        },
        Place {
            name: "哈尔滨雪街",
            arrival: "雪把整条街按下了静音键。",
            encounter: [
                "我在窗台留下了一串梅花印。",
                "围巾被风吹起来，像一面小旗子。",
                "我看冰灯把夜色照成了蓝色。",
            ],
            ending: "热乎乎的面包香一直送我到车站。",
            symbol: "snowflake",
            palette: ["#5C7C99", "#DDEAF0", "#D68A65"],
        },
    ];

    let place = &PLACES[(seed as usize) % PLACES.len()];
    let species_index = match pet.species {
        PetSpecies::Cat => 0,
        PetSpecies::Dog => 1,
        PetSpecies::Other => 2,
    };
    TravelPostcard {
        trip_id: trip_id.into(),
        destination: place.name.into(),
        headline: format!("我去了{}", place.name),
        story: format!(
            "{}{}{}我想，你看到它大概也会笑一下。",
            place.arrival, place.encounter[species_index], place.ending
        ),
        signature: format!("—— {}", pet.display_name),
        motif: PostcardMotif {
            kind: "line-art".into(),
            symbol: place.symbol.into(),
            palette: place.palette.map(String::from),
        },
    }
}

fn tick(
    snapshot: TravelSnapshot,
    now: i64,
    can_depart: bool,
    seed: u64,
    pet: PetIdentity,
) -> TravelTransition {
    if !snapshot.enabled {
        return TravelTransition {
            snapshot,
            effects: Vec::new(),
        };
    }

    match snapshot.phase {
        TravelPhase::HomeScheduled { departure_at_ms } if now >= departure_at_ms => {
            if !can_depart {
                return TravelTransition {
                    snapshot: TravelSnapshot {
                        version: SCHEMA_VERSION,
                        enabled: true,
                        phase: TravelPhase::HomeScheduled {
                            departure_at_ms: now + scale_seed(seed, RETRY_MIN_MS, RETRY_MAX_MS),
                        },
                    },
                    effects: vec![TravelEffect::Persist],
                };
            }
            let postcard_seed = scale_seed(seed, 0, 999_999) as u64;
            TravelTransition {
                snapshot: TravelSnapshot {
                    version: SCHEMA_VERSION,
                    enabled: true,
                    phase: TravelPhase::Away {
                        trip_id: format!("trip-{now}-{postcard_seed}"),
                        departed_at_ms: now,
                        return_at_ms: now + scale_seed(seed, RETURN_MIN_MS, RETURN_MAX_MS),
                        postcard_seed,
                        pet: pet.sanitized(),
                    },
                },
                effects: vec![TravelEffect::Persist, TravelEffect::HidePet],
            }
        }
        TravelPhase::Away {
            trip_id,
            return_at_ms,
            postcard_seed,
            pet,
            ..
        } if now >= return_at_ms => {
            let postcard = create_postcard(&trip_id, postcard_seed, &pet);
            TravelTransition {
                snapshot: TravelSnapshot {
                    version: SCHEMA_VERSION,
                    enabled: true,
                    phase: TravelPhase::ReturnedPendingPostcard {
                        trip_id,
                        postcard,
                        returned_at_ms: now,
                    },
                },
                effects: vec![
                    TravelEffect::Persist,
                    TravelEffect::ShowPet,
                    TravelEffect::PresentPostcard,
                ],
            }
        }
        _ => TravelTransition {
            snapshot,
            effects: Vec::new(),
        },
    }
}

fn store_path() -> Result<PathBuf, String> {
    crate::app_dirs::myagents_data_dir()
        .map(|dir| dir.join(STORE_FILE))
        .ok_or_else(|| "home directory is unavailable".to_string())
}

fn write_snapshot_atomic(path: &Path, snapshot: &TravelSnapshot) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "travel state path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create travel state directory: {error}"))?;
    let bytes = serde_json::to_vec_pretty(snapshot)
        .map_err(|error| format!("serialize travel state: {error}"))?;
    let temp = path.with_extension(format!(
        "json.tmp.{}.{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = fs::File::create(&temp)
            .map_err(|error| format!("create travel state temp: {error}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("write travel state temp: {error}"))?;
        fs::rename(&temp, path).map_err(|error| format!("commit travel state: {error}"))?;
        sync_parent_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> Result<(), String> {
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("sync travel state directory: {error}"))
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> Result<(), String> {
    Ok(())
}

async fn persist_snapshot(snapshot: &TravelSnapshot) -> Result<(), String> {
    let path = store_path()?;
    let lock_path = path.with_file_name(STORE_LOCK);
    let snapshot = snapshot.clone();
    crate::utils::file_lock::with_file_lock(
        &lock_path,
        crate::utils::file_lock::FileLockOptions::default(),
        move || {
            write_snapshot_atomic(&path, &snapshot).map_err(|message| {
                crate::utils::file_lock::FileLockError::Io(std::io::Error::other(message))
            })
        },
    )
    .await
    .map_err(String::from)
}

async fn load_snapshot() -> TravelSnapshot {
    let Ok(path) = store_path() else {
        return TravelSnapshot::disabled();
    };
    let Ok(contents) = tokio::fs::read_to_string(&path).await else {
        return TravelSnapshot::disabled();
    };
    match serde_json::from_str::<TravelSnapshot>(&contents) {
        Ok(snapshot) if snapshot.version == SCHEMA_VERSION => snapshot,
        Ok(_) | Err(_) => {
            let quarantine = path.with_extension(format!("json.corrupt.{}", now_ms()));
            if let Err(error) = tokio::fs::rename(&path, &quarantine).await {
                crate::ulog_warn!("[travel-mate] corrupt store quarantine failed: {error}");
            }
            TravelSnapshot::disabled()
        }
    }
}

/// Synchronous startup guard used before the native floating-ball window is
/// shown. It prevents an away pet from flashing briefly during restart.
pub fn should_suppress_pet_on_startup() -> bool {
    let Ok(path) = store_path() else {
        return false;
    };
    fs::read_to_string(path)
        .ok()
        .is_some_and(|contents| should_suppress_snapshot(&contents))
}

fn should_suppress_snapshot(contents: &str) -> bool {
    serde_json::from_str::<TravelSnapshot>(contents)
        .ok()
        .is_some_and(|snapshot| {
            snapshot.version == SCHEMA_VERSION
                && snapshot.enabled
                && matches!(snapshot.phase, TravelPhase::Away { .. })
        })
}

async fn ensure_loaded() {
    {
        let state = runtime().lock().await;
        if state.loaded {
            return;
        }
    }
    let snapshot = load_snapshot().await;
    let mut state = runtime().lock().await;
    if !state.loaded {
        state.snapshot = snapshot;
        state.loaded = true;
    }
}

async fn emit_snapshot(app: &AppHandle, snapshot: &TravelSnapshot) {
    if let Err(error) = app.emit("travel-mate://state-changed", snapshot) {
        crate::ulog_warn!("[travel-mate] state event failed: {error}");
    }
}

async fn apply_visibility_effect(app: &AppHandle, effect: TravelEffect) -> Result<(), String> {
    match effect {
        TravelEffect::Persist => Ok(()),
        TravelEffect::HidePet => {
            let before = crate::floating_ball::cmd_fb_capabilities(app.clone()).await?;
            if !before.supported || !before.active {
                return Err("desktop pet window is unavailable for travel departure".into());
            }
            crate::floating_ball::cmd_fb_disable(app.clone()).await?;
            let after = crate::floating_ball::cmd_fb_capabilities(app.clone()).await?;
            if after.active {
                return Err("desktop pet window remained visible after travel departure".into());
            }
            Ok(())
        }
        TravelEffect::ShowPet => {
            let config = crate::floating_ball::load_fb_config();
            if !(config.dev_gate && config.enabled) {
                return Err("desktop pet is disabled; travel return will retry later".into());
            }
            crate::floating_ball::cmd_fb_enable(app.clone()).await?;
            let after = crate::floating_ball::cmd_fb_capabilities(app.clone()).await?;
            if !after.supported || !after.active {
                return Err("desktop pet window did not become visible after travel return".into());
            }
            Ok(())
        }
        TravelEffect::PresentPostcard => {
            crate::floating_ball::cmd_fb_show_companion(app.clone(), "pin".into()).await
        }
    }
}

fn hide_failure_retry(now: i64, seed: u64) -> TravelSnapshot {
    TravelSnapshot {
        version: SCHEMA_VERSION,
        enabled: true,
        phase: TravelPhase::HomeScheduled {
            departure_at_ms: now + scale_seed(seed, RETRY_MIN_MS, RETRY_MAX_MS),
        },
    }
}

async fn compensate_hide_failure(app: &AppHandle, original_error: String) -> Result<(), String> {
    let retry = hide_failure_retry(now_ms(), random_seed());
    persist_snapshot(&retry).await.map_err(|rollback_error| {
        format!("{original_error}; failed to persist departure rollback: {rollback_error}")
    })?;
    {
        let mut state = runtime().lock().await;
        state.snapshot = retry.clone();
        state.hidden_trip = None;
    }
    emit_snapshot(app, &retry).await;
    Err(original_error)
}

async fn commit_transition(
    app: &AppHandle,
    transition: TravelTransition,
) -> Result<TravelSnapshot, String> {
    if transition.effects.is_empty() {
        return Ok(transition.snapshot);
    }
    if transition.effects.first() != Some(&TravelEffect::Persist) {
        return Err("travel transition violated persist-before-visibility invariant".into());
    }
    persist_snapshot(&transition.snapshot).await?;
    {
        let mut state = runtime().lock().await;
        state.snapshot = transition.snapshot.clone();
    }
    emit_snapshot(app, &transition.snapshot).await;
    for effect in transition.effects.iter().copied().skip(1) {
        if let Err(error) = apply_visibility_effect(app, effect).await {
            crate::ulog_warn!("[travel-mate] visibility effect {effect:?} failed: {error}");
            if effect == TravelEffect::HidePet {
                compensate_hide_failure(app, error.clone()).await?;
            }
            return Err(error);
        }
    }
    {
        let mut state = runtime().lock().await;
        state.hidden_trip = match &transition.snapshot.phase {
            TravelPhase::Away { trip_id, .. } => Some(trip_id.clone()),
            _ => None,
        };
    }
    if matches!(
        transition.snapshot.phase,
        TravelPhase::ReturnedPendingPostcard { .. }
    ) {
        let mut state = runtime().lock().await;
        if let TravelPhase::ReturnedPendingPostcard { ref trip_id, .. } = transition.snapshot.phase
        {
            state.presented_trip = Some(trip_id.clone());
        }
    }
    Ok(transition.snapshot)
}

async fn reconcile_inner(app: &AppHandle) -> Result<TravelSnapshot, String> {
    ensure_loaded().await;
    let (snapshot, attention_ready, can_depart, pet) = {
        let state = runtime().lock().await;
        (
            state.snapshot.clone(),
            state.attention_ready,
            state.attention.can_depart(),
            state.current_pet.clone(),
        )
    };
    let departure_due = matches!(
        snapshot.phase,
        TravelPhase::HomeScheduled { departure_at_ms } if now_ms() >= departure_at_ms
    );
    if departure_due {
        let config = crate::floating_ball::load_fb_config();
        let capabilities = crate::floating_ball::cmd_fb_capabilities(app.clone()).await?;
        if !attention_ready
            || !(config.dev_gate && config.enabled)
            || !capabilities.supported
            || !capabilities.active
        {
            return Ok(snapshot);
        }
    }
    let transition = tick(snapshot.clone(), now_ms(), can_depart, random_seed(), pet);
    if !transition.effects.is_empty() {
        return commit_transition(app, transition).await;
    }

    match &snapshot.phase {
        TravelPhase::Away { trip_id, .. } => {
            let should_hide = {
                let state = runtime().lock().await;
                state.hidden_trip.as_deref() != Some(trip_id)
            };
            if should_hide {
                if let Err(error) = apply_visibility_effect(app, TravelEffect::HidePet).await {
                    compensate_hide_failure(app, error).await?;
                }
                runtime().lock().await.hidden_trip = Some(trip_id.clone());
            }
        }
        TravelPhase::ReturnedPendingPostcard { trip_id, .. } => {
            let should_present = {
                let state = runtime().lock().await;
                state.presented_trip.as_deref() != Some(trip_id)
            };
            if should_present {
                apply_visibility_effect(app, TravelEffect::ShowPet).await?;
                emit_snapshot(app, &snapshot).await;
                apply_visibility_effect(app, TravelEffect::PresentPostcard).await?;
                runtime().lock().await.presented_trip = Some(trip_id.clone());
            }
        }
        _ => {}
    }
    Ok(snapshot)
}

async fn reconcile(app: &AppHandle) -> Result<TravelSnapshot, String> {
    let _operation = operation_gate().lock().await;
    reconcile_inner(app).await
}

#[tauri::command]
pub async fn cmd_travel_mate_snapshot() -> Result<TravelSnapshot, String> {
    let _operation = operation_gate().lock().await;
    ensure_loaded().await;
    Ok(runtime().lock().await.snapshot.clone())
}

#[tauri::command]
pub async fn cmd_travel_mate_set_enabled(
    app: AppHandle,
    enabled: bool,
    pet: Option<PetIdentity>,
) -> Result<TravelSnapshot, String> {
    let _operation = operation_gate().lock().await;
    ensure_loaded().await;
    let snapshot = runtime().lock().await.snapshot.clone();
    if enabled {
        let config = crate::floating_ball::load_fb_config();
        if !(config.dev_gate && config.enabled) {
            return Err("enable the desktop pet before turning on travel mode".into());
        }
        let pet = pet
            .ok_or_else(|| "pet identity is required when enabling travel mode".to_string())?
            .sanitized();
        let next = enable_travel(snapshot.clone(), now_ms(), random_seed());
        {
            runtime().lock().await.current_pet = pet;
        }
        if next == snapshot {
            return Ok(next);
        }
        commit_transition(
            &app,
            TravelTransition {
                snapshot: next,
                effects: vec![TravelEffect::Persist],
            },
        )
        .await
    } else {
        commit_transition(&app, disable_travel(snapshot)).await
    }
}

#[tauri::command]
pub async fn cmd_travel_mate_update_attention(
    app: AppHandle,
    attention: TravelAttention,
    pet: PetIdentity,
) -> Result<TravelSnapshot, String> {
    let _operation = operation_gate().lock().await;
    ensure_loaded().await;
    {
        let mut state = runtime().lock().await;
        state.attention = attention;
        state.attention_ready = true;
        state.current_pet = pet.sanitized();
    }
    reconcile_inner(&app).await
}

#[tauri::command]
pub async fn cmd_travel_mate_dismiss_postcard(app: AppHandle) -> Result<TravelSnapshot, String> {
    let _operation = operation_gate().lock().await;
    ensure_loaded().await;
    let snapshot = runtime().lock().await.snapshot.clone();
    if !matches!(snapshot.phase, TravelPhase::ReturnedPendingPostcard { .. }) {
        return Ok(snapshot);
    }
    let next = TravelSnapshot {
        version: SCHEMA_VERSION,
        enabled: true,
        phase: TravelPhase::HomeScheduled {
            departure_at_ms: now_ms()
                + scale_seed(random_seed(), DEPARTURE_MIN_MS, DEPARTURE_MAX_MS),
        },
    };
    runtime().lock().await.presented_trip = None;
    commit_transition(
        &app,
        TravelTransition {
            snapshot: next,
            effects: vec![TravelEffect::Persist],
        },
    )
    .await
}

fn require_debug_demo() -> Result<(), String> {
    if cfg!(debug_assertions) {
        Ok(())
    } else {
        Err("travel demo controls are available in debug builds only".into())
    }
}

#[tauri::command]
pub async fn cmd_travel_mate_demo_depart(app: AppHandle) -> Result<TravelSnapshot, String> {
    require_debug_demo()?;
    let _operation = operation_gate().lock().await;
    ensure_loaded().await;
    let (snapshot, pet) = {
        let state = runtime().lock().await;
        (state.snapshot.clone(), state.current_pet.clone())
    };
    if !snapshot.enabled {
        return Err("travel mode is disabled".into());
    }
    let forced = TravelSnapshot {
        phase: TravelPhase::HomeScheduled {
            departure_at_ms: now_ms(),
        },
        ..snapshot
    };
    commit_transition(&app, tick(forced, now_ms(), true, random_seed(), pet)).await
}

#[tauri::command]
pub async fn cmd_travel_mate_demo_return(app: AppHandle) -> Result<TravelSnapshot, String> {
    require_debug_demo()?;
    let _operation = operation_gate().lock().await;
    ensure_loaded().await;
    let snapshot = runtime().lock().await.snapshot.clone();
    let TravelPhase::Away {
        trip_id,
        departed_at_ms,
        postcard_seed,
        pet,
        ..
    } = snapshot.phase
    else {
        return Err("the pet is not currently away".into());
    };
    let forced = TravelSnapshot {
        version: SCHEMA_VERSION,
        enabled: true,
        phase: TravelPhase::Away {
            trip_id,
            departed_at_ms,
            return_at_ms: now_ms(),
            postcard_seed,
            pet: pet.clone(),
        },
    };
    commit_transition(&app, tick(forced, now_ms(), true, postcard_seed, pet)).await
}

pub fn setup_on_startup(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(error) = reconcile(&app).await {
                crate::ulog_warn!("[travel-mate] reconcile failed: {error}");
            }
            tokio::time::sleep(std::time::Duration::from_secs(TICK_INTERVAL_SECS)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pet() -> PetIdentity {
        PetIdentity {
            id: "mino".into(),
            display_name: "Mino".into(),
            species: PetSpecies::Cat,
        }
    }

    #[test]
    fn enabling_schedules_a_departure_between_four_and_eighteen_hours() {
        let now = 1_000;
        let earliest = enable_travel(TravelSnapshot::disabled(), now, 0);
        let latest = enable_travel(TravelSnapshot::disabled(), now, u64::MAX);

        assert_eq!(earliest.departure_at_ms(), Some(now + DEPARTURE_MIN_MS));
        assert_eq!(latest.departure_at_ms(), Some(now + DEPARTURE_MAX_MS));
    }

    #[test]
    fn due_departure_waits_when_the_pet_needs_attention() {
        let snapshot = TravelSnapshot::scheduled(1_000);
        let result = tick(snapshot, 1_000, false, 0, pet());

        assert!(matches!(
            result.snapshot.phase,
            TravelPhase::HomeScheduled { .. }
        ));
        assert_eq!(result.effects, vec![TravelEffect::Persist]);
        let retry = result.snapshot.departure_at_ms().unwrap();
        assert!((1_000 + RETRY_MIN_MS..=1_000 + RETRY_MAX_MS).contains(&retry));
    }

    #[test]
    fn due_departure_persists_before_hiding_and_returns_once() {
        let departed = tick(TravelSnapshot::scheduled(1_000), 1_000, true, 0, pet());
        assert_eq!(
            departed.effects,
            vec![TravelEffect::Persist, TravelEffect::HidePet]
        );

        let return_at = departed.snapshot.return_at_ms().unwrap();
        let returned = tick(departed.snapshot, return_at, true, 0, pet());
        assert_eq!(
            returned.effects,
            vec![
                TravelEffect::Persist,
                TravelEffect::ShowPet,
                TravelEffect::PresentPostcard,
            ]
        );
        assert!(matches!(
            returned.snapshot.phase,
            TravelPhase::ReturnedPendingPostcard { .. }
        ));

        let duplicate = tick(returned.snapshot.clone(), return_at + 1, true, 0, pet());
        assert!(duplicate.effects.is_empty());
        assert_eq!(duplicate.snapshot, returned.snapshot);
    }

    #[test]
    fn disabling_an_away_trip_recalls_without_creating_a_postcard() {
        let away = tick(TravelSnapshot::scheduled(1_000), 1_000, true, 42, pet()).snapshot;
        let disabled = disable_travel(away);

        assert_eq!(
            disabled.effects,
            vec![TravelEffect::Persist, TravelEffect::ShowPet]
        );
        assert_eq!(disabled.snapshot, TravelSnapshot::disabled());
    }

    #[test]
    fn reference_vector_matches_travel_mate_protocol() {
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/travel-mate-v1.json")).unwrap();
        for case in vector["departureCases"].as_array().unwrap() {
            let now = case["now"].as_i64().unwrap();
            let seed = if case["randomValues"][0].as_f64().unwrap() == 1.0 {
                u64::MAX
            } else {
                0
            };
            let departed = tick(TravelSnapshot::scheduled(now), now, true, seed, pet());
            let TravelPhase::Away {
                trip_id,
                postcard_seed,
                return_at_ms,
                ..
            } = departed.snapshot.phase
            else {
                panic!("expected away state");
            };

            assert_eq!(trip_id, case["expectedTripId"].as_str().unwrap());
            assert_eq!(
                postcard_seed,
                case["expectedPostcardSeed"].as_u64().unwrap()
            );
            assert_eq!(return_at_ms, case["expectedReturnAtMs"].as_i64().unwrap());
        }
    }

    #[test]
    fn persisted_snapshot_contains_only_allowlisted_pet_metadata() {
        let departed = tick(
            TravelSnapshot::scheduled(1_000),
            1_000,
            true,
            0,
            PetIdentity {
                id: "  pet-1  ".into(),
                display_name: "  Mino  ".into(),
                species: PetSpecies::Cat,
            },
        );
        let json = serde_json::to_value(departed.snapshot).unwrap();

        assert_eq!(json["phase"]["pet"]["id"], "pet-1");
        assert_eq!(json["phase"]["pet"]["displayName"], "Mino");
        assert!(!json.to_string().contains("workspace"));
        assert!(!json.to_string().contains("prompt"));
    }

    #[test]
    fn command_metadata_rejects_unknown_fields() {
        let pet = r#"{"id":"mino","displayName":"Mino","species":"cat","workspace":"/tmp"}"#;
        let attention = r#"{"hasPendingInteraction":false,"isBlocked":false,"hasError":false,"prompt":"secret"}"#;

        assert!(serde_json::from_str::<PetIdentity>(pet).is_err());
        assert!(serde_json::from_str::<TravelAttention>(attention).is_err());
    }

    #[test]
    fn startup_suppression_accepts_only_the_current_away_schema() {
        let away = tick(TravelSnapshot::scheduled(1_000), 1_000, true, 42, pet()).snapshot;
        let current = serde_json::to_string(&away).unwrap();
        assert!(should_suppress_snapshot(&current));

        let mut future = serde_json::to_value(away).unwrap();
        future["version"] = serde_json::json!(SCHEMA_VERSION + 1);
        assert!(!should_suppress_snapshot(&future.to_string()));
        assert!(!should_suppress_snapshot("{not json"));
    }

    #[test]
    fn failed_hide_rolls_back_to_a_short_retry_schedule() {
        let now = 8_000;
        let earliest = hide_failure_retry(now, 0);
        let latest = hide_failure_retry(now, u64::MAX);

        assert_eq!(earliest.departure_at_ms(), Some(now + RETRY_MIN_MS));
        assert_eq!(latest.departure_at_ms(), Some(now + RETRY_MAX_MS));
    }

    #[test]
    fn atomic_store_replaces_and_syncs_a_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(STORE_FILE);
        let expected = TravelSnapshot::scheduled(42);

        write_snapshot_atomic(&path, &expected).unwrap();

        let actual: TravelSnapshot =
            serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(actual, expected);
    }

    #[test]
    fn failed_atomic_rename_removes_its_temporary_file() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("occupied");
        fs::create_dir(&target).unwrap();

        assert!(write_snapshot_atomic(&target, &TravelSnapshot::scheduled(42)).is_err());
        let leftovers = fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("occupied.json.tmp")
            })
            .count();
        assert_eq!(leftovers, 0);
    }

    #[tokio::test]
    async fn operation_gate_serializes_mutations() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let first = operation_gate().lock().await;
        let entered = Arc::new(AtomicBool::new(false));
        let entered_in_task = entered.clone();
        let second = tokio::spawn(async move {
            let _guard = operation_gate().lock().await;
            entered_in_task.store(true, Ordering::SeqCst);
        });

        tokio::task::yield_now().await;
        assert!(!entered.load(Ordering::SeqCst));
        drop(first);
        second.await.unwrap();
        assert!(entered.load(Ordering::SeqCst));
    }
}
