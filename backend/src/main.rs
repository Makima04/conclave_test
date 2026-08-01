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
mod lorebook;
mod pipeline;
mod st_api_scanner;

#[derive(Clone)]
struct AppState {
    game_state: Arc<RwLock<serde_json::Value>>,
    card_store: Arc<RwLock<CardStore>>,
}

struct CardStore {
    cards: Vec<ImportedCard>,
    current_id: usize,
    next_id: usize,
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

    fn import_card(&mut self, card: card_loader::CardData, source_file: Option<PathBuf>) -> usize {
        let id = self.next_id;
        self.next_id += 1;
        self.cards.push(ImportedCard {
            id,
            card,
            source_file,
        });
        self.current_id = id;
        id
    }

    fn select_card(&mut self, id: usize) -> Option<&card_loader::CardData> {
        if self.cards.iter().any(|imported| imported.id == id) {
            self.current_id = id;
            Some(self.current_card())
        } else {
            None
        }
    }
}

#[derive(Deserialize)]
struct ChatRequest {
    user_message: String,
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
struct ChatResponse {
    raw_text: String,
    rendered_html: String,
    new_state: serde_json::Value,
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
    rendered_html: String,
    greetings: Vec<String>,
    rendered_greetings: Vec<String>,
    worldbook_entries: Vec<WorldbookEntryResponse>,
    tavern_helper_scripts: Vec<TavernHelperScriptSummary>,
    imported_worldbooks: Vec<ImportedWorldbookResponse>,
    current_worldbook_id: usize,
    card_name: String,
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

/// POST /api/chat — 接收用户消息，返回 mock LLM 响应的渲染结果
async fn chat_handler(
    State(state): State<AppState>,
    Json(req): Json<ChatRequest>,
) -> Json<ChatResponse> {
    let mut game_state = state.game_state.write().await;
    let card = {
        let store = state.card_store.read().await;
        store.current_card().clone()
    };

    // 1. 组装 Prompt（通用 WI 摘要 + state dump；injections 默认空，Mind 预留）
    let _system_prompt = lorebook::compile_prompt(
        &serde_json::to_value(&card).unwrap_or_default(),
        &game_state,
        None,
    );

    // 2. Mock LLM 响应（演示正则管线效果）
    let llm_raw_response = format!(
        r#"【沈慕微】："{}"
<inner>（内心独白：对方说了 '{}' ...）</inner>"#,
        req.user_message, req.user_message
    );

    // 3. 提取并应用 MVU 变量更新
    pipeline::mvu_patch::apply_mvu_patch(&mut game_state, &llm_raw_response);

    // 4. 执行正则管线 (生成前端需要的 HTML)
    let scripts = card.regex_scripts();
    let rendered_html = render_card_message(&card, &llm_raw_response, &scripts);

    Json(ChatResponse {
        raw_text: llm_raw_response,
        rendered_html,
        new_state: game_state.clone(),
    })
}

fn build_init_response(store: &CardStore) -> InitResponse {
    let card = store.current_card();
    let scripts = card.regex_scripts();

    // 将 first_mes ("【GameStart】") 通过正则管线渲染为 HTML
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
        imported_worldbooks: imported_worldbooks(store),
        current_worldbook_id: store.current_id,
        card_name: card.name.clone(),
        runtime_requirements,
    }
}

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

#[cfg(test)]
mod tests {
    use super::{initial_game_state, message_has_status_variable_payload, render_card_message};
    use crate::card_loader::{CardData, CardInner, RegexScript};
    use serde_json::json;

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

    let app_state = AppState {
        game_state: Arc::new(RwLock::new(initial_state)),
        card_store: Arc::new(RwLock::new(CardStore::new(card, persisted_cards))),
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

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    eprintln!("✓ 后端已启动: http://localhost:3000");
    axum::serve(listener, app).await.unwrap();
}
