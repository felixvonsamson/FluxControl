# congest.io

A browser-based puzzle game about managing electrical power grids. Your job is to prevent **line congestion** — power lines overloading beyond their capacity — by manipulating the network topology or adjusting power generation.

---

## Table of Contents

- [Game Overview](#game-overview)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
- [Backend](#backend)
- [Frontend](#frontend)
- [Level Format](#level-format)
- [API Reference](#api-reference)
- [Game Mechanics (deep dive)](#game-mechanics-deep-dive)

---

## Game Overview

Each level presents a power network: nodes (generators and consumers) connected by transmission lines. Power flows according to DC power flow equations (Kirchhoff's laws). If any line carries more power than its rated capacity, it is congested and the level is unsolved.

**Two tools are available to fix congestion:**

1. **Switches** — reconnect a line's endpoint to a "bus split" copy of the node, rerouting power through a different path in the network. Free to use.
2. **Redispatch** — increase or decrease the power injection at individual nodes. Costs in-game money; the network must remain balanced (sum of injections = 0) before you can confirm.

Solving a level for the first time unlocks the next one and rewards 50 coins. Each redispatch action costs coins deducted from your wallet.

There are **100 levels** of increasing complexity.

---

## Getting Started

### Prerequisites

- Python 3.12+
- Node.js 18+

### 1. Backend

```bash
# From the project root
python -m venv .venv          # already exists; skip if present
source .venv/bin/activate

pip install -r requirements.txt

uvicorn backend.main:app --reload
```

The API will be available at `http://127.0.0.1:8000`. The SQLite database (`game.db`) is created automatically on first run.

### 2. Frontend

```bash
cd frontend
npm install      # only needed once
npm run dev
```

Open the URL shown by Vite (typically `http://localhost:5173`). The dev server proxies all `/api` requests to the backend.

### First launch

You will be prompted to log in. Click **Sign Up** to create an account. Progress (current level, unlocked levels, money) is persisted in the database per user.

---

## Project Structure

```
congest.io/
├── backend/
│   ├── main.py          # FastAPI app, all route definitions
│   ├── network.py       # Power flow math, solver, level loading
│   ├── schemas.py       # Pydantic models (Node, Line, NetworkState, …)
│   ├── models.py        # SQLAlchemy Player model
│   ├── database.py      # SQLite engine and session factory
│   ├── auth.py          # Password hashing / verification
│   └── jwt_utils.py     # JWT creation and decoding
├── frontend/
│   ├── main.js          # Entry point: Three.js scenes, input handling, UI wiring
│   ├── index.html       # Shell HTML with all UI panels
│   ├── tutorial.html    # Standalone tutorial page
│   ├── styling.css
│   ├── config.js        # Visual constants (colors, sizes, …)
│   ├── network/
│   │   ├── createNetwork.js   # Build Three.js objects from network data
│   │   ├── updateNetwork.js   # Diff and redraw the scene; switch logic
│   │   └── powerFlow.js       # Client-side DC power flow (mirrors backend)
│   ├── ui/
│   │   ├── level_selection.js    # Level selection panel
│   │   ├── toggles.js            # UI toggle helpers
│   │   └── viewport_calculations.js  # Split-screen viewport math
│   ├── auth/
│   │   └── auth.js        # Login/signup UI, token storage, authHeaders()
│   ├── level_image_halper.js  # Render overview to PNG (press P)
│   └── vite.config.js     # Dev server config; proxies /api → :8000
├── levels/
│   └── Level1.json … Level100.json
├── saves/                 # Auto-saved network snapshots (dev artifact)
├── requirements.txt
└── Untitled.ipynb         # Scratch notebook used for power flow prototyping
```

---

## Architecture

```
Browser                          FastAPI (port 8000)
  │                                     │
  │  GET/POST /api/*                    │
  │ ─────────────────────────────────►  │
  │                                     ├─ JWT auth middleware
  │                                     ├─ network.py  (power flow, solver)
  │                                     ├─ models.py   (Player → SQLite)
  │  JSON response                      │
  │ ◄─────────────────────────────────  │
  │                                     │
  ├─ Three.js renders network           │
  ├─ Power flow recalculated locally    │
  │  on every switch toggle             │
  └─ Only calls backend to:            │
       • load / validate levels        │
       • check / save solutions        │
       • manage user accounts          │
```

Power flow is computed **both client-side** (for instant visual feedback on switch toggles) and **server-side** (for authoritative solution checking).

---

## Backend

### `network.py` — core engine

| Function | Description |
|---|---|
| `calculate_power_flow(network)` | DC power flow via Kirchhoff's laws. Builds incidence matrix A, solves `B·θ = p`, derives line flows `f = Aᵀ·θ`. Sets `network.cost` to sum of overloads. |
| `update_network(network, req)` | Applies a single switch action: splits a node into a "b" copy and reconnects the line endpoint to it, or reverts a split. |
| `solve_network(network)` | Best-first search solver. Tries every possible switch action, ranks states by overload cost, repeats up to 250 iterations. Returns a solved state or the best partial solution. |
| `generate_network(num_nodes)` | Generates a random planar network via Delaunay triangulation with force-directed layout. Used for dev/testing. |
| `load_level(level)` | Loads `levels/Level{n}.json`, resets all switches, calculates initial power flow. |

### `models.py` — Player

| Column | Type | Description |
|---|---|---|
| `id` | Integer PK | Auto-increment |
| `username` | String (unique) | Login name |
| `password_hash` | String | bcrypt hash |
| `current_level` | Integer | Last level the player was on |
| `unlocked_levels` | Integer | Highest level accessible |
| `money` | Integer | Coin balance |

### Data model

**Node**
```json
{
  "id": "0",
  "injection": 31.0,     // positive = generator, negative = consumer
  "x": 150.0,            // 2D position for rendering
  "y": 250.0,
  "cost_increase": 54,   // coins per unit to increase injection
  "cost_decrease": 18    // coins per unit to decrease injection
}
```

**Line**
```json
{
  "id": "L0-1",
  "from_node": "0",
  "to_node": "1",
  "flow": 0.0,           // computed by power flow; positive = from→to
  "limit": 50.0          // rated capacity; |flow| > limit = congestion
}
```

**Switch mechanics**: splitting node `"2"` creates a phantom node `"2b"` at the same position. A line reconnected to `"2b"` is isolated from the injection at `"2"`, effectively opening a busbar coupler. Re-toggling removes the `"b"` node when it has no other connections.

---

## Frontend

### Rendering

Two orthographic cameras share one `WebGLRenderer` using scissor/viewport splitting:

- **Main view** (right ~75% of screen): interactive, supports pan and scroll/pinch zoom.
- **Overview** (bottom-left corner): shows the full network at a fixed zoom; clicking it moves the main camera.

Nodes and lines are Three.js meshes. Animated particles travel along each line to indicate power flow direction and magnitude.

### Client-side power flow (`powerFlow.js`)

Mirrors the backend's `calculate_power_flow` using `ml-matrix` for linear algebra. Runs on every switch toggle so the visual feedback is instant without a round-trip.

### Auth (`auth/auth.js`)

JWT token stored in `sessionStorage`. `authHeaders()` returns the `Authorization: Bearer …` header used on all protected API calls. `ensureLoggedIn()` blocks rendering until a valid session exists.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `S` | Auto-solve the current network state (calls `/api/solve`) |
| `C` | Clear session storage and reload (reset to last saved state) |
| `P` | Render the overview scene to a PNG and download it |

---

## Level Format

Levels are JSON files in `/levels/Level{n}.json`:

```json
{
  "nodes": {
    "0": { "id": "0", "injection": 31.0, "x": 150.0, "y": 250.0,
           "cost_increase": 54, "cost_decrease": 18 }
  },
  "lines": {
    "L0-1": { "id": "L0-1", "from_node": "0", "to_node": "1",
              "flow": 0.0, "limit": 50.0 }
  },
  "cost": 0.0,
  "tutorial_info": "Optional hint string shown to the player."
}
```

- `injection` > 0 → generator; < 0 → consumer. All injections in a level must sum to zero.
- `limit` is the line's rated capacity. Congestion occurs when `|flow| > limit`.
- `tutorial_info` is displayed on Level 1 to guide new players.
- Line IDs follow the convention `L{from}-{to}` where node IDs are sorted numerically.

---

## API Reference

All endpoints are under the `/api` prefix. Protected endpoints require `Authorization: Bearer <token>`.

### Auth

| Method | Path | Auth | Body | Description |
|---|---|---|---|---|
| POST | `/api/register` | No | `{username, password}` | Create account, returns token + player data |
| POST | `/api/login` | No | `{username, password}` | Returns token + player data |
| GET | `/api/me` | Yes | — | Returns current player data |

### Game

| Method | Path | Auth | Body | Description |
|---|---|---|---|---|
| POST | `/api/load_level` | Yes | `{level_num}` | Load a level (must be unlocked). Updates `current_level`. |
| POST | `/api/check_solution` | Yes | `{network_data}` | Validate solution. Unlocks next level and grants reward if solved for first time. |
| POST | `/api/save_progress` | Yes | `{current_level, unlocked_levels}` | Persist player progress. |
| POST | `/api/solve` | No | `{network_data}` | Run the server-side auto-solver. Returns solved (or best-found) network state. |

### Player data shape (returned by auth/me endpoints)

```json
{
  "username": "alice",
  "current_level": 3,
  "unlocked_levels": 4,
  "money": 150
}
```

---

## Game Mechanics (deep dive)

### DC Power Flow

The physics model is a linearised DC power flow (standard in power systems):

1. Build an **incidence matrix** `A` (n×m): `A[i,l] = +1` if line `l` leaves node `i`, `-1` if it enters.
2. Compute the **susceptance Laplacian** `B = A·Aᵀ` (assuming unit reactance on all lines).
3. Fix node 0 as the slack bus, solve `B_red · θ = p_red` for voltage angles `θ`.
4. Compute line flows: `f = Aᵀ · θ`.

Overload cost = `Σ max(0, |f_l| - limit_l)` for all lines.

### Switch / Bus-split mechanic

Splitting a node models opening a **busbar coupler** in a real substation. Node `"2"` becomes two electrically independent busbars `"2"` and `"2b"`. Lines can be moved between them, changing which generators/consumers are electrically coupled at that substation.

### Redispatch

Adjusting a node's injection models **re-dispatching** generation or demand. The total injection must remain zero (energy balance). The cost is:

```
cost = Σ |Δp_i| × (cost_increase_i  if Δp_i > 0
                    cost_decrease_i  if Δp_i < 0)
```

This is deducted from the player's money when the redispatch is confirmed.

### Auto-solver

The solver (`solve_network`) uses a **best-first search** (min-heap ordered by overload cost):

1. Start with the current network state.
2. Generate all possible single-switch actions (each line has two switches: `from` and `to` end).
3. Compute power flow for each resulting state.
4. Push to the heap; pop the cheapest state and repeat.
5. Stop when cost = 0 (solved) or after 250 iterations.

Visited configurations (identified by the frozenset of line IDs) are tracked to avoid revisiting the same topology.
