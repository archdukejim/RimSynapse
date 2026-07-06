# RimSynapse Bridge

A portable Python bridge server that provides two services for RimWorld modders:

1. **A Living Database** — REST API backed by SQLite for tracking colony history, pawn identity, weighted memories, relationships, interactions, and narrative threads
2. **A Local AI Proxy** — pass-through to LM Studio / Ollama so mods can make LLM calls without managing connections

The bridge also provides **context assembly** — mods send a generic object reference (event type + pawn IDs + framing), and the bridge queries the database, filters by mod-configurable settings, and returns both structured JSON data and a ready-to-use prompt.

> **See [docs/DESIGN.md](docs/DESIGN.md) for the full design document** — architecture, database schema, API reference, and mod vision.

---

## Quick Start (Windows)

1. Download and extract this repository.
2. Double-click **[launch.bat](launch.bat)**.
3. On first run it will:
   - Download portable Python 3.12 (~15 MB, one-time)
   - Install dependencies into a local `lib/` directory
   - Generate a localhost SSL certificate (click **Yes** to trust it)
4. The bridge starts on `https://localhost:3001` and opens the dashboard.

**No prerequisites required.** No Python install, no Node.js, no admin rights.

---

## Linking with RimWorld

### One-Click (Recommended)
1. Close RimWorld (or restart it after linking).
2. Open the dashboard at `https://localhost:3001`.
3. Click **Link Mod Settings** in the sidebar.

### Manual Configuration
In RimWorld mod settings, set:
- **API Endpoint**: `https://localhost:3001/v1`
- **API Key**: `rimsynapse-bridge`
- **Model Name**: `auto` (bridge maps to your loaded model)

---

## API Overview

All endpoints accept and return JSON. Full reference in [docs/DESIGN.md](docs/DESIGN.md).

### Data API

| Group | Endpoints | Description |
|-------|-----------|-------------|
| Colony | `POST /api/colony/register`, `GET /api/colony/{id}` | Register and query colony saves |
| Pawns | `POST /api/pawn/register`, `GET /api/pawn/{id}`, `GET /api/pawns?colony_id=X` | Pawn identity with traits and skills |
| Memory | `POST /api/memory/store`, `GET /api/memory/query`, `POST /api/memory/bump`, `POST /api/memory/decay` | Weighted event history |
| Relationships | `POST /api/relationship/update`, `GET /api/relationship/query`, `POST /api/relationship/sample` | Pawn-to-pawn with integral tracking |
| Interactions | `POST /api/interaction/store`, `POST /api/interaction/message`, `GET /api/interaction/{id}` | Conversation records |
| Threads | `POST /api/thread/store`, `GET /api/threads?colony_id=X`, `POST /api/thread/bump`, `POST /api/thread/resolve` | Narrative keyword connections |

### Context Assembly

```
POST /api/context/build
{
    "colony_id": 1,
    "event_type": "relationship",
    "source_pawn": "Thing_Human_1",
    "target_pawn": "Thing_Human_2",
    "framing": "They argued over food rations after a raid",
    "settings": { "include_memories": true, "memory_limit": 5 }
}
```

Returns both structured data and a generated prompt ready for LLM submission.

### Schema Extension

Mods can register their own database tables at runtime:

```
POST /api/schema/register
{
    "mod_id": "my_mod_factions",
    "version": 1,
    "tables": ["CREATE TABLE IF NOT EXISTS factions (...)"]
}
```

### LLM Proxy

| Endpoint | Description |
|----------|-------------|
| `GET /v1/models` | List loaded models (OpenAI-compatible) |
| `POST /v1/chat/completions` | Forward chat completion to LM Studio / Ollama |

---

## Architecture

```
+------------------+   JSON    +------------------+  proxy   +----------+
|  Any RimWorld    | --------> |  RimSynapse      | -------> | LM Studio|
|  Mod (C#)        |           |  Bridge (Python)  |          | / Ollama |
|                  | <-------- |                  | <------- | (Local)  |
|  - Queries DB    |  response |  - REST API      |  LLM out +----------+
|  - Builds prompt |           |  - SQLite DB     |
|  - Parses output |           |  - LLM proxy     |
|  - Writes back   |           |  - Weight decay   |
+------------------+           +------------------+
```

## Project Structure

```
rimsynapse/
├── server.py              # Flask server — LLM proxy + API endpoints
├── database.py            # SQLite living database (12 core tables)
├── requirements.txt       # Python dependencies
├── launch.bat             # Portable launcher (auto-downloads Python)
├── setup-certs.ps1        # SSL certificate generator
├── config.json            # Runtime settings (git-ignored)
├── data/                  # SQLite database files (git-ignored)
├── docs/
│   └── DESIGN.md          # Full design document
└── public/
    ├── index.html         # Dashboard
    ├── style.css          # Dashboard styling
    └── app.js             # Dashboard scripting
```

---

## Database

The bridge uses a self-initializing SQLite database with 12 core tables:

- **Identity**: `colonies`, `pawns`, `pawn_traits`, `pawn_skills`
- **Memory**: `memories`, `relationships`, `opinion_samples`
- **Interactions**: `interactions`, `interaction_messages`, `narrative_threads`
- **Operational**: `prompt_log`, `schema_registry`

On every startup, the bridge verifies all tables exist and runs any pending schema migrations automatically. Mods can extend the schema at runtime via the extension API.

---

## Troubleshooting

**LM Studio connection offline**
- Ensure LM Studio is running with Local Server enabled (default port 1234)
- If authentication is enabled, enter your API key in the dashboard

**Certificate warning in browser**
- Run `setup-certs.ps1` again and click **Yes** to trust the certificate

**Database issues**
- Delete `data/rimsynapse.db` to reset — the bridge will recreate it on next launch
