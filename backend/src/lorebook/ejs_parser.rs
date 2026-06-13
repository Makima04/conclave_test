// EJS 解析器：从世界书条目的 EJS 模板中提取需要激活的 Key 列表

use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;

lazy_static::lazy_static! {
    // 匹配 <%- await getwi("Key") %>
    static ref GETWI_RE: Regex = Regex::new(r#"<%-\s*await\s+getwi\(\s*["']([^"']+)["']\s*\)\s*%>"#).unwrap();
    // 匹配 <% if (var === 'val') { %> (简化版条件判断)
    static ref IF_RE: Regex = Regex::new(r#"<%\s*if\s*\(\s*([a-zA-Z_]+)\s*===\s*["']([^"']+)["']\s*\)\s*\{%>"#).unwrap();
    static ref ENDIF_RE: Regex = Regex::new(r#"<%\s*\}\s*%>"#).unwrap();
}

pub struct EjsParser;

impl EjsParser {
    /// 解析世界书条目中的 EJS，返回需要激活的 Key 列表
    pub fn extract_activated_keys(template: &str, state: &Value) -> Vec<String> {
        let mut activated_keys = Vec::new();
        let mut condition_stack: Vec<bool> = Vec::new();

        // 按行或块扫描 (此处简化为顺序正则匹配)
        let mut current_pos = 0;
        let text = template;

        // 简化的状态机：遇到 if 判断条件，遇到 getwi 收集 key
        for cap in IF_RE.captures_iter(text) {
            let var_name = cap.get(1).unwrap().as_str();
            let expected_val = cap.get(2).unwrap().as_str();
            
            // 从 State 中读取变量 (例如 stat_data.世界系统.大区域)
            let actual_val = state.pointer(&format!("/stat_data/世界系统/{}", var_name))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            
            condition_stack.push(actual_val == expected_val);
        }

        // 提取 getwi
        for cap in GETWI_RE.captures_iter(text) {
            // 检查是否在满足条件的 if 块内 (简化逻辑：只要没有 false 的 condition 就激活)
            let is_active = condition_stack.iter().all(|&c| c);
            if is_active || condition_stack.is_empty() {
                activated_keys.push(cap.get(1).unwrap().as_str().to_string());
            }
        }
        activated_keys
    }
}