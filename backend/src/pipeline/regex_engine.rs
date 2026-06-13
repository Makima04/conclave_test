// Regex 引擎：根据用户定义的正则脚本对文本进行批量替换
// 将AI的纯文本替换成包含HTML标签的富文本，或者反过来清理掉HTML标签等

use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RegexScript {
    #[serde(rename = "findRegex")]
    pub find_regex: String,
    #[serde(rename = "replaceString")]
    pub replace_string: String,
    pub disabled: bool,
}

pub struct RegexPipeline;

impl RegexPipeline {
    pub fn process(text: &str, scripts: &[RegexScript]) -> String {
        let mut result = text.to_string();
        
        for script in scripts {
            if script.disabled { continue; }
            
            // 移除酒馆正则开头的 / 和结尾的 /gm 等标志
            let clean_regex = script.find_regex.trim_start_matches('/').trim_end_matches("/gm").trim_end_matches("/g");
            
            if let Ok(re) = Regex::new(&format!("(?m){}", clean_regex)) {
                // Rust 的 replace_all 完美支持 $1, $2 捕获组替换
                result = re.replace_all(&result, script.replace_string.as_str()).to_string();
            }
        }
        result
    }
}