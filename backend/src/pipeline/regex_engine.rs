// Regex 引擎：根据用户定义的正则脚本对文本进行批量替换
// 将AI的纯文本替换成包含HTML标签的富文本，或者反过来清理掉HTML标签等

use crate::card_loader::RegexScript;
use regex::{Captures, Regex};

pub struct RegexPipeline;

impl RegexPipeline {
    pub fn process(text: &str, scripts: &[RegexScript]) -> String {
        let mut result = text.to_string();

        result = apply_scripts_for_stage(&result, scripts, RegexStage::DisplaySource);
        result = apply_scripts_for_stage(&result, scripts, RegexStage::MarkdownDisplay);

        // 后处理：剥离 markdown 代码围栏 (SillyTavern 的 markdownOnly 脚本会产出 ```html...``` 包裹)
        result = strip_markdown_fences(&result);

        result
    }
}

enum RegexStage {
    DisplaySource,
    MarkdownDisplay,
}

fn apply_scripts_for_stage(text: &str, scripts: &[RegexScript], stage: RegexStage) -> String {
    let mut result = text.to_string();

    for script in scripts {
        if !should_run_script(script, &stage) {
            continue;
        }

        // 移除酒馆正则开头的 / 和结尾的 /gm 等标志
        let raw = script.find_regex.trim();
        let (clean_regex, flags) = if raw.starts_with('/') {
            let without_leading = &raw[1..];
            if let Some(last_slash) = without_leading.rfind('/') {
                (
                    &without_leading[..last_slash],
                    &without_leading[last_slash + 1..],
                )
            } else {
                (without_leading, "")
            }
        } else {
            (raw, "")
        };

        let mut regex_prefix = String::new();
        if flags.contains('m') {
            regex_prefix.push_str("(?m)");
        }
        if flags.contains('s') {
            regex_prefix.push_str("(?s)");
        }

        if let Ok(re) = Regex::new(&format!("{}{}", regex_prefix, clean_regex)) {
            result = re
                .replace_all(&result, |captures: &Captures| {
                    expand_replacement(&script.replace_string, captures)
                })
                .to_string();
        }
    }

    result
}

fn should_run_script(script: &RegexScript, stage: &RegexStage) -> bool {
    if script.disabled {
        return false;
    }

    match stage {
        RegexStage::DisplaySource => !script.markdown_only && !script.prompt_only,
        RegexStage::MarkdownDisplay => script.markdown_only,
    }
}

fn expand_replacement(template: &str, captures: &Captures<'_>) -> String {
    let mut output = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();
    let capture_count = captures.len().saturating_sub(1);

    while let Some(ch) = chars.next() {
        if ch != '$' {
            output.push(ch);
            continue;
        }

        match chars.peek().copied() {
            Some('$') => {
                chars.next();
                output.push('$');
            }
            Some('&') => {
                chars.next();
                output.push_str(captures.get(0).map_or("", |matched| matched.as_str()));
            }
            Some('1'..='9') => {
                let first_digit = chars.next().unwrap();
                let first_index = first_digit.to_digit(10).unwrap() as usize;
                let second_digit = chars.peek().copied().filter(|next| next.is_ascii_digit());

                if let Some(second_digit) = second_digit {
                    let second_index = second_digit.to_digit(10).unwrap() as usize;
                    let two_digit_index = first_index * 10 + second_index;
                    if two_digit_index <= capture_count {
                        chars.next();
                        output.push_str(
                            captures
                                .get(two_digit_index)
                                .map_or("", |matched| matched.as_str()),
                        );
                        continue;
                    }
                }

                if first_index <= capture_count {
                    output.push_str(
                        captures
                            .get(first_index)
                            .map_or("", |matched| matched.as_str()),
                    );
                } else {
                    output.push('$');
                    output.push(first_digit);
                }
            }
            Some('{') => {
                chars.next();
                let mut name = String::new();
                let mut closed = false;
                for next in chars.by_ref() {
                    if next == '}' {
                        closed = true;
                        break;
                    }
                    name.push(next);
                }

                if closed {
                    if let Some(matched) = captures.name(&name) {
                        output.push_str(matched.as_str());
                    } else {
                        output.push_str("${");
                        output.push_str(&name);
                        output.push('}');
                    }
                } else {
                    output.push_str("${");
                    output.push_str(&name);
                }
            }
            Some(_) | None => output.push('$'),
        }
    }

    output
}

/// 剥离 markdown 代码围栏，提取其中的 HTML 内容
/// 将 ```html\n...\n``` 替换为裸 HTML
fn strip_markdown_fences(text: &str) -> String {
    if let Some(content) = strip_outer_html_fence(text) {
        return content;
    }

    let re = Regex::new(r"(?is)```\s*(?:html\b)?\s*([\s\S]*?)\s*```").unwrap();
    re.replace_all(text, |captures: &Captures| {
        let content = captures.get(1).map_or("", |matched| matched.as_str());
        if looks_like_html(content) {
            content.trim().to_string()
        } else {
            captures
                .get(0)
                .map_or(String::new(), |matched| matched.as_str().to_string())
        }
    })
    .to_string()
}

fn strip_outer_html_fence(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if !trimmed.starts_with("```") {
        return None;
    }

    let mut inner = trimmed.trim_start_matches("```").trim_start();
    if inner
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("html"))
        && inner
            .get(4..)
            .and_then(|rest| rest.chars().next())
            .is_none_or(char::is_whitespace)
    {
        inner = inner[4..].trim_start();
    }

    let inner_without_closing = if inner.trim_end().ends_with("```") {
        let end = inner.trim_end().len() - 3;
        &inner[..end]
    } else {
        inner
    };

    let content = inner_without_closing.trim();
    if looks_like_html(content) {
        Some(content.to_string())
    } else {
        None
    }
}

fn looks_like_html(text: &str) -> bool {
    let trimmed = text.trim_start().to_ascii_lowercase();
    [
        "<!doctype",
        "<html",
        "<head",
        "<body",
        "<style",
        "<script",
        "<div",
        "<section",
        "<article",
        "<main",
    ]
    .iter()
    .any(|prefix| trimmed.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::RegexPipeline;
    use crate::card_loader::{CardData, RegexScript};

    #[test]
    fn replacement_keeps_javascript_dollar_identifiers() {
        let script = RegexScript {
            id: String::new(),
            script_name: "test".to_string(),
            run_on_edit: false,
            find_regex: "/\\{\\{GameStart\\}\\}/g".to_string(),
            replace_string: "const $fabaoGrid = $('#cx-fabao-grid'); `${fb.id}`".to_string(),
            placement: Vec::new(),
            substitute_regex: 0,
            min_depth: None,
            max_depth: None,
            markdown_only: false,
            prompt_only: false,
            disabled: false,
        };

        let output = RegexPipeline::process("{{GameStart}}", &[script]);

        assert!(output.contains("const $fabaoGrid = $('#cx-fabao-grid');"));
        assert!(output.contains("`${fb.id}`"));
    }

    #[test]
    fn replacement_expands_numeric_capture_groups() {
        let script = RegexScript {
            id: String::new(),
            script_name: "dialogue".to_string(),
            run_on_edit: false,
            find_regex: "/【(.*?)】\\s*[:：]\\s*([“\\\"「].*?[”\\\"」])/gm".to_string(),
            replace_string: r#"<div data-name="$1"><span>$1：</span><b>$2</b></div>"#.to_string(),
            placement: Vec::new(),
            substitute_regex: 0,
            min_depth: None,
            max_depth: None,
            markdown_only: false,
            prompt_only: false,
            disabled: false,
        };

        let output = RegexPipeline::process("【沈慕微】：“不是我。”", &[script]);

        assert!(output.contains(r#"data-name="沈慕微""#));
        assert!(output.contains("<span>沈慕微：</span>"));
        assert!(output.contains("<b>“不是我。”</b>"));
        assert!(!output.contains("$1"));
        assert!(!output.contains("$2"));
    }

    #[test]
    fn replacement_expands_two_digit_capture_groups() {
        let script = RegexScript {
            id: String::new(),
            script_name: "ten groups".to_string(),
            run_on_edit: false,
            find_regex: "/(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)/g".to_string(),
            replace_string: "$1-$10".to_string(),
            placement: Vec::new(),
            substitute_regex: 0,
            min_depth: None,
            max_depth: None,
            markdown_only: false,
            prompt_only: false,
            disabled: false,
        };

        let output = RegexPipeline::process("abcdefghij", &[script]);

        assert_eq!(output, "a-j");
    }

    #[test]
    fn display_pipeline_skips_prompt_only_scripts() {
        let prompt_cleanup = RegexScript {
            id: String::new(),
            script_name: "prompt cleanup".to_string(),
            run_on_edit: false,
            find_regex: "<customized>\\s*(.*?)\\s*</customized>".to_string(),
            replace_string: "开场".to_string(),
            placement: Vec::new(),
            substitute_regex: 0,
            min_depth: None,
            max_depth: None,
            markdown_only: false,
            prompt_only: true,
            disabled: false,
        };
        let display_ui = RegexScript {
            id: String::new(),
            script_name: "display ui".to_string(),
            run_on_edit: false,
            find_regex: "<customized>\\s*(.*?)\\s*</customized>".to_string(),
            replace_string: "```html <!doctype html><div class=\"panel\">$1</div>```".to_string(),
            placement: Vec::new(),
            substitute_regex: 0,
            min_depth: None,
            max_depth: None,
            markdown_only: true,
            prompt_only: false,
            disabled: false,
        };

        let output = RegexPipeline::process(
            "<customized>角色开场</customized>",
            &[prompt_cleanup, display_ui],
        );

        assert!(output.contains("<div class=\"panel\">角色开场</div>"));
        assert!(!output.contains("```"));
        assert_ne!(output, "开场");
    }

    #[test]
    fn markdown_display_runs_scripts_that_are_also_prompt_only() {
        let hide_update = RegexScript {
            id: String::new(),
            script_name: "hide update".to_string(),
            run_on_edit: false,
            find_regex: "/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/gm".to_string(),
            replace_string: String::new(),
            placement: Vec::new(),
            substitute_regex: 0,
            min_depth: None,
            max_depth: None,
            markdown_only: true,
            prompt_only: true,
            disabled: false,
        };

        let output = RegexPipeline::process(
            "正文<UpdateVariable>_.set('x', 1, 2);</UpdateVariable>",
            &[hide_update],
        );

        assert_eq!(output, "正文");
    }

    #[test]
    fn markdown_fence_stripping_accepts_inline_or_unlabeled_html() {
        let inline_html = RegexPipeline::process(
            "x",
            &[RegexScript {
                id: String::new(),
                script_name: "inline fence".to_string(),
                run_on_edit: false,
                find_regex: "x".to_string(),
                replace_string: "```html <!doctype html><div>ok</div>```".to_string(),
                placement: Vec::new(),
                substitute_regex: 0,
                min_depth: None,
                max_depth: None,
                markdown_only: true,
                prompt_only: false,
                disabled: false,
            }],
        );
        let unlabeled_html = RegexPipeline::process(
            "x",
            &[RegexScript {
                id: String::new(),
                script_name: "unlabeled fence".to_string(),
                run_on_edit: false,
                find_regex: "x".to_string(),
                replace_string: "``` <!doctype html><span>ok</span>```".to_string(),
                placement: Vec::new(),
                substitute_regex: 0,
                min_depth: None,
                max_depth: None,
                markdown_only: true,
                prompt_only: false,
                disabled: false,
            }],
        );

        assert_eq!(inline_html, "<!doctype html><div>ok</div>");
        assert_eq!(unlabeled_html, "<!doctype html><span>ok</span>");
    }

    #[test]
    fn markdown_fence_stripping_prefers_outer_html_fence() {
        let output = RegexPipeline::process(
            "x",
            &[RegexScript {
                id: String::new(),
                script_name: "outer html with inner fence regex".to_string(),
                run_on_edit: false,
                find_regex: "x".to_string(),
                replace_string:
                    "```\n<!doctype html><script>const re = /```[\\s\\S]*?```/g;</script>\n```"
                        .to_string(),
                placement: Vec::new(),
                substitute_regex: 0,
                min_depth: None,
                max_depth: None,
                markdown_only: true,
                prompt_only: false,
                disabled: false,
            }],
        );

        assert!(output.starts_with("<!doctype html>"));
        assert!(output.contains("const re = /```[\\s\\S]*?```/g;"));
        assert!(!output.starts_with("```"));
        assert!(!output.ends_with("```"));
    }

    #[test]
    fn current_alternate_greeting_expands_dialogue_template() {
        let card = CardData::from_json(include_str!("../../data/cangxuan_v1.0.20.json")).unwrap();
        let scripts = card.regex_scripts();
        let greeting = card.data.alternate_greetings.first().unwrap();

        let output = RegexPipeline::process(greeting, &scripts);

        assert!(output.contains("compact-dialogue"));
        assert!(!output.contains(r#"data-name="$1""#));
        assert!(!output.contains(r#"<span class="compact-name">$1"#));
        assert!(!output.contains(r#"<span class="compact-text">$2"#));
    }
}
