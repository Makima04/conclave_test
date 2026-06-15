// backend/src/lorebook/mod.rs
pub mod ejs_parser;

use serde_json::Value;

/// 组装 Prompt 的核心函数
/// 接收卡片 JSON 和当前游戏状态，动态拼接世界书和 EJS 逻辑
pub fn compile_prompt(card_json: &Value, game_state: &Value) -> String {
    let mut prompt = String::new();

    // 1. 提取基础 System Prompt (如果有)
    if let Some(sys) = card_json["data"]["system_prompt"].as_str() {
        if !sys.trim().is_empty() {
            // not an empty prompt
            prompt.push_str(sys);
            prompt.push_str("\n\n");
        }
    }

    // 2. 模拟 EJS 世界书动态加载逻辑 (简化版)
    // 获取当前大区域 (例如 "天剑宗")
    let current_area = game_state["stat_data"]["世界系统"]["大区域"]
        .as_str()
        .unwrap_or("未知区域");

    // 在真实项目中，这里会遍历 character_book.entries，检查 keys 是否匹配 current_area
    // 并调用 EjsParser::extract_activated_keys 来解析 EJS 条件
    prompt.push_str(&format!(
        "[系统提示：当前所在区域为 {}，请严格根据该区域的世界书规则、经济体系和战力体系进行回复。]\n\n", 
        current_area
    ));

    // 3. 注入 MVU 当前状态 (作为 System Prompt 的一部分，供 LLM 参考)
    // 注意：实际酒馆中，MVU 状态通常由插件在后台注入，这里我们将其格式化后附加，
    // 并明确告诉 LLM 不要直接输出这个 JSON。
    prompt.push_str("--- 当前世界状态 (供后台逻辑参考，请勿在正文中直接输出此 JSON) ---\n");
    prompt.push_str(&serde_json::to_string_pretty(game_state).unwrap_or_default());
    prompt.push_str("\n----------------------------------------\n");

    prompt
}
