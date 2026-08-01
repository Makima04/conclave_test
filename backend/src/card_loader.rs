// card_loader.rs — 解析 SillyTavern V3 角色卡 JSON
// 提取 regex_scripts、character_book、alternate_greetings 等核心数据

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 顶层卡片结构（chara_card_v3）
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct CardData {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub personality: String,
    #[serde(default)]
    pub scenario: String,
    pub first_mes: String,
    #[serde(default)]
    pub mes_example: String,
    #[serde(default)]
    pub creatorcomment: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub data: CardInner,
}

/// data 字段内的规范数据
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct CardInner {
    pub name: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub post_history_instructions: String,
    #[serde(default)]
    pub first_mes: String,
    #[serde(default)]
    pub alternate_greetings: Vec<String>,
    #[serde(default)]
    pub character_book: Option<CharacterBook>,
    #[serde(default)]
    pub extensions: Value,
}

/// 世界书
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct CharacterBook {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub entries: Vec<BookEntry>,
}

/// 世界书条目
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct BookEntry {
    pub id: Option<i64>,
    #[serde(default)]
    pub keys: Vec<String>,
    #[serde(default)]
    pub secondary_keys: Vec<String>,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub constant: bool,
    #[serde(default)]
    pub selective: bool,
    #[serde(default)]
    pub insertion_order: i64,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub position: Value,
    #[serde(default)]
    pub use_regex: bool,
    #[serde(default)]
    pub extensions: Value,
}

impl CardData {
    /// 从 JSON 字符串解析卡片
    pub fn from_json(json_str: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json_str)
    }

    /// 从 JSON Value 解析卡片
    pub fn from_value(value: Value) -> Result<Self, serde_json::Error> {
        serde_json::from_value(value)
    }

    /// 获取 regex_scripts 列表（从 extensions 中提取）
    pub fn regex_scripts(&self) -> Vec<RegexScript> {
        self.data
            .extensions
            .get("regex_scripts")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| serde_json::from_value(v.clone()).ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 获取 tavern_helper 中的变量
    pub fn tavern_variables(&self) -> Value {
        self.data
            .extensions
            .get("tavern_helper")
            .and_then(|th| th.get("variables"))
            .cloned()
            .unwrap_or(Value::Object(Default::default()))
    }

    /// 获取 tavern_helper.scripts 列表
    pub fn tavern_helper_scripts(&self) -> Vec<TavernHelperScript> {
        self.data
            .extensions
            .get("tavern_helper")
            .and_then(|th| th.get("scripts"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| serde_json::from_value(v.clone()).ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 获取已启用的世界书条目（constant=true 或 enabled=true）
    pub fn active_book_entries(&self) -> Vec<&BookEntry> {
        self.data
            .character_book
            .as_ref()
            .map(|cb| {
                cb.entries
                    .iter()
                    .filter(|e| e.enabled || e.constant)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 获取所有世界书条目
    pub fn all_book_entries(&self) -> Vec<&BookEntry> {
        self.data
            .character_book
            .as_ref()
            .map(|cb| cb.entries.iter().collect())
            .unwrap_or_default()
    }
}

/// 正则脚本（SillyTavern regex_scripts 格式）
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RegexScript {
    #[serde(default)]
    pub id: String,
    #[serde(default, rename = "scriptName")]
    pub script_name: String,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default, rename = "runOnEdit")]
    pub run_on_edit: bool,
    #[serde(default, rename = "findRegex")]
    pub find_regex: String,
    #[serde(default, rename = "replaceString")]
    pub replace_string: String,
    #[serde(default)]
    pub placement: Vec<i64>,
    #[serde(default, rename = "substituteRegex")]
    pub substitute_regex: i64,
    #[serde(default, rename = "minDepth")]
    pub min_depth: Option<i64>,
    #[serde(default, rename = "maxDepth")]
    pub max_depth: Option<i64>,
    #[serde(default, rename = "markdownOnly")]
    pub markdown_only: bool,
    #[serde(default, rename = "promptOnly")]
    pub prompt_only: bool,
    /// ST: strings stripped from each expanded capture ($n / $<name>) before insert.
    #[serde(default, rename = "trimStrings")]
    pub trim_strings: Vec<String>,
}

/// TavernHelper 脚本（通常来自 data.extensions.tavern_helper.scripts）
#[derive(Debug, Deserialize, Serialize, Clone, Default)]
pub struct TavernHelperScript {
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "type")]
    pub script_type: String,
    #[serde(default)]
    pub info: String,
    #[serde(default)]
    pub content: String,
}
