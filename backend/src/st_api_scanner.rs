use crate::card_loader::CardData;
use regex::Regex;
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Serialize, Default)]
pub struct StRuntimeRequirements {
    pub globals: Vec<String>,
    pub window_globals: Vec<String>,
    pub parent_globals: Vec<String>,
    pub libraries: Vec<String>,
    pub events: Vec<String>,
    pub slash_commands: Vec<String>,
    pub required_shims: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Default)]
struct RequirementSets {
    globals: BTreeSet<String>,
    window_globals: BTreeSet<String>,
    parent_globals: BTreeSet<String>,
    libraries: BTreeSet<String>,
    events: BTreeSet<String>,
    slash_commands: BTreeSet<String>,
    required_shims: BTreeSet<String>,
    warnings: BTreeSet<String>,
}

const KNOWN_GLOBALS: &[&str] = &[
    "triggerSlash",
    "Mvu",
    "eventEmit",
    "eventSource",
    "getChatMessages",
    "setChatMessages",
    "setChatMessage",
    "getLorebookEntries",
    "setLorebookEntries",
    "replaceLorebookEntries",
    "updateLorebookEntriesWith",
    "createLorebookEntries",
    "deleteLorebookEntries",
    "TavernHelper",
    "executeSlashCommands",
    "executeSlashCommandsWithOptions",
    "getvar",
    "setvar",
    "toastr",
];

pub fn scan_card(card: &CardData) -> StRuntimeRequirements {
    let mut sets = RequirementSets::default();

    scan_text(&card.data.first_mes, &mut sets);
    for greeting in &card.data.alternate_greetings {
        scan_text(greeting, &mut sets);
    }

    for script in card.regex_scripts() {
        scan_text(&script.find_regex, &mut sets);
        scan_text(&script.replace_string, &mut sets);
    }

    for script in card.tavern_helper_scripts() {
        scan_text(&script.name, &mut sets);
        scan_text(&script.info, &mut sets);
        scan_text(&script.content, &mut sets);
        if script.content.contains("import 'http") || script.content.contains("import \"http") {
            sets.warnings.insert(format!(
                "TavernHelper script '{}' imports a remote module; Conclave must allow the card-provided module to load or provide a local mirror.",
                script.name
            ));
        }
    }

    if let Some(book) = &card.data.character_book {
        for entry in &book.entries {
            scan_text(&entry.content, &mut sets);
        }
    }

    infer_required_shims(&mut sets);

    StRuntimeRequirements {
        globals: sets.globals.into_iter().collect(),
        window_globals: sets.window_globals.into_iter().collect(),
        parent_globals: sets.parent_globals.into_iter().collect(),
        libraries: sets.libraries.into_iter().collect(),
        events: sets.events.into_iter().collect(),
        slash_commands: sets.slash_commands.into_iter().collect(),
        required_shims: sets.required_shims.into_iter().collect(),
        warnings: sets.warnings.into_iter().collect(),
    }
}

fn scan_text(text: &str, sets: &mut RequirementSets) {
    for name in KNOWN_GLOBALS {
        let re = Regex::new(&format!(r"\b{}\b", regex::escape(name))).unwrap();
        if re.is_match(text) {
            sets.globals.insert((*name).to_string());
        }
    }

    collect_prefixed_globals(text, "window", &mut sets.window_globals);
    collect_prefixed_globals(text, "parent", &mut sets.parent_globals);
    collect_events(text, sets);
    collect_slash_commands(text, sets);

    if text.contains("$(") || text.contains("jQuery") {
        sets.libraries.insert("jquery".to_string());
    }
    if text.contains("window._")
        || text.contains("parent._")
        || text.contains("_.set")
        || text.contains("_.get")
    {
        sets.libraries.insert("lodash".to_string());
    }
}

fn collect_prefixed_globals(text: &str, prefix: &str, target: &mut BTreeSet<String>) {
    let re = Regex::new(&format!(r"\b{}\.([A-Za-z_$][A-Za-z0-9_$]*)", prefix)).unwrap();
    for cap in re.captures_iter(text) {
        if let Some(name) = cap.get(1) {
            target.insert(format!("{}.{}", prefix, name.as_str()));
        }
    }
}

fn collect_events(text: &str, sets: &mut RequirementSets) {
    let events_member_re = Regex::new(r"\bevents\.([A-Z][A-Z0-9_]+)\b").unwrap();
    for cap in events_member_re.captures_iter(text) {
        if let Some(name) = cap.get(1) {
            sets.events.insert(name.as_str().to_string());
        }
    }

    let uppercase_re = Regex::new(r"\b([A-Z][A-Z0-9_]{3,})\b").unwrap();
    for cap in uppercase_re.captures_iter(text) {
        let name = cap.get(1).unwrap().as_str();
        if name.starts_with("VARIABLE_")
            || name.starts_with("MESSAGE_")
            || name.starts_with("WORLDINFO_")
        {
            sets.events.insert(name.to_string());
        }
    }
}

fn collect_slash_commands(text: &str, sets: &mut RequirementSets) {
    let patterns = [
        r#"(?s)(?:triggerSlash|execCmd)\s*\(\s*`([^`]*)`"#,
        r#"(?s)(?:triggerSlash|execCmd)\s*\(\s*"([^"]*)""#,
        r#"(?s)(?:triggerSlash|execCmd)\s*\(\s*'([^']*)'"#,
    ];

    for pattern in patterns {
        let re = Regex::new(pattern).unwrap();
        for cap in re.captures_iter(text) {
            if let Some(command) = cap.get(1) {
                let command = command
                    .as_str()
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                if command.starts_with('/') {
                    sets.slash_commands.insert(command);
                }
            }
        }
    }
}

fn infer_required_shims(sets: &mut RequirementSets) {
    if sets.globals.contains("triggerSlash") || has_suffix(&sets.parent_globals, ".triggerSlash") {
        sets.required_shims.insert("trigger_slash".to_string());
    }

    if sets.globals.contains("Mvu")
        || has_suffix(&sets.window_globals, ".Mvu")
        || has_suffix(&sets.parent_globals, ".Mvu")
    {
        sets.required_shims.insert("mvu".to_string());
        sets.warnings.insert(
            "MVU compatibility is a local shim and does not implement the full MagVarUpdate framework."
                .to_string(),
        );
    }

    if sets.globals.contains("eventEmit")
        || sets.globals.contains("eventSource")
        || has_suffix(&sets.window_globals, ".eventEmit")
        || has_suffix(&sets.parent_globals, ".eventEmit")
    {
        sets.required_shims.insert("events".to_string());
    }

    if ["getChatMessages", "setChatMessages", "setChatMessage"]
        .iter()
        .any(|name| sets.globals.contains(*name))
    {
        sets.required_shims.insert("chat_messages".to_string());
    }

    if [
        "getLorebookEntries",
        "setLorebookEntries",
        "replaceLorebookEntries",
        "updateLorebookEntriesWith",
        "createLorebookEntries",
        "deleteLorebookEntries",
    ]
    .iter()
    .any(|name| sets.globals.contains(*name))
    {
        sets.required_shims.insert("lorebook_entries".to_string());
    }

    for library in &sets.libraries {
        sets.required_shims.insert(format!("library:{}", library));
    }
}

fn has_suffix(values: &BTreeSet<String>, suffix: &str) -> bool {
    values.iter().any(|value| value.ends_with(suffix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::card_loader::{CardData, CardInner};
    use serde_json::json;

    #[test]
    fn scans_opening_card_dependencies() {
        let card = CardData {
            name: "test".to_string(),
            description: String::new(),
            personality: String::new(),
            scenario: String::new(),
            first_mes: "start".to_string(),
            mes_example: String::new(),
            creatorcomment: String::new(),
            tags: vec![],
            data: CardInner {
                name: "test".to_string(),
                system_prompt: String::new(),
                post_history_instructions: String::new(),
                first_mes: "start".to_string(),
                alternate_greetings: vec![],
                character_book: None,
                extensions: json!({
                    "regex_scripts": [{
                        "scriptName": "ui",
                        "findRegex": "start",
                        "replaceString": "<script>const execCmd = triggerSlash; await execCmd('/trigger'); const mvu = window.Mvu || parent.Mvu; window.eventEmit(mvu.events.VARIABLE_UPDATE_ENDED); _.set({}, 'a', 1);</script>"
                    }]
                }),
            },
        };

        let requirements = scan_card(&card);

        assert!(requirements.globals.contains(&"triggerSlash".to_string()));
        assert!(requirements
            .window_globals
            .contains(&"window.Mvu".to_string()));
        assert!(requirements
            .parent_globals
            .contains(&"parent.Mvu".to_string()));
        assert!(requirements
            .events
            .contains(&"VARIABLE_UPDATE_ENDED".to_string()));
        assert!(requirements
            .slash_commands
            .contains(&"/trigger".to_string()));
        assert!(requirements.required_shims.contains(&"mvu".to_string()));
        assert!(requirements
            .required_shims
            .contains(&"trigger_slash".to_string()));
    }
}
