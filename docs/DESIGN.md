# RimSynapse Design Document

> **Version**: 0.1.0-draft  
> **Last Updated**: 2026-07-05  
> **Status**: Design Phase

---

## Table of Contents

1. [Project Vision](#project-vision)
2. [Architecture Overview](#architecture-overview)
3. [Part 1: Platform — Bridge API & Core Schema](#part-1-platform--bridge-api--core-schema)
   - [Core Database Schema](#core-database-schema)
   - [API Framework for Modders](#api-framework-for-modders)
   - [Schema Extension API](#schema-extension-api)
   - [Weight System & Prompt Retrieval](#weight-system--prompt-retrieval)
4. [Part 2: RimSynapse Mod Vision](#part-2-rimsynapse-mod-vision)
   - [Dynamic Pawn Psychology](#dynamic-pawn-psychology)
   - [Faction & World Simulation](#faction--world-simulation)
   - [Dynamic Chat Interactions](#dynamic-chat-interactions)
   - [Narrative Thread System](#narrative-thread-system)
   - [Relationship Integrals & Political Capital](#relationship-integrals--political-capital)

---

## Project Vision

RimSynapse is two things:

1. **A platform** — a local Python bridge server that provides:
   - A **living SQLite database** with REST API for tracking colony history, pawns, memories, relationships, and narrative threads — a weighted historical catalog that any mod can read from and write to
   - A **local AI proxy** that connects to LM Studio / Ollama so mods can make LLM calls without managing connections themselves

2. **A mod** (separate repo) — our own RimWorld mod that uses the platform to enhance NPC/pawn interactions with rich backstories, dynamic personality evolution, faction warfare, and emergent culture building.

The platform is the primary deliverable. It should be so easy to integrate that any modder can add AI-powered features to their mod by querying the database for context, building their own prompts, and sending them through the LLM proxy.

**The bridge does NOT build prompts or orchestrate AI calls.** Mods own prompt construction. This keeps the bridge simple, gives modders full control, and makes the platform useful to any mod regardless of what AI features they want to build.

### Architecture

```
┌──────────────────┐   JSON    ┌──────────────────┐  proxy   ┌──────────┐
│  Any RimWorld    │ ────────► │  RimSynapse      │ ───────► │ LM Studio│
│  Mod (C#)        │           │  Bridge (Python)  │          │ / Ollama │
│                  │ ◄──────── │                  │ ◄─────── │ (Local)  │
│  - Queries DB    │  response │  - REST API      │  LLM out └──────────┘
│  - Builds prompt │           │  - SQLite DB     │
│  - Parses output │           │  - LLM proxy     │
│  - Writes back   │           │  - Weight decay   │
└──────────────────┘           └──────────────────┘
```

### Design Principles

- **Portable** — ships as a zip file, auto-downloads embedded Python, no prerequisites
- **Small-model friendly** — all prompt construction optimizes for minimal context windows
- **Mod-agnostic** — any mod can integrate, not just ours
- **Weighted memory** — relevance-scored retrieval keeps prompts small and focused
- **One DB per save** — colony data is portable and save-game scoped

---

# Part 1: Platform — Bridge API & Core Schema

This section defines what the bridge ships with out of the box. Any modder can use these endpoints and tables without writing bridge-side code.

## Core Database Schema

**12 tables** covering pawn identity, weighted memory, conversations, and narrative connections.

### `colonies` — Save Game Identity

```sql
CREATE TABLE colonies (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    colony_name     TEXT NOT NULL,
    faction_name    TEXT,
    biome           TEXT,
    seed            TEXT,
    tile_id         INTEGER,
    scenario        TEXT,
    ideology_name   TEXT,
    year_started    INTEGER,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_played_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### `pawns` — Pawn Registry

```sql
CREATE TABLE pawns (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    colony_id               INTEGER NOT NULL REFERENCES colonies(id),
    pawn_id_game            TEXT NOT NULL,
    name_first              TEXT,
    name_nick               TEXT,
    name_last               TEXT,
    gender                  TEXT,
    age_biological          INTEGER,
    age_chronological       INTEGER,
    backstory_childhood     TEXT,
    backstory_childhood_desc TEXT,
    backstory_adulthood     TEXT,
    backstory_adulthood_desc TEXT,
    faction                 TEXT,
    title                   TEXT,
    ideology                TEXT,
    xenotype                TEXT,
    pawn_kind               TEXT,
    is_alive                BOOLEAN DEFAULT 1,
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(colony_id, pawn_id_game)
);
```

### `pawn_traits` — Personality Traits

```sql
CREATE TABLE pawn_traits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pawn_id     INTEGER NOT NULL REFERENCES pawns(id) ON DELETE CASCADE,
    trait_def   TEXT NOT NULL,
    label       TEXT NOT NULL,
    degree      INTEGER DEFAULT 0,
    description TEXT
);
```

### `pawn_skills` — Competence

```sql
CREATE TABLE pawn_skills (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pawn_id     INTEGER NOT NULL REFERENCES pawns(id) ON DELETE CASCADE,
    skill_name  TEXT NOT NULL,
    level       INTEGER DEFAULT 0,
    passion     TEXT DEFAULT 'None',
    UNIQUE(pawn_id, skill_name)
);
```

### `memories` — Weighted Event History

Every significant event gets a row here. Each has a weight that determines if it makes it into prompts.

```sql
CREATE TABLE memories (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    colony_id           INTEGER NOT NULL REFERENCES colonies(id),
    pawn_id             INTEGER REFERENCES pawns(id),
    memory_type         TEXT NOT NULL,
    summary             TEXT NOT NULL,
    participants        TEXT,           -- JSON array
    tags                TEXT,           -- JSON array
    game_tick           INTEGER,
    in_game_date        TEXT,
    weight              REAL DEFAULT 0.8,
    base_weight         REAL DEFAULT 0.8,
    decay_rate          REAL DEFAULT 0.05,
    times_referenced    INTEGER DEFAULT 0,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_referenced_at  TIMESTAMP,
    last_decayed_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_memories_colony_weight ON memories(colony_id, weight DESC);
CREATE INDEX idx_memories_pawn_weight ON memories(pawn_id, weight DESC);
CREATE INDEX idx_memories_type ON memories(memory_type);
```

### `relationships` — Pawn-to-Pawn with Integral Tracking

```sql
CREATE TABLE relationships (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    colony_id           INTEGER NOT NULL REFERENCES colonies(id),
    pawn_a_id           INTEGER NOT NULL REFERENCES pawns(id),
    pawn_b_id           INTEGER NOT NULL REFERENCES pawns(id),
    relation_type       TEXT,
    opinion_a_to_b      INTEGER DEFAULT 0,
    opinion_b_to_a      INTEGER DEFAULT 0,
    integral_a_to_b     REAL DEFAULT 0.0,
    integral_b_to_a     REAL DEFAULT 0.0,
    integral_samples    INTEGER DEFAULT 0,
    peak_high_a_to_b    INTEGER DEFAULT 0,
    peak_low_a_to_b     INTEGER DEFAULT 0,
    peak_high_b_to_a    INTEGER DEFAULT 0,
    peak_low_b_to_a     INTEGER DEFAULT 0,
    arc_phase           TEXT DEFAULT 'stable',
    interaction_count   INTEGER DEFAULT 0,
    weight              REAL DEFAULT 0.5,
    last_referenced_at  TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(colony_id, pawn_a_id, pawn_b_id)
);
```

### `opinion_samples` — For Computing Integrals

```sql
CREATE TABLE opinion_samples (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    relationship_id INTEGER NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
    opinion_a_to_b  INTEGER,
    opinion_b_to_a  INTEGER,
    game_tick       INTEGER,
    sampled_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_opinion_samples_rel ON opinion_samples(relationship_id, game_tick DESC);
```

### `interactions` — Chat Sessions

```sql
CREATE TABLE interactions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    colony_id           INTEGER NOT NULL REFERENCES colonies(id),
    memory_id           INTEGER REFERENCES memories(id),
    player_pawn_id      INTEGER REFERENCES pawns(id),
    npc_pawn_id         INTEGER REFERENCES pawns(id),
    npc_name            TEXT,
    npc_faction          TEXT,
    interaction_type    TEXT NOT NULL,
    situation_summary   TEXT,
    outcome             TEXT,
    outcome_details     TEXT,           -- JSON
    opinion_delta       INTEGER DEFAULT 0,
    relationship_delta  INTEGER DEFAULT 0,
    extracted_keywords  TEXT,           -- JSON array
    narrative_summary   TEXT,
    game_tick           INTEGER,
    started_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at            TIMESTAMP
);
```

### `interaction_messages` — Chat Exchanges

```sql
CREATE TABLE interaction_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    interaction_id  INTEGER NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
    turn_number     INTEGER NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    sentiment       REAL,
    mood_shift      INTEGER DEFAULT 0,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_interaction_msgs ON interaction_messages(interaction_id, turn_number);
```

### `narrative_threads` — Keyword Connections Across Events

```sql
CREATE TABLE narrative_threads (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    colony_id           INTEGER NOT NULL REFERENCES colonies(id),
    keyword             TEXT NOT NULL,
    category            TEXT,
    description         TEXT NOT NULL,
    source_interaction_id INTEGER REFERENCES interactions(id),
    source_memory_id    INTEGER REFERENCES memories(id),
    times_referenced    INTEGER DEFAULT 0,
    is_resolved         BOOLEAN DEFAULT 0,
    resolution_summary  TEXT,
    weight              REAL DEFAULT 0.6,
    decay_rate          REAL DEFAULT 0.03,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_referenced_at  TIMESTAMP
);

CREATE INDEX idx_narrative_keywords ON narrative_threads(colony_id, keyword);
CREATE INDEX idx_narrative_weight ON narrative_threads(colony_id, weight DESC);
```

### `prompt_log` — Audit Trail

```sql
CREATE TABLE prompt_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    colony_id           INTEGER NOT NULL REFERENCES colonies(id),
    request_type        TEXT NOT NULL,
    pawn_id             INTEGER REFERENCES pawns(id),
    prompt_text         TEXT,
    response_text       TEXT,
    memory_ids_used     TEXT,           -- JSON array
    tokens_used         INTEGER,
    duration_ms         INTEGER,
    game_tick           INTEGER,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### `schema_registry` — Mod Extension Tracking

```sql
CREATE TABLE schema_registry (
    mod_id      TEXT PRIMARY KEY,
    version     INTEGER DEFAULT 1,
    table_names TEXT,                   -- JSON array of table names this mod registered
    registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## API Framework for Modders

The bridge provides three services:

1. **A living database** — REST API for reading and writing weighted colony history
2. **Context assembly & prompt generation** — mod sends a generic object reference (event type + pawn IDs + framing), bridge queries DB, filters based on mod settings, and returns both structured JSON data AND a ready-to-use prompt
3. **A local AI proxy** — pass-through to LM Studio / Ollama

Mods send generic references, not raw SQL or prompt text. The bridge decides what data is relevant based on configurable settings, so each mod can tune behavior without writing bridge-side code.

All endpoints accept and return JSON. The bridge runs on `http://localhost:3001` by default.

### Data API — Colony & Pawns

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/colony/register` | Register or update a colony save |
| `GET`  | `/api/colony/{id}` | Get colony info |
| `POST` | `/api/pawn/register` | Register or update a pawn (with traits, skills) |
| `POST` | `/api/pawn/bulk` | Bulk register/update multiple pawns |
| `GET`  | `/api/pawn/{id}` | Get pawn identity (traits, skills, backstory) |
| `GET`  | `/api/pawns?colony_id=X` | List all pawns in a colony |

### Data API — Memory & History

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/memory/store` | Store a new memory/event |
| `GET`  | `/api/memory/query` | Query memories by pawn, type, weight, or tags |
| `POST` | `/api/memory/bump` | Bump weight on a memory (it was referenced) |
| `POST` | `/api/memory/decay` | Trigger a decay cycle for a colony |
| `DELETE`| `/api/memory/{id}` | Delete a memory |

### Data API — Relationships

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/relationship/update` | Create or update a pawn-to-pawn relationship |
| `GET`  | `/api/relationship/query` | Query relationships by pawn or weight |
| `POST` | `/api/relationship/sample` | Record an opinion sample (for integral computation) |

### Data API — Interactions & Threads

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/interaction/store` | Record a completed interaction/conversation |
| `POST` | `/api/interaction/message` | Append a message to an interaction |
| `GET`  | `/api/interaction/{id}` | Get full interaction with messages |
| `POST` | `/api/thread/store` | Create a narrative thread |
| `GET`  | `/api/threads?colony_id=X` | Get active threads (weighted, for prompt injection) |
| `POST` | `/api/thread/bump` | Bump a thread (it was referenced) |
| `POST` | `/api/thread/resolve` | Mark a thread as resolved |

### Schema Extension API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/schema/register` | Register mod-specific tables |
| `GET`  | `/api/schema/version?mod_id=X` | Check registered schema version |

### Context Assembly & Prompt Generation

The mod sends a **generic object reference** — an event type, source pawn, optional target, and framing text. The bridge does all the work: queries the DB for relevant data, filters based on mod settings, and returns both a **structured JSON package** (for mod logic) and a **ready-to-use prompt** (for direct LLM submission).

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/context/build` | Assemble DB context + generate prompt from generic reference |

```csharp
// Mod sends a simple, generic request:
POST /api/context/build
{
    "colony_id": 1,
    "event_type": "relationship",       // relationship/dialogue/reaction/event/quest
    "source_pawn": "Thing_Human123",     // who is this about
    "target_pawn": "Thing_Human456",     // optional: who are they interacting with
    "framing": "They argued over food rations after a raid",

    // Mod settings control what data gets included
    "settings": {
        "include_memories": true,
        "include_relationships": true,
        "include_traits": true,
        "include_backstory": true,
        "include_threads": true,
        "memory_limit": 5,
        "weight_threshold": 0.1,
        "max_response_tokens": 200
    }
}

// Bridge looks up everything, filters by settings, returns BOTH:
{
    // Structured data (for mod logic / UI)
    "data": {
        "colony": { "name": "New Hope", "biome": "Temperate Forest" },
        "source_pawn": {
            "name": "Engie", "traits": ["Kind", "Neurotic"],
            "backstory": "Urbworld urchin turned gunsmith",
            "top_memories": [
                {"summary": "Survived raid last quadrum", "weight": 0.72},
                {"summary": "Married Val in the garden", "weight": 0.65}
            ],
            "relationships": [
                {"with": "Fred", "type": "Rival", "opinion": -34, "integral": -28}
            ]
        },
        "target_pawn": {
            "name": "Fred", "traits": ["Greedy", "Tough"],
            "backstory": "Midworld soldier",
            "top_memories": [
                {"summary": "Hoarded food during toxic fallout", "weight": 0.68}
            ],
            "relationships": [
                {"with": "Engie", "type": "Rival", "opinion": -41, "integral": -35}
            ]
        },
        "active_threads": [
            {"keyword": "food_shortage", "description": "Colony nearly starved during fallout"}
        ]
    },

    // Ready-to-use prompt (built from the data above)
    "prompt": "You are Engie, a kind but neurotic gunsmith...[assembled from DB data]",

    // Metadata
    "tokens_estimated": 142,
    "memories_included": 3,
    "threads_included": 1
}
```

**The mod can use either output:**
- Use `data` for custom prompt templates or game logic
- Use `prompt` to send directly to the LLM proxy as-is
- Use both — send the prompt to the LLM, then use `data` to apply game effects

**Mod settings** are configurable per-call or via a global config endpoint, so each mod can tune what data gets included without changing bridge code.

### LLM Proxy (pass-through to LM Studio / Ollama)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/v1/models` | List loaded models (OpenAI-compatible) |
| `POST` | `/v1/chat/completions` | Forward a chat completion request |

### Example: How a Mod Uses Both Services

```csharp
// Step 1: Query the database for context
GET /api/pawn/5          → pawn identity, traits, backstory
GET /api/memory/query?pawn_id=5&limit=5  → top 5 weighted memories
GET /api/relationship/query?pawn_id=5    → key relationships
GET /api/threads?colony_id=1             → active narrative threads

// Step 2: Mod builds its own prompt from that data
string prompt = BuildMyPrompt(pawn, memories, relationships, threads);

// Step 3: Send through LLM proxy
POST /v1/chat/completions
{
    "model": "auto",
    "messages": [
        {"role": "system", "content": prompt},
        {"role": "user", "content": "Generate an event for this colony"}
    ]
}

// Step 4: Parse response and write results back
POST /api/memory/store
{
    "colony_id": 1,
    "pawn_id": 5,
    "memory_type": "event",
    "summary": "Engie started a fight with Val over food rations",
    "tags": ["conflict", "food"],
    "base_weight": 0.7
}
```

The bridge stores history and proxies AI. The mod does everything else.

---

## Schema Extension API

Mods can register their own tables via API. The bridge manages versioning and migrations.

```
POST /api/schema/register
{
    "mod_id": "rimsynapse_factions",
    "version": 1,
    "tables": [
        "CREATE TABLE IF NOT EXISTS factions (...)",
        "CREATE TABLE IF NOT EXISTS settlements (...)"
    ]
}
```

On upgrade (mod sends version 2 when DB has version 1):
```
POST /api/schema/register
{
    "mod_id": "rimsynapse_factions",
    "version": 2,
    "migrations": [
        "ALTER TABLE factions ADD COLUMN organization_level REAL DEFAULT 0.5"
    ]
}
```

The bridge:
1. Checks `schema_registry` for current mod version
2. Runs `tables` (with `IF NOT EXISTS`) or `migrations` as needed
3. Updates `schema_registry`

---

## Weight System & Prompt Retrieval

### Two tiers of data:

| Tier | Description | Prompt behavior |
|------|-------------|----------------|
| **Identity** | Pawn name, traits, backstory, skills | Always included (~100-200 tokens per pawn) |
| **Memory** | Events, dialogues, observations | Weighted retrieval — top N by weight until token budget fills |

### Weight lifecycle:

```
Created  → base_weight (e.g., 0.8 for a raid, 0.3 for trade)
         ↓
Decay    → weight -= decay_rate (each cycle)
         ↓
Bump     → weight += 0.2 when LLM references it
         ↓
Floor    → weight hits 0.05 → excluded from queries
```

### Prompt budget retrieval:

```sql
SELECT id, memory_type, summary, weight
FROM memories
WHERE colony_id = ?
  AND (pawn_id = ? OR pawn_id IS NULL)
  AND weight > 0.05
ORDER BY weight DESC
LIMIT 10;
```

The bridge iterates results, estimates tokens per summary (`len(summary) / 4`), and stops adding when the budget fills.

---

# Part 2: RimSynapse Mod Vision

> **Everything below is our mod's design vision.** These features are registered via the Schema Extension API and are NOT part of the core platform. They serve as a reference for future development and for other modders who want to build similar systems.

## Dynamic Pawn Psychology

### Trait Evolution
- Traits shouldn't be fully static — events should shape personality over time
- Example: a slave is less likely to rebel initially, but once they taste freedom, they resist harder
- A killer's initial remorse can fade into acceptance based on personality
- First-time events (first kill, first raid) carry significantly more weight than repeated ones (desensitization)

### Skill-Based Social Dynamics
- Highly skilled pawns develop pride, and potentially bigotry toward less capable pawns
- But if they are both highly capable AND kind, they are more likely to help and teach rather than despise
- Skill + trait combination determines social behavior

### Dynamic Nicknames
- Nicknames assigned dynamically based on repeated events
- If something keeps reminding people of an incident, it becomes their nickname
- Nickname changes propagate as world events

### Tables (registered by mod):
- `trait_modifiers` — amplify/suppress/invert/emerge traits based on events
- `nickname_history` — track nickname changes and reasons
- `pawn_roles` — leader/spiritual guide/warden with authority and reputation
- `pawn_snapshots` — periodic state captures for trend analysis
- `relationship_events` — dramatic relationship shifts with arc tracking
- `colony_culture` — emergent traditions, beliefs, taboos

## Faction & World Simulation

### Organization Level & Leadership
- Faction `organization_level` (0.0 anarchic raiders → 1.0 rigid empire) drives how 3-layer personality weights are computed
- Less organized factions follow individual leaders; organized factions follow doctrine
- Each settlement has a leader with personal personality that may conflict with faction directives

### Three-Layer Personality
Every settlement disposition is computed from three layers:
1. **Leader personality** — the individual's traits (dominant in low-org factions)
2. **Faction culture** — ideology, honor codes, aggression (dominant in high-org factions)
3. **Settlement populace** — local mood, desires, loyalty (fills remainder)

Weights are dynamically scaled by `organization_level`, never hardcoded.

### Strike Probability vs. Intensity
- Raiders: attack often (high probability) but with whatever's nearby (low intensity)
- Empire: rarely initiates (low probability) but commits fully when they do (high intensity)

### Perceived Status / Relative Slight
- How much an affront matters depends on how a faction views the offending party
- "Sure they ignored my summons, but they are just peasants anyway" → Empire doesn't care
- Perceived status is bidirectional and dynamic:
  - **Early game**: Small factions help you, raiders target you, Empire ignores you
  - **Mid game**: Nearby settlements view you as a threat, Empire still indifferent unless you hold rank
  - **Late game**: Empire pays attention, small factions fear you or seek protection

### Tables (registered by mod):
- `factions` — with organization_level, culture_tags, strike_probability/intensity
- `faction_relations` — inter-faction diplomacy with perceived_status and political capital
- `settlements` — individual bases with populace mood/aggression/loyalty
- `settlement_leaders` — leaders with 3-layer personality
- `world_events` — raids, trade, quests, overthrows, famines, refugees
- `goodwill_samples` — for computing faction political capital integrals

## Dynamic Chat Interactions

During in-game events (beggars, traders, refugees, envoys, prisoners), the player opens a live LLM-powered chat window. Conversations can have gameplay-changing outcomes:
- Convince beggars to join the colony
- Negotiate better trade deals
- Interrogate prisoners for information
- Diplomacy with faction envoys

All conversations are recorded with numeric outcomes and extracted keywords.

## Narrative Thread System

Keywords extracted from conversations become narrative breadcrumbs that connect events across time:

```
Day 5:  Beggars mention "mechanoid hive in the north"
        → keyword stored

Day 12: Trader visits → bridge finds matching thread
        → trader says "Yes, we lost a caravan to them"

Day 30: Quest: "Destroy mechanoid cluster" → bridge connects the dots
        → NPC says "You've heard the rumors — now we need action"
```

Thread categories: `threat`, `location`, `person`, `artifact`, `rumor`, `prophecy`

## Relationship Integrals & Political Capital

### Pawn Relationships
- Opinion at any moment is just the surface; the integral (accumulated sentiment over time) is the deep truth
- A pawn who felt -20 about someone for 60 days has deep-rooted resentment harder to move than a brief -80 spike
- The integral represents emotional inertia

### Faction Goodwill
- Sustained positive relations build political capital — a trust reservoir that buffers bad events
- **Natural tendency reset** (mod-side Harmony patch): if you maintain goodwill at a level for 1-2 years, the weighted average BECOMES the new natural tendency, replacing the game's hardcoded default
- Years of alliance → goodwill recovers toward earned baseline, not game default
- Years of war → single gift barely moves the needle

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | 2026-07-05 | Initial design document |
