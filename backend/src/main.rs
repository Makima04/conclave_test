use axum::{extract::State, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

mod lorebook;
mod pipeline;

#[derive(Clone)]
struct AppState {
    game_state: Arc<RwLock<serde_json::Value>>,
    card_json: Arc<serde_json::Value>,
}

#[derive(Deserialize)]
struct ChatRequest {
    user_message: String,
}

#[derive(Serialize)]
struct ChatResponse {
    raw_text: String,
    rendered_html: String,
    new_state: serde_json::Value,
}

async fn chat_handler(
    State(state): State<AppState>,
    Json(req): Json<ChatRequest>,
) -> Json<ChatResponse> {
    let mut game_state = state.game_state.write().await;
    
    // 1. 组装 Prompt (调用 EJS 解析世界书)
    let system_prompt = lorebook::compile_prompt(&state.card_json, &game_state);
    
    // 2. 请求 LLM (省略 reqwest 代码)
    let llm_raw_response = format!(r#"
        <UpdateVariable>
        <JSONPatch>[{{"op": "replace", "path": "/stat_data/主角状态/灵石钱包/下品灵石", "value": 45}}]</JSONPatch>
        </UpdateVariable>
        【沈慕微】：“嗯。”
        <inner>完了，灵鹤被我烤了...</inner>
    "#);

    // 3. 提取并应用 MVU 变量更新
    pipeline::mvu_patch::apply_mvu_patch(&mut game_state, &llm_raw_response);

    // 4. 执行正则管线 (生成前端需要的 HTML)
    let scripts = state.card_json["data"]["extensions"]["regex_scripts"].as_array().unwrap();
    let scripts: Vec<pipeline::regex_engine::RegexScript> = serde_json::from_value(serde_json::to_value(scripts).unwrap()).unwrap();
    
    let rendered_html = pipeline::regex_engine::RegexPipeline::process(&llm_raw_response, &scripts);

    Json(ChatResponse {
        raw_text: llm_raw_response,
        rendered_html,
        new_state: game_state.clone(),
    })
}

#[tokio::main]
async fn main() {
    let card_json: serde_json::Value = serde_json::from_str(include_str!("../data/cangxuan_v1.0.20.json")).unwrap();
    let initial_state = serde_json::json!({ "stat_data": { "主角状态": { "灵石钱包": { "下品灵石": 50 } } } });

    let app_state = AppState {
        game_state: Arc::new(RwLock::new(initial_state)),
        card_json: Arc::new(card_json),
    };

    let app = Router::new()
        .route("/api/chat", post(chat_handler))
        .with_state(app_state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}