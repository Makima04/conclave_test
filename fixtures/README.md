# Multi real-card regression fixtures

**Goal:** stop single-card specialization (e.g. only 苍玄). Every display / init / switch
path must hold for **several real SillyTavern cards** at once — same idea as ST, where
cards share one host, not per-card forks.

## Tracked cards (`real-cards/`)

| id | File | Role in the set |
|----|------|-----------------|
| `cangxuan` | `cangxuan.json` | Heavy regex + TH + large lorebook |
| `bianshen-shaonu` | `bianshen-shaonu.json` | Different author stack; status regex; no TH |
| `luren-nvzhu` | `luren-nvzhu.json` | Minimal regex; short first_mes |
| `dahuang-z` | `dahuang-z.json` | Heavy regex + TH; different placements |

Manifest: `real-cards/manifest.json`.  
**CI requires ≥3 tracked cards.** Do not shrink to one “golden card”.

Optional: if `backend/data/imported_cards/*.json` exists locally, FE helpers can also
scan them (`listOptionalImportedCards`) without committing user imports.

## What we assert (observable, not “looks like one card”)

| Layer | Assertion |
|-------|-----------|
| Matrix | Every card: `processDisplay(first_mes + greetings)` no throw; FE == ST oracle |
| Fingerprints | `fixtures/golden/real-openings/<id>.json` sha256 of normalized opening HTML |
| Host switch | Load A→B→C→D: epoch, name, regex count, **messages reset**, no chat bleed |
| Cross-card | Opening of card A does not inject other cards’ names; scripts come from **current** card |
| Backend | import/select each real card; `regex_scripts` / `first_message` follow selection |
| Rule goldens | Tiny ST rules only (`golden/display/*`) — placement / promptOnly / depth |

We **do not** freeze multi‑MB full HTML per card as the only gate; fingerprints catch drift.

## Commands

```bash
# Refresh real-card opening fingerprints (after intentional display changes)
node scripts/real-card-fingerprints.mjs
node scripts/real-card-fingerprints.mjs --check

# ST rule goldens only
node scripts/golden-refresh.mjs --check

# FE multi-card suite
cd frontend && npm run test:cards

# BE multi real-card
cd backend && cargo test multi_real_card
```

## Adding a new real card

1. Export ST card JSON → `fixtures/real-cards/<id>.json`
2. Add entry to `manifest.json`
3. `node scripts/real-card-fingerprints.mjs`
4. `npm run test:cards` && `cargo test multi_real`

Prefer **diverse** cards (regex density, TH yes/no, greeting count), not more clones of one author stack.
