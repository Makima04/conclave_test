// backend/src/lorebook/mod.rs
pub mod ejs_parser;

use serde_json::Value;

/// Prompt 注入槽位（为 Mind / 扩展预留；PR-03 仅拼接文本，不解析业务语义）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptInjection {
    /// 插入槽位标识，例如 `"after_scenario"`、`"mind.primary"`
    pub slot: String,
    /// 注入的 system 文本
    pub text: String,
}

/// 组装 Prompt 的核心函数
///
/// 顺序：
/// 1. system_prompt（若有）
/// 2. 轻量 character_book 常量/启用条目摘要（不做完整 EJS）
/// 3. 可选 prompt injections（默认空，为 Mind 预留）
/// 4. 通用 game_state JSON dump
pub fn compile_prompt(
    card_json: &Value,
    game_state: &Value,
    injections: Option<&[PromptInjection]>,
) -> String {
    let mut prompt = String::new();

    // 1. 基础 System Prompt
    if let Some(sys) = card_json
        .pointer("/data/system_prompt")
        .and_then(|v| v.as_str())
    {
        if !sys.trim().is_empty() {
            prompt.push_str(sys);
            prompt.push_str("\n\n");
        }
    }

    // 2. 轻量世界书：启用或 constant 条目的摘要（无完整 EJS / 区域硬编码）
    append_character_book_summaries(&mut prompt, card_json);

    // 3. Prompt injections 插入点（Mind 等未来调用方可传入）
    if let Some(items) = injections {
        for injection in items {
            if injection.text.trim().is_empty() {
                continue;
            }
            prompt.push_str(&format!(
                "--- prompt injection [{}] ---\n{}\n\n",
                injection.slot, injection.text
            ));
        }
    }

    // 4. 通用状态 dump（不写死区域/灵石等卡片语义）
    prompt.push_str("--- current game state (for model context; do not dump this JSON in the reply) ---\n");
    prompt.push_str(&serde_json::to_string_pretty(game_state).unwrap_or_default());
    prompt.push_str("\n----------------------------------------\n");

    prompt
}

fn append_character_book_summaries(prompt: &mut String, card_json: &Value) {
    let Some(entries) = card_json
        .pointer("/data/character_book/entries")
        .and_then(|v| v.as_array())
    else {
        return;
    };

    let mut lines: Vec<String> = Vec::new();
    for entry in entries {
        let enabled = entry
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let constant = entry
            .get("constant")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !enabled && !constant {
            continue;
        }

        let comment = entry
            .get("comment")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let content = entry
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if comment.is_empty() && content.is_empty() {
            continue;
        }

        // 轻量摘要：标题 + 内容前若干字符（避免把整本世界书塞进 prompt）
        let summary = truncate_chars(content, 200);
        if comment.is_empty() {
            lines.push(format!("- {summary}"));
        } else if summary.is_empty() {
            lines.push(format!("- [{comment}]"));
        } else {
            lines.push(format!("- [{comment}] {summary}"));
        }
    }

    if lines.is_empty() {
        return;
    }

    prompt.push_str("--- world info (constant/enabled entry summaries) ---\n");
    for line in lines {
        prompt.push_str(&line);
        prompt.push('\n');
    }
    prompt.push('\n');
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i >= max_chars {
            out.push('…');
            break;
        }
        // 折叠空白，摘要更紧凑
        if ch.is_whitespace() {
            if out.ends_with(' ') || out.is_empty() {
                continue;
            }
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn minimal_card(system_prompt: &str, book_entries: Option<Value>) -> Value {
        let mut data = json!({
            "name": "neutral-card",
            "system_prompt": system_prompt,
            "first_mes": "Hello.",
            "extensions": {}
        });
        if let Some(entries) = book_entries {
            data["character_book"] = json!({
                "name": "test-book",
                "entries": entries
            });
        }
        json!({
            "name": "neutral-card",
            "first_mes": "Hello.",
            "data": data
        })
    }

    #[test]
    fn compile_prompt_is_card_neutral_without_region_or_spirit_stone_hardcoding() {
        let card = minimal_card("You are a helpful narrator.", None);
        let state = json!({
            "stat_data": {},
            "tavern_vars": {},
            "initialized_lorebooks": {}
        });

        let prompt = compile_prompt(&card, &state, None);

        assert!(prompt.contains("You are a helpful narrator."));
        assert!(prompt.contains("current game state"));
        assert!(!prompt.contains("当前所在区域"));
        assert!(!prompt.contains("灵石"));
        assert!(!prompt.contains("大区域"));
        assert!(!prompt.contains("经济体系"));
        assert!(!prompt.contains("世界系统"));
    }

    #[test]
    fn compile_prompt_includes_constant_book_summaries() {
        let card = minimal_card(
            "",
            Some(json!([
                {
                    "id": 1,
                    "comment": "Town rules",
                    "content": "No magic in the market square after dusk.",
                    "constant": true,
                    "enabled": true,
                    "keys": ["town"]
                },
                {
                    "id": 2,
                    "comment": "disabled lore",
                    "content": "Should not appear",
                    "constant": false,
                    "enabled": false,
                    "keys": []
                }
            ])),
        );
        let state = json!({ "stat_data": {} });

        let prompt = compile_prompt(&card, &state, None);

        assert!(prompt.contains("Town rules"));
        assert!(prompt.contains("No magic in the market square"));
        assert!(!prompt.contains("Should not appear"));
    }

    #[test]
    fn compile_prompt_appends_injections_at_reserved_slot() {
        let card = minimal_card("Base system.", None);
        let state = json!({ "stat_data": {} });
        let injections = [PromptInjection {
            slot: "after_scenario".into(),
            text: "[mind] Alice is cautious around strangers.".into(),
        }];

        let prompt = compile_prompt(&card, &state, Some(&injections));

        assert!(prompt.contains("Base system."));
        assert!(prompt.contains("--- prompt injection [after_scenario] ---"));
        assert!(prompt.contains("[mind] Alice is cautious around strangers."));
        // injection 在 state dump 之前
        let inj_pos = prompt.find("prompt injection").unwrap();
        let state_pos = prompt.find("current game state").unwrap();
        assert!(inj_pos < state_pos);
    }

    #[test]
    fn compile_prompt_handles_empty_stat_data() {
        let card = minimal_card("", None);
        let state = json!({ "stat_data": {} });
        let prompt = compile_prompt(&card, &state, None);
        assert!(prompt.contains("\"stat_data\": {}") || prompt.contains("\"stat_data\":{}"));
    }
}
