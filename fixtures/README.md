# Conclave test fixtures

Synthetic character cards and display goldens for multi-card + ST-aligned regression.

## Cards (`cards/<id>/card.json`)

| Id | Purpose |
|----|---------|
| `minimal-neutral` | No 苍玄/灵石 defaults; swipe alternate greeting |
| `regex-basic` | Display vs `promptOnly` regex (placement 2) |
| `status-bar` | `StatusPlaceHolder` + markdownOnly statusbar |

Real/large cards stay out of default CI (optional private suite later).

## Display goldens (`golden/display/*.json`)

Each file:

```json
{
  "id": "...",
  "raw": "...",
  "scripts": [ /* ST regex_scripts shape */ ],
  "options": { "placement": 2, "depth": 0 },
  "expected": "...",
  "st_align": "which ST rule this locks"
}
```

Refresh (repo root):

```bash
node scripts/golden-refresh.mjs          # rewrite expected via ST-aligned oracle
node scripts/golden-refresh.mjs --check  # fail on drift
```

Oracle: `scripts/lib/stDisplayOracle.mjs` — pure port of ST `getRegexedString` rules
(scripts passed explicitly; no full SillyTavern runtime).

## Tests

| Suite | Command |
|-------|---------|
| FE goldens + multi-card Host | `cd frontend && npm run test:cards` |
| All FE | `cd frontend && npm test` |
| BE multi-card import/select | `cd backend && cargo test multi_card` |

## Observable contracts (what we assert)

- Opening HTML / fingerprint (status-card, panel, no 灵石)
- Session: `card_name`, `session_epoch`, `messages.length`
- MessageMount bubble count after mock chat
- Card A → B: no residual opening text / artifact nodes
- Swipe alternate greeting display
