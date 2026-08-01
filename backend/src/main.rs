use axum::{
    extract::{DefaultBodyLimit, State},
    http::header,
    middleware::{self, Next},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::RwLock;

mod card_loader;
mod llm;
mod lorebook;
mod pipeline;
mod st_api_scanner;

#[derive(Clone)]
struct AppState {
    game_state: Arc<RwLock<serde_json::Value>>,
    card_store: Arc<RwLock<CardStore>>,
    /// Mock by default; OpenAI-compatible when CONCLAVE_LLM_* env is set (PR-13).
    llm: llm::LlmProvider,
}

struct CardStore {
    cards: Vec<ImportedCard>,
    current_id: usize,
    next_id: usize,
    /// Bumped on import/select so FE can invalidate display caches.
    session_epoch: u64,
}

struct ImportedCard {
    id: usize,
    card: card_loader::CardData,
    source_file: Option<PathBuf>,
}

impl CardStore {
    fn new(
        card: card_loader::CardData,
        persisted_cards: Vec<(card_loader::CardData, PathBuf)>,
    ) -> Self {
        let mut cards = vec![ImportedCard {
            id: 0,
            card,
            source_file: None,
        }];

        cards.extend(persisted_cards.into_iter().enumerate().map(
            |(index, (card, source_file))| ImportedCard {
                id: index + 1,
                card,
                source_file: Some(source_file),
            },
        ));

        Self {
            next_id: cards.len(),
            cards,
            current_id: 0,
            session_epoch: 1,
        }
    }

    fn current_card(&self) -> &card_loader::CardData {
        self.cards
            .iter()
            .find(|imported| imported.id == self.current_id)
            .or_else(|| self.cards.first())
            .map(|imported| &imported.card)
            .expect("card store must contain at least one card")
    }

    fn bump_session_epoch(&mut self) {
        self.session_epoch = self.session_epoch.saturating_add(1);
    }

    fn import_card(&mut self, card: card_loader::CardData, source_file: Option<PathBuf>) -> usize {
        let id = self.next_id;
        self.next_id += 1;
        self.cards.push(ImportedCard {
            id,
            card,
            source_file,
        });
        self.current_id = id;
        self.bump_session_epoch();
        id
    }

    fn select_card(&mut self, id: usize) -> Option<&card_loader::CardData> {
        if self.cards.iter().any(|imported| imported.id == id) {
            self.current_id = id;
            self.bump_session_epoch();
            Some(self.current_card())
        } else {
            None
        }
    }
}

/// Prompt injection item (PR-07 accept; full Mind apply in PR-11).
#[derive(Debug, Clone, Deserialize, Serialize)]
struct InjectionItem {
    #[serde(default)]
    key: Option<String>,
    content: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    position: Option<String>,
    #[serde(default)]
    depth: Option<f64>,
    #[serde(default)]
    ephemeral: Option<bool>,
    #[serde(default)]
    source: Option<String>,
}

/// POST /api/chat body (architecture ChatRequest).
#[derive(Deserialize)]
struct ChatRequest {
    user_message: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    client_mvu: Option<serde_json::Value>,
    #[serde(default)]
    injections: Option<Vec<InjectionItem>>,
}

#[derive(Deserialize)]
struct ImportCardRequest {
    card_json: serde_json::Value,
}

#[derive(Deserialize)]
struct SelectCardRequest {
    import_id: usize,
}

#[derive(Serialize)]
struct PromptDebug {
    base_prompt: String,
    final_prompt: String,
    injections: Vec<InjectionItem>,
}

/// POST /api/chat response (architecture ChatResponse).
#[derive(Serialize)]
struct ChatResponse {
    raw_text: String,
    rendered_html: String,
    new_state: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt_debug: Option<PromptDebug>,
}

#[derive(Serialize)]
struct WorldbookEntryResponse {
    index: usize,
    id: Option<i64>,
    comment: String,
    keys: Vec<String>,
    secondary_keys: Vec<String>,
    enabled: bool,
    constant: bool,
    selective: bool,
    insertion_order: i64,
    content: String,
    rendered_html: String,
}

#[derive(Serialize)]
struct TavernHelperScriptSummary {
    index: usize,
    name: String,
    script_type: String,
    info: String,
    imports: Vec<String>,
    content: String,
}

#[derive(Serialize)]
struct ImportedWorldbookResponse {
    id: usize,
    name: String,
    entry_count: usize,
    is_current: bool,
    source_file: Option<String>,
}

#[derive(Serialize)]
struct InitResponse {
    first_message: String,
    /// Deprecated display hint: prefer FE RenderPipeline (`processDisplay`) when enabled.
    rendered_html: String,
    greetings: Vec<String>,
    /// Deprecated display hint: prefer FE RenderPipeline for each greeting swipe.
    rendered_greetings: Vec<String>,
    worldbook_entries: Vec<WorldbookEntryResponse>,
    tavern_helper_scripts: Vec<TavernHelperScriptSummary>,
    /// Character-card regex scripts for FE display pipeline (camelCase field names).
    regex_scripts: Vec<card_loader::RegexScript>,
    imported_worldbooks: Vec<ImportedWorldbookResponse>,
    current_worldbook_id: usize,
    card_name: String,
    /// Monotonic epoch: increments on import/select so FE can reset display caches.
    session_epoch: u64,
    runtime_requirements: st_api_scanner::StRuntimeRequirements,
}

#[derive(Serialize)]
struct GreetingsResponse {
    greetings: Vec<String>,
    rendered_greetings: Vec<String>,
}

/// CORS 中间件
async fn cors_middleware(req: axum::extract::Request, next: Next) -> impl IntoResponse {
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        "GET, POST, OPTIONS".parse().unwrap(),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        "Content-Type".parse().unwrap(),
    );
    response
}

/// GET /api/init — 返回开场渲染
async fn init_handler(State(state): State<AppState>) -> Json<InitResponse> {
    let store = state.card_store.read().await;
    Json(build_init_response(&store))
}

/// POST /api/import-card — 导入 SillyTavern JSON 卡并切换当前运行卡片
async fn import_card_handler(
    State(state): State<AppState>,
    Json(req): Json<ImportCardRequest>,
) -> Result<Json<InitResponse>, (axum::http::StatusCode, String)> {
    let raw_card_json = req.card_json;
    let card = card_loader::CardData::from_value(raw_card_json.clone()).map_err(|error| {
        (
            axum::http::StatusCode::BAD_REQUEST,
            format!("无法解析角色卡 JSON: {error}"),
        )
    })?;
    let source_file = persist_imported_card(&card, &raw_card_json).map_err(|error| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("角色卡 JSON 保存失败: {error}"),
        )
    })?;

    {
        let mut store = state.card_store.write().await;
        store.import_card(card.clone(), Some(source_file));
    }
    {
        let mut game_state = state.game_state.write().await;
        *game_state = initial_game_state(&card);
    }

    let store = state.card_store.read().await;
    Ok(Json(build_init_response(&store)))
}

/// POST /api/select-card — 切换到已导入的角色卡/世界书包
async fn select_card_handler(
    State(state): State<AppState>,
    Json(req): Json<SelectCardRequest>,
) -> Result<Json<InitResponse>, (axum::http::StatusCode, String)> {
    let selected_card = {
        let mut store = state.card_store.write().await;
        store.select_card(req.import_id).cloned().ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("未找到导入项: {}", req.import_id),
            )
        })?
    };

    {
        let mut game_state = state.game_state.write().await;
        *game_state = initial_game_state(&selected_card);
    }

    let store = state.card_store.read().await;
    Ok(Json(build_init_response(&store)))
}

/// GET /api/greetings — 返回所有 alternate_greetings
async fn greetings_handler(State(state): State<AppState>) -> Json<GreetingsResponse> {
    let card = {
        let store = state.card_store.read().await;
        store.current_card().clone()
    };
    let scripts = card.regex_scripts();
    let greetings = card.data.alternate_greetings.clone();
    let rendered_greetings = greetings
        .iter()
        .map(|greeting| render_card_message(&card, greeting, &scripts))
        .collect();

    Json(GreetingsResponse {
        greetings,
        rendered_greetings,
    })
}

/// GET /api/runtime-requirements — 返回当前角色卡需要的 ST 兼容层能力
async fn runtime_requirements_handler(
    State(state): State<AppState>,
) -> Json<st_api_scanner::StRuntimeRequirements> {
    let card = {
        let store = state.card_store.read().await;
        store.current_card().clone()
    };
    Json(st_api_scanner::scan_card(&card))
}

/// POST /api/chat — 接收用户消息，经 LLM provider（默认 mock）生成响应并渲染
async fn chat_handler(
    State(state): State<AppState>,
    Json(req): Json<ChatRequest>,
) -> Result<Json<ChatResponse>, (axum::http::StatusCode, String)> {
    let mut game_state = state.game_state.write().await;
    let card = {
        let store = state.card_store.read().await;
        store.current_card().clone()
    };

    // PR-07: client_mvu is the FE Session base; fall back to server projection when absent.
    apply_client_mvu_base(&mut game_state, req.client_mvu);
    // session_id accepted for future multi-session routing (unused in single-session MVP).
    let _session_id = req.session_id.as_deref();
    let _ = _session_id;

    let injections = req.injections.unwrap_or_default();

    // 1. 组装 Prompt（通用 WI 摘要 + state dump）
    let base_prompt = lorebook::compile_prompt(
        &serde_json::to_value(&card).unwrap_or_default(),
        &game_state,
        None,
    );

    // PR-11: apply injections[] with position/depth semantics → final_prompt.
    // Mock LLM may still echo user_message; prompt_debug proves the injection path.
    let final_prompt = apply_prompt_injections(&base_prompt, &injections);

    // 2. LLM provider (mock default; real when CONCLAVE_LLM_* set — PR-13).
    // Mock echoes `user_message`; real provider uses final_prompt as system content.
    let llm_raw_response = state
        .llm
        .complete(&final_prompt, &req.user_message)
        .await
        .map_err(|error| {
            (
                axum::http::StatusCode::BAD_GATEWAY,
                format!("LLM provider error ({}): {error}", state.llm.name()),
            )
        })?;

    // 3. 提取并应用 MVU 变量更新 (on client_mvu base)
    pipeline::mvu_patch::apply_mvu_patch(&mut game_state, &llm_raw_response);

    // 4. 执行正则管线 (hint only after FE display authority; still returned for debug/fallback)
    let scripts = card.regex_scripts();
    let rendered_html = render_card_message(&card, &llm_raw_response, &scripts);

    Ok(Json(ChatResponse {
        raw_text: llm_raw_response,
        rendered_html,
        new_state: game_state.clone(),
        prompt_debug: Some(PromptDebug {
            base_prompt,
            final_prompt,
            injections,
        }),
    }))
}

fn build_init_response(store: &CardStore) -> InitResponse {
    let card = store.current_card();
    let scripts = card.regex_scripts();

    // 将 first_mes ("【GameStart】") 通过正则管线渲染为 HTML
    // rendered_* remain as deprecated FE hints when display_regex_fe is disabled.
    let first_mes = &card.data.first_mes;
    let rendered_html = render_card_message(card, first_mes, &scripts);

    let greetings = card.data.alternate_greetings.clone();
    let rendered_greetings = greetings
        .iter()
        .map(|greeting| render_card_message(card, greeting, &scripts))
        .collect();
    let runtime_requirements = st_api_scanner::scan_card(card);

    InitResponse {
        first_message: first_mes.clone(),
        rendered_html,
        greetings,
        rendered_greetings,
        worldbook_entries: worldbook_entries(card),
        tavern_helper_scripts: tavern_helper_script_summaries(card),
        regex_scripts: scripts,
        imported_worldbooks: imported_worldbooks(store),
        current_worldbook_id: store.current_id,
        card_name: card.name.clone(),
        session_epoch: store.session_epoch,
        runtime_requirements,
    }
}

/// Backend display pipeline (deprecated hint for FE). Prefer FE `processDisplay` when enabled.
fn render_card_message(
    card: &card_loader::CardData,
    message: &str,
    scripts: &[card_loader::RegexScript],
) -> String {
    let display_message = append_card_status_placeholder_if_needed(card, message, scripts);
    pipeline::regex_engine::RegexPipeline::process(&display_message, scripts)
}

fn append_card_status_placeholder_if_needed(
    card: &card_loader::CardData,
    message: &str,
    scripts: &[card_loader::RegexScript],
) -> String {
    const STATUS_PLACEHOLDER: &str = "<StatusPlaceHolderImpl/>";

    if message.contains(STATUS_PLACEHOLDER) || !card.tavern_helper_scripts().is_empty() {
        return message.to_string();
    }

    if !message_has_status_variable_payload(message) {
        return message.to_string();
    }

    let has_card_statusbar_regex = scripts.iter().any(|script| {
        !script.disabled
            && script.markdown_only
            && script.find_regex.trim() == STATUS_PLACEHOLDER
            && !script.replace_string.trim().is_empty()
    });

    if has_card_statusbar_regex {
        format!("{message}\n{STATUS_PLACEHOLDER}")
    } else {
        message.to_string()
    }
}

fn message_has_status_variable_payload(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("<initvar") || lower.contains("<updatevariable")
}

fn imported_worldbooks(store: &CardStore) -> Vec<ImportedWorldbookResponse> {
    store
        .cards
        .iter()
        .map(|imported| ImportedWorldbookResponse {
            id: imported.id,
            name: imported.card.name.clone(),
            entry_count: imported.card.all_book_entries().len(),
            is_current: imported.id == store.current_id,
            source_file: imported
                .source_file
                .as_ref()
                .map(|path| path.to_string_lossy().to_string()),
        })
        .collect()
}

fn imported_cards_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("data")
        .join("imported_cards")
}

fn load_persisted_imports() -> Vec<(card_loader::CardData, PathBuf)> {
    let dir = imported_cards_dir();
    let mut paths = match fs::read_dir(&dir) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
            })
            .collect::<Vec<_>>(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            eprintln!("! 无法读取导入卡目录 {}: {error}", dir.display());
            return Vec::new();
        }
    };
    paths.sort();

    paths
        .into_iter()
        .filter_map(|path| {
            match fs::read_to_string(&path)
                .ok()
                .and_then(|content| card_loader::CardData::from_json(&content).ok())
            {
                Some(card) => Some((card, path)),
                None => {
                    eprintln!("! 跳过无法解析的导入卡: {}", path.display());
                    None
                }
            }
        })
        .collect()
}

fn persist_imported_card(
    card: &card_loader::CardData,
    raw_json: &serde_json::Value,
) -> std::io::Result<PathBuf> {
    let dir = imported_cards_dir();
    fs::create_dir_all(&dir)?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let name = sanitize_filename_component(&card.name);
    let path = dir.join(format!("{timestamp}-{name}.json"));
    let json = serde_json::to_string_pretty(raw_json)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    fs::write(&path, format!("{json}\n"))?;
    Ok(path)
}

fn sanitize_filename_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();

    if sanitized.is_empty() {
        "imported-card".to_string()
    } else {
        sanitized.chars().take(80).collect()
    }
}

fn worldbook_entries(card: &card_loader::CardData) -> Vec<WorldbookEntryResponse> {
    card.data
        .character_book
        .as_ref()
        .map(|book| {
            book.entries
                .iter()
                .enumerate()
                .map(|(index, entry)| WorldbookEntryResponse {
                    index,
                    id: entry.id,
                    comment: entry.comment.clone(),
                    keys: entry.keys.clone(),
                    secondary_keys: entry.secondary_keys.clone(),
                    enabled: entry.enabled,
                    constant: entry.constant,
                    selective: entry.selective,
                    insertion_order: entry.insertion_order,
                    content: entry.content.clone(),
                    rendered_html: render_worldbook_entry(entry),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn render_worldbook_entry(entry: &card_loader::BookEntry) -> String {
    format!(
        "<article class=\"st-worldbook-render\"><pre>{}</pre></article>",
        escape_html(&entry.content)
    )
}

fn tavern_helper_script_summaries(card: &card_loader::CardData) -> Vec<TavernHelperScriptSummary> {
    card.tavern_helper_scripts()
        .into_iter()
        .enumerate()
        .map(|(index, script)| TavernHelperScriptSummary {
            index,
            name: script.name,
            script_type: script.script_type,
            info: script.info,
            imports: extract_imports(&script.content),
            content: script.content,
        })
        .collect()
}

fn extract_imports(script: &str) -> Vec<String> {
    let re =
        regex::Regex::new(r#"(?m)^\s*import\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]"#).unwrap();
    re.captures_iter(script)
        .filter_map(|cap| cap.get(1).map(|matched| matched.as_str().to_string()))
        .collect()
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// 中性初始 game_state：不写死任何卡片（如苍玄）的经济/区域字段。
/// 卡片特定 MVU 应由开场 `<initvar>` / 前端解析 / 扩展注入填充。
fn initial_game_state(card: &card_loader::CardData) -> serde_json::Value {
    serde_json::json!({
        "stat_data": {},
        "tavern_vars": card.tavern_variables(),
        "initialized_lorebooks": {},
    })
}

/// Marker used by `compile_prompt` before the game-state dump.
const GAME_STATE_MARKER: &str =
    "--- current game state (for model context; do not dump this JSON in the reply) ---";

/// Apply ChatRequest.injections[] into base_prompt with position/depth semantics (PR-11).
///
/// Positions (order in final prompt):
/// - `before_scenario` — prepended before base
/// - `after_scenario` — inserted just before the game-state dump (or after base if missing)
/// - `in_prompt` — same band as after_scenario, sorted by depth after after_scenario items
/// - `before_user` / unknown — appended after base
///
/// Within a band, lower `depth` comes first (default 0).
fn apply_prompt_injections(base_prompt: &str, injections: &[InjectionItem]) -> String {
    if injections.is_empty() {
        return base_prompt.to_string();
    }

    let mut before_scenario: Vec<&InjectionItem> = Vec::new();
    let mut after_scenario: Vec<&InjectionItem> = Vec::new();
    let mut in_prompt: Vec<&InjectionItem> = Vec::new();
    let mut before_user: Vec<&InjectionItem> = Vec::new();

    for item in injections {
        if item.content.trim().is_empty() {
            continue;
        }
        match item.position.as_deref() {
            Some("before_scenario") => before_scenario.push(item),
            Some("after_scenario") => after_scenario.push(item),
            Some("in_prompt") => in_prompt.push(item),
            _ => before_user.push(item),
        }
    }

    let by_depth = |a: &&InjectionItem, b: &&InjectionItem| {
        let da = a.depth.unwrap_or(0.0);
        let db = b.depth.unwrap_or(0.0);
        da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
    };
    before_scenario.sort_by(by_depth);
    after_scenario.sort_by(by_depth);
    in_prompt.sort_by(by_depth);
    before_user.sort_by(by_depth);

    fn format_block(items: &[&InjectionItem]) -> String {
        let mut out = String::new();
        for item in items {
            let slot = item
                .key
                .as_deref()
                .or(item.position.as_deref())
                .unwrap_or("injection");
            let source = item.source.as_deref().unwrap_or("");
            let header = if source.is_empty() {
                format!("--- prompt injection [{slot}] ---")
            } else {
                format!("--- prompt injection [{slot}|source={source}] ---")
            };
            out.push_str(&header);
            out.push('\n');
            out.push_str(item.content.trim_end());
            out.push_str("\n\n");
        }
        out
    }

    let mid_block = {
        let mut mid = String::new();
        mid.push_str(&format_block(&after_scenario));
        mid.push_str(&format_block(&in_prompt));
        mid
    };
    let pre_block = format_block(&before_scenario);
    let post_block = format_block(&before_user);

    let mut final_prompt = String::new();
    if !pre_block.is_empty() {
        final_prompt.push_str(&pre_block);
    }

    if mid_block.is_empty() {
        final_prompt.push_str(base_prompt);
    } else if let Some(idx) = base_prompt.find(GAME_STATE_MARKER) {
        final_prompt.push_str(&base_prompt[..idx]);
        final_prompt.push_str(&mid_block);
        final_prompt.push_str(&base_prompt[idx..]);
    } else {
        final_prompt.push_str(base_prompt);
        if !final_prompt.ends_with('\n') {
            final_prompt.push('\n');
        }
        final_prompt.push('\n');
        final_prompt.push_str(&mid_block);
    }

    if !post_block.is_empty() {
        if !final_prompt.ends_with('\n') {
            final_prompt.push('\n');
        }
        final_prompt.push('\n');
        final_prompt.push_str(&post_block);
    }

    final_prompt
}

/// Apply FE client_mvu as the base for this turn when it is a JSON object.
/// Non-object values are ignored (server projection kept).
fn apply_client_mvu_base(game_state: &mut serde_json::Value, client_mvu: Option<serde_json::Value>) {
    if let Some(client) = client_mvu {
        if client.is_object() {
            *game_state = client;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_client_mvu_base, apply_prompt_injections, build_init_response, chat_handler,
        initial_game_state, message_has_status_variable_payload, render_card_message, AppState,
        CardStore, ChatRequest, InjectionItem, GAME_STATE_MARKER,
    };
    use crate::card_loader::{CardData, CardInner, RegexScript};
    use axum::extract::State;
    use axum::Json;
    use serde_json::json;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    #[test]
    fn status_placeholder_injection_requires_variable_payload() {
        assert!(!message_has_status_variable_payload(
            "本卡游玩需要安装提示词模板，右滑开始。"
        ));
        assert!(message_has_status_variable_payload(
            "<UpdateVariable>_.set('<user>.称号', '旧', '新');</UpdateVariable>"
        ));
        assert!(message_has_status_variable_payload(
            "<initvar>\n主角状态:\n  修为: 无\n</initvar>"
        ));
    }

    #[test]
    fn statusbar_regex_runs_only_for_messages_with_variable_payload() {
        let card = CardData {
            name: "status card".to_string(),
            description: String::new(),
            personality: String::new(),
            scenario: String::new(),
            first_mes: String::new(),
            mes_example: String::new(),
            creatorcomment: String::new(),
            tags: Vec::new(),
            data: CardInner {
                name: "status card".to_string(),
                system_prompt: String::new(),
                post_history_instructions: String::new(),
                first_mes: String::new(),
                alternate_greetings: Vec::new(),
                character_book: None,
                extensions: serde_json::json!({}),
            },
        };
        let statusbar_script = RegexScript {
            id: String::new(),
            script_name: "statusbar".to_string(),
            run_on_edit: false,
            find_regex: "<StatusPlaceHolderImpl/>".to_string(),
            replace_string: "<div id=\"status-card\">ok</div>".to_string(),
            placement: Vec::new(),
            substitute_regex: 0,
            min_depth: None,
            max_depth: None,
            markdown_only: true,
            prompt_only: false,
            disabled: false,
        };

        let intro = render_card_message(&card, "说明页，请右滑开始。", &[statusbar_script.clone()]);
        let opening = render_card_message(
            &card,
            "<UpdateVariable>_.set('<user>.称号', '旧', '新');</UpdateVariable>",
            &[statusbar_script],
        );

        assert!(!intro.contains("status-card"));
        assert!(opening.contains("status-card"));
    }

    /// 最小非苍玄卡：initial_game_state 不得注入「灵石」等卡片专用键
    fn minimal_neutral_card() -> CardData {
        CardData {
            name: "Neutral Demo".to_string(),
            description: String::new(),
            personality: String::new(),
            scenario: String::new(),
            first_mes: "Welcome to a generic story.".to_string(),
            mes_example: String::new(),
            creatorcomment: String::new(),
            tags: vec!["test".to_string()],
            data: CardInner {
                name: "Neutral Demo".to_string(),
                system_prompt: "You narrate a fantasy adventure.".to_string(),
                post_history_instructions: String::new(),
                first_mes: "Welcome to a generic story.".to_string(),
                alternate_greetings: Vec::new(),
                character_book: None,
                extensions: json!({
                    "tavern_helper": {
                        "variables": {
                            "mood": "calm"
                        }
                    }
                }),
            },
        }
    }

    #[test]
    fn initial_game_state_is_neutral_without_spirit_stone_keys() {
        let card = minimal_neutral_card();
        let state = initial_game_state(&card);

        assert!(state["stat_data"].is_object());
        assert_eq!(state["stat_data"], json!({}));
        assert_eq!(state["tavern_vars"]["mood"], "calm");
        assert_eq!(state["initialized_lorebooks"], json!({}));

        let serialized = serde_json::to_string(&state).unwrap();
        assert!(
            !serialized.contains("灵石"),
            "neutral initial state must not hardcode 灵石: {serialized}"
        );
        assert!(
            !serialized.contains("世界系统"),
            "neutral initial state must not hardcode 世界系统: {serialized}"
        );
        assert!(
            !serialized.contains("大区域"),
            "neutral initial state must not hardcode 大区域: {serialized}"
        );
        assert!(
            !serialized.contains("主角状态"),
            "neutral initial state must not hardcode 主角状态: {serialized}"
        );
    }

    #[test]
    fn initial_game_state_for_cangxuan_fixture_also_has_empty_stat_data() {
        // 即使加载苍玄卡，后端初始 state 也不再预填苍玄经济/区域；
        // 那些字段应来自消息 initvar，而非内核默认。
        let card = CardData::from_json(include_str!("../data/cangxuan_v1.0.20.json"))
            .expect("cangxuan fixture parses");
        let state = initial_game_state(&card);

        assert_eq!(state["stat_data"], json!({}));
        let serialized = serde_json::to_string(&state["stat_data"]).unwrap();
        assert!(!serialized.contains("灵石"));
        assert!(!serialized.contains("大区域"));
    }

    #[test]
    fn build_init_response_includes_regex_scripts_and_session_epoch() {
        let card = CardData::from_json(include_str!("../data/cangxuan_v1.0.20.json"))
            .expect("cangxuan fixture parses");
        let store = CardStore::new(card, vec![]);
        let response = build_init_response(&store);

        assert_eq!(response.session_epoch, 1);
        assert!(
            !response.regex_scripts.is_empty(),
            "cangxuan should ship non-empty regex_scripts"
        );

        let value = serde_json::to_value(&response).expect("InitResponse serializes");
        assert_eq!(value["session_epoch"], 1);
        let scripts = value["regex_scripts"]
            .as_array()
            .expect("regex_scripts array");
        assert!(!scripts.is_empty());
        // RegexScript fields use camelCase JSON names (scriptName, findRegex, …).
        let first = &scripts[0];
        assert!(
            first.get("scriptName").is_some() || first.get("findRegex").is_some(),
            "expected camelCase regex script fields, got {first}"
        );
    }

    #[test]
    fn session_epoch_increments_on_import_and_select() {
        let mut store = CardStore::new(minimal_neutral_card(), vec![]);
        assert_eq!(store.session_epoch, 1);

        store.import_card(minimal_neutral_card(), None);
        assert_eq!(store.session_epoch, 2);
        assert_eq!(store.current_id, 1);

        store
            .select_card(0)
            .expect("default card remains selectable");
        assert_eq!(store.session_epoch, 3);
        assert_eq!(store.current_id, 0);

        // Failed select must not bump epoch.
        assert!(store.select_card(999).is_none());
        assert_eq!(store.session_epoch, 3);
    }

    #[test]
    fn client_mvu_object_replaces_server_game_state_base() {
        let mut state = json!({"stat_data": {"from": "server"}, "keep": false});
        apply_client_mvu_base(
            &mut state,
            Some(json!({"stat_data": {"from": "client", "hp": 9}})),
        );
        assert_eq!(state["stat_data"]["from"], "client");
        assert_eq!(state["stat_data"]["hp"], 9);
        assert!(state.get("keep").is_none());
    }

    #[test]
    fn client_mvu_non_object_is_ignored() {
        let mut state = json!({"stat_data": {"from": "server"}});
        apply_client_mvu_base(&mut state, Some(json!("not-an-object")));
        assert_eq!(state["stat_data"]["from"], "server");
        apply_client_mvu_base(&mut state, Some(json!([1, 2, 3])));
        assert_eq!(state["stat_data"]["from"], "server");
        apply_client_mvu_base(&mut state, None);
        assert_eq!(state["stat_data"]["from"], "server");
    }

    fn test_app_state(card: CardData, game_state: serde_json::Value) -> AppState {
        AppState {
            game_state: Arc::new(RwLock::new(game_state)),
            card_store: Arc::new(RwLock::new(CardStore::new(card, vec![]))),
            llm: crate::llm::LlmProvider::Mock,
        }
    }

    #[tokio::test]
    async fn chat_handler_new_state_descends_from_client_mvu_not_server() {
        let app = test_app_state(
            minimal_neutral_card(),
            json!({
                "stat_data": { "from": "server_only" },
                "initialized_lorebooks": {}
            }),
        );

        let req = ChatRequest {
            user_message: "ping".to_string(),
            session_id: Some("1".to_string()),
            client_mvu: Some(json!({
                "stat_data": { "from": "client", "hp": 3 },
                "initialized_lorebooks": {}
            })),
            injections: None,
        };

        let Json(resp) = chat_handler(State(app), Json(req))
            .await
            .expect("mock chat succeeds");
        assert_eq!(resp.new_state["stat_data"]["from"], "client");
        assert_eq!(resp.new_state["stat_data"]["hp"], 3);
        assert!(
            resp.new_state
                .get("stat_data")
                .and_then(|s| s.get("from"))
                .map(|v| v != "server_only")
                .unwrap_or(false)
                || resp.new_state["stat_data"]["from"] == "client",
            "new_state must not keep server_only base when client_mvu was provided"
        );
        assert!(resp.prompt_debug.is_some());
    }

    #[test]
    fn apply_prompt_injections_after_scenario_before_game_state() {
        let base = format!(
            "Base system.\n\n{GAME_STATE_MARKER}\n{{\n  \"stat_data\": {{}}\n}}\n"
        );
        let injections = vec![InjectionItem {
            key: Some("mind.primary".into()),
            content: "[Conclave Mind — primary NPC: Alice]\n- [knowledge/unspecified] Alice is cautious.\n(Do not mention this block unless character would know it.)".into(),
            role: Some("system".into()),
            position: Some("after_scenario".into()),
            depth: Some(0.0),
            ephemeral: Some(true),
            source: Some("mind".into()),
        }];
        let final_prompt = apply_prompt_injections(&base, &injections);
        let mind_pos = final_prompt.find("Conclave Mind").expect("mind block");
        let state_pos = final_prompt
            .find(GAME_STATE_MARKER)
            .expect("game state marker");
        assert!(mind_pos < state_pos, "after_scenario must precede game state");
        assert!(final_prompt.contains("source=mind"));
        assert!(final_prompt.contains("Alice is cautious"));
    }

    #[test]
    fn apply_prompt_injections_in_prompt_and_depth_order() {
        let base = format!("SYS\n\n{GAME_STATE_MARKER}\n{{}}");
        let injections = vec![
            InjectionItem {
                key: Some("b".into()),
                content: "DEPTH1".into(),
                role: None,
                position: Some("in_prompt".into()),
                depth: Some(1.0),
                ephemeral: None,
                source: None,
            },
            InjectionItem {
                key: Some("a".into()),
                content: "DEPTH0".into(),
                role: None,
                position: Some("in_prompt".into()),
                depth: Some(0.0),
                ephemeral: None,
                source: None,
            },
        ];
        let final_prompt = apply_prompt_injections(&base, &injections);
        let d0 = final_prompt.find("DEPTH0").unwrap();
        let d1 = final_prompt.find("DEPTH1").unwrap();
        assert!(d0 < d1);
        assert!(d1 < final_prompt.find(GAME_STATE_MARKER).unwrap());
    }

    #[tokio::test]
    async fn chat_handler_prompt_debug_includes_mind_injection_content() {
        let app = test_app_state(
            minimal_neutral_card(),
            json!({
                "stat_data": {},
                "initialized_lorebooks": {}
            }),
        );

        let mind_block = "[Conclave Mind — primary NPC: Demo]\n- [knowledge/unspecified] User likes tea.\n(Do not mention this block unless character would know it.)";
        let req = ChatRequest {
            user_message: "hello".to_string(),
            session_id: Some("1".to_string()),
            client_mvu: Some(json!({ "stat_data": {} })),
            injections: Some(vec![InjectionItem {
                key: Some("mind.primary".into()),
                content: mind_block.into(),
                role: Some("system".into()),
                position: Some("after_scenario".into()),
                depth: Some(0.0),
                ephemeral: Some(true),
                source: Some("mind".into()),
            }]),
        };

        let Json(resp) = chat_handler(State(app), Json(req))
            .await
            .expect("mock chat succeeds");
        let debug = resp.prompt_debug.expect("prompt_debug required");
        assert!(
            debug.final_prompt.contains("Conclave Mind — primary NPC: Demo"),
            "final_prompt must include Mind block"
        );
        assert!(debug.final_prompt.contains("User likes tea."));
        assert_eq!(debug.injections.len(), 1);
        assert_eq!(debug.injections[0].source.as_deref(), Some("mind"));
        assert_eq!(debug.injections[0].content, mind_block);
        // mock still echoes user message (injection path proven via prompt_debug only)
        assert!(resp.raw_text.contains("hello"));
    }

    /// G1 regression smoke via handlers: init-shaped response + mock chat path.
    #[tokio::test]
    async fn g1_init_and_mock_chat_smoke() {
        let card = CardData::from_json(include_str!("../data/cangxuan_v1.0.20.json"))
            .expect("cangxuan fixture parses");
        let store = CardStore::new(card.clone(), vec![]);
        let init = build_init_response(&store);
        assert!(!init.first_message.is_empty() || !init.rendered_html.is_empty());
        assert_eq!(init.session_epoch, 1);
        assert!(!init.regex_scripts.is_empty());
        assert_eq!(init.card_name, card.name);

        let app = test_app_state(
            card,
            json!({
                "stat_data": {},
                "initialized_lorebooks": {}
            }),
        );
        let req = ChatRequest {
            user_message: "e2e-smoke-ping".to_string(),
            session_id: Some("smoke".to_string()),
            client_mvu: Some(json!({
                "stat_data": {},
                "initialized_lorebooks": {}
            })),
            injections: None,
        };
        let Json(resp) = chat_handler(State(app), Json(req))
            .await
            .expect("mock chat ok");
        assert!(
            resp.raw_text.contains("e2e-smoke-ping"),
            "mock must echo user message"
        );
        assert!(!resp.rendered_html.is_empty() || !resp.raw_text.is_empty());
        assert!(resp.new_state.is_object());
        let debug = resp.prompt_debug.expect("prompt_debug");
        assert!(!debug.base_prompt.is_empty() || !debug.final_prompt.is_empty());
    }
}

#[tokio::main]
async fn main() {
    // 加载 V3 角色卡
    let card_json_str = include_str!("../data/cangxuan_v1.0.20.json");
    let card: card_loader::CardData =
        card_loader::CardData::from_json(card_json_str).expect("Failed to parse character card");

    eprintln!(
        "✓ 已加载角色卡: {} (v{})",
        card.name,
        card.data
            .extensions
            .get("character_version")
            .and_then(|v| v.as_str())
            .unwrap_or("?")
    );
    eprintln!("  regex_scripts: {} 条", card.regex_scripts().len());
    eprintln!("  character_book: {} 条", card.all_book_entries().len());
    eprintln!(
        "  alternate_greetings: {} 条",
        card.data.alternate_greetings.len()
    );
    let persisted_cards = load_persisted_imports();
    if !persisted_cards.is_empty() {
        eprintln!("  imported_cards: {} 张", persisted_cards.len());
    }

    // 从卡片的 tavern_helper.variables 读取初始状态
    let initial_state = initial_game_state(&card);

    let llm = llm::LlmProvider::from_env();
    eprintln!("✓ LLM provider: {}", llm.name());
    if llm.is_mock() {
        eprintln!(
            "  (set CONCLAVE_LLM_BASE_URL + CONCLAVE_LLM_API_KEY for OpenAI-compatible real LLM)"
        );
    }

    let app_state = AppState {
        game_state: Arc::new(RwLock::new(initial_state)),
        card_store: Arc::new(RwLock::new(CardStore::new(card, persisted_cards))),
        llm,
    };

    let app = Router::new()
        .route("/api/init", get(init_handler))
        .route("/api/import-card", post(import_card_handler))
        .route("/api/select-card", post(select_card_handler))
        .route("/api/greetings", get(greetings_handler))
        .route(
            "/api/runtime-requirements",
            get(runtime_requirements_handler),
        )
        .route("/api/chat", post(chat_handler))
        .layer(DefaultBodyLimit::max(25 * 1024 * 1024))
        .layer(middleware::from_fn(cors_middleware))
        .with_state(app_state);

    // CONCLAVE_BIND (e.g. 127.0.0.1:18765) for e2e/smoke; default 0.0.0.0:3000.
    let bind_addr = std::env::var("CONCLAVE_BIND").unwrap_or_else(|_| "0.0.0.0:3000".to_string());
    let listener = tokio::net::TcpListener::bind(&bind_addr).await.unwrap();
    eprintln!("✓ 后端已启动: http://{bind_addr}");
    axum::serve(listener, app).await.unwrap();
}
