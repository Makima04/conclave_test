// 拦截AI响应中的 <JSONPatch> 标签，提取其中的 JSON Patch 内容，并应用到当前状态上

use json_patch::patch;
use regex::Regex;
use serde_json::Value;

pub fn apply_mvu_patch(state: &mut Value, ai_response: &str) {
    let re = Regex::new(r"(?s)<JSONPatch>(.*?)</JSONPatch>").unwrap();
    if let Some(caps) = re.captures(ai_response) {
        let patch_str = caps.get(1).unwrap().as_str();
        // 清理酒馆特有的 <q> 标签
        let clean_json = patch_str.replace("<q>", "\"").replace("</q>", "\"");

        if let Ok(patch_ops) = serde_json::from_str::<json_patch::Patch>(&clean_json) {
            let _ = patch(state, &patch_ops);
        }
    }
}
