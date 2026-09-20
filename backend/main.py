from copy import deepcopy
import math
import json
import datetime
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, Depends, HTTPException
from fastapi.responses import JSONResponse, HTMLResponse
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from .network import (
    generate_network,
    resolve_dead_islands,
    update_network,
    solve_network,
    load_level,
    reset_all_switches,
    validate_network,
    get_or_create_daily_network,
    calculate_redispatch_cost,
    stars_for_redispatch_cost,
)
from .schemas import (
    ProgressUpdateRequest,
    TopologyChangeRequest,
    LoadLevelRequest,
    NetworkStateRequest,
    SwitchNodeRequest,
    ResetSwitchesRequest,
    dict_to_network_state,
    RegisterRequest,
    LoginRequest,
    rewardResponse,
    DailyProblemResponse,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi import APIRouter

from .database import Base, engine, SessionLocal
from .models import Player
from .auth import (
    hash_password,
    verify_password,
)
from .jwt_utils import (
    create_access_token,
    decode_access_token,
)

Base.metadata.create_all(bind=engine)

# Migrate existing DB: add columns if absent
from sqlalchemy import text as _text
with engine.connect() as _conn:
    for _col, _ddl in [
        ("daily_solved_date", "ALTER TABLE players ADD COLUMN daily_solved_date VARCHAR DEFAULT NULL"),
        ("daily_solved_count", "ALTER TABLE players ADD COLUMN daily_solved_count INTEGER DEFAULT 0"),
        ("daily_streak",       "ALTER TABLE players ADD COLUMN daily_streak INTEGER DEFAULT 0"),
        ("daily_stars",        "ALTER TABLE players ADD COLUMN daily_stars INTEGER DEFAULT 0"),
        ("level_stars",        "ALTER TABLE players ADD COLUMN level_stars VARCHAR DEFAULT '{}'"),
    ]:
        try:
            _conn.execute(_text(_ddl))
            _conn.commit()
        except Exception:
            pass  # column already exists

app = FastAPI()
router = APIRouter(prefix="/api")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/login")
# Same scheme, but tolerant of a missing token: endpoints that are playable
# without an account (the daily challenge) depend on this and get None for a
# guest instead of a 401.
oauth2_scheme_optional = OAuth2PasswordBearer(tokenUrl="/api/login", auto_error=False)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def get_current_player(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    payload = decode_access_token(token)
    if not payload or "sub" not in payload:
        raise HTTPException(status_code=401, detail="Invalid token")

    username = payload["sub"]
    player = db.query(Player).filter(Player.username == username).first()
    if not player:
        raise HTTPException(status_code=401, detail="User not found")

    return player


def get_optional_player(
    token: Optional[str] = Depends(oauth2_scheme_optional),
    db: Session = Depends(get_db),
):
    """Resolve the player if a valid token is present, else None (guest).
    Never raises on a missing/invalid token — the caller decides what a
    guest is allowed to see."""
    if not token:
        return None
    payload = decode_access_token(token)
    if not payload or "sub" not in payload:
        return None
    return db.query(Player).filter(Player.username == payload["sub"]).first()


@router.post("/register")
def register(data: RegisterRequest, db: Session = Depends(get_db)):
    existing = db.query(Player).filter(Player.username == data.username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists")

    player = Player(
        username=data.username,
        password_hash=hash_password(data.password),
    )
    db.add(player)
    db.commit()
    db.refresh(player)

    token = create_access_token({"sub": player.username})

    return {
        "access_token": token,
        "token_type": "bearer",
        "player": player.package_data()
    }

@router.post("/login")
def login(data: LoginRequest, db: Session = Depends(get_db)):
    player = db.query(Player).filter(Player.username == data.username).first()
    if not player or not verify_password(data.password, player.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_access_token({"sub": player.username})

    return {
        "access_token": token,
        "token_type": "bearer",
        "player": player.package_data()
    }


@router.post("/save_progress")
def save_progress(
    data: ProgressUpdateRequest,
    player: Player = Depends(get_current_player),
    db: Session = Depends(get_db),
):
    player.current_level = data.current_level
    player.unlocked_levels = data.unlocked_levels

    db.commit()
    return {"status": "ok"}

@router.get("/me")
def get_me(player: Player = Depends(get_current_player)):
    return player.package_data()

@router.delete("/delete_account")
def delete_account(
    player: Player = Depends(get_current_player),
    db: Session = Depends(get_db),
):
    # App Store 5.1.1(v): account-creating apps must let users delete their
    # account from within the app. The Player row is self-contained (no
    # related tables), so a single delete fully erases the account.
    db.delete(player)
    db.commit()
    return {"status": "ok"}

@router.get("/leaderboard")
def leaderboard(player: Player = Depends(get_current_player), db: Session = Depends(get_db)):
    players = db.query(Player).order_by(Player.daily_streak.desc(), Player.money.desc()).all()
    return [p.package_data() for p in players]

@router.post("/check_solution", response_model=rewardResponse)
def check_solution(
    data: NetworkStateRequest,
    player: Player = Depends(get_current_player),
    db: Session = Depends(get_db),
):
    """
    Check a player's solution and reward them if they solved a new level.
    Validates that the submitted topology is a legal derivative of the original level
    (same base nodes and injections, only switch moves applied).
    """
    network = dict_to_network_state(data.network_data)

    try:
        validate_network(network)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if network.level is None:
        raise HTTPException(status_code=400, detail="Network has no level set")

    # Bind the level now: calculate_power_flow() rebinds `network` below, which
    # would discard the narrowing this guard just established.
    level = network.level

    # Verify the topology is a legal derivative of the original level
    original = load_level(level)
    submitted_reset = reset_all_switches(deepcopy(network))
    adjustments = network.redispatch.get("adjustments", {})
    original_nodes = {nid: (n.injection, n.x, n.y) for nid, n in original.nodes.items()}
    submitted_nodes = {
        nid: (n.injection - adjustments.get(nid, 0), n.x, n.y)
        for nid, n in submitted_reset.nodes.items()
    }
    original_lines = set(original.lines.keys())
    submitted_lines = set(submitted_reset.lines.keys())
    if original_nodes != submitted_nodes or original_lines != submitted_lines:
        raise HTTPException(status_code=400, detail="Submitted network does not match original level")

    # A main split (base buses on more than one island) has no well-defined
    # flows, so it can never be a solution. Never fall back to client flows.
    resolved = resolve_dead_islands(network)
    if resolved is None:
        return rewardResponse(
            solved=False,
            player=player.package_data(),
            reward=0,
            redispatch_cost=calculate_redispatch_cost(network),
            stars=None,
        )
    network = resolved

    all_lines_within_capacity = all(
        abs(line.flow) <= line.limit for line in network.lines.values()
    )

    redispatch_cost = calculate_redispatch_cost(network)

    reward = 0
    stars = None
    # If the player completed a new level, unlock the next level
    if all_lines_within_capacity:
        if player.unlocked_levels == player.current_level:
            player.unlocked_levels += 1
            reward = 50  # Reward for completing the level
        player.money += reward - round(redispatch_cost)

        level_stars = player.get_level_stars()
        stars = max(level_stars.get(level, 0), stars_for_redispatch_cost(redispatch_cost))
        level_stars[level] = stars
        player.set_level_stars(level_stars)

        db.commit()

    return rewardResponse(
        solved=all_lines_within_capacity,
        player=player.package_data(),
        reward=reward,
        redispatch_cost=redispatch_cost,
        stars=stars,
    )


@router.post("/solve")
def solve_net(
    data: NetworkStateRequest,
    player: Player = Depends(get_current_player),
):
    network = dict_to_network_state(data.network_data)
    try:
        validate_network(network)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    network = solve_network(network)
    return network


# @router.post("/save_network")
# def save_network(network: dict):
#     os.makedirs("saves", exist_ok=True)
#     timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
#     filepath = f"saves/network_{timestamp}.json"
#     with open(filepath, "w") as f:
#         json.dump(network, f)
#     return {"status": "Network saved", "file": filepath}

# # CAREFUL: THIS IS UNSAFE SINCE ANY FILE PATH CAN BE GIVEN
# @router.post("/load_network")
# def load_network(file_path: str):
#     network = update_network_from_file(file_path)
#     network = calculate_power_flow(network)
#     return network


@router.post("/load_level")
def load_level_endpoint(
    data: LoadLevelRequest,
    player: Player = Depends(get_current_player),
    db: Session = Depends(get_db),
):
    if data.level_num > player.unlocked_levels:
        raise HTTPException(
            status_code=403,
            detail="Level not unlocked",
        )

    # Load the level
    network = load_level(data.level_num)

    # Update current level if progressing
    player.current_level = data.level_num
    db.commit()

    return network


def _generated_network_files():
    return sorted(Path("generated_networks").glob("network_*.json"))


@router.get("/daily_problem", response_model=DailyProblemResponse)
def daily_problem(player: Optional[Player] = Depends(get_optional_player)):
    # Playable without an account (App Store 5.1.1(v)): the puzzle itself is
    # a non-account feature. A guest simply never has `already_solved` set —
    # streaks and the leaderboard remain account-only.
    network = get_or_create_daily_network()
    today = datetime.date.today().isoformat()
    already_solved = player is not None and player.daily_solved_date == today
    return DailyProblemResponse(
        network=network.model_dump(),
        already_solved=already_solved,
    )


@router.post("/check_daily_solution", response_model=rewardResponse)
def check_daily_solution(
    data: NetworkStateRequest,
    player: Player = Depends(get_current_player),
    db: Session = Depends(get_db),
):
    network = dict_to_network_state(data.network_data)

    try:
        validate_network(network)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Validate topology against today's daily network
    original = get_or_create_daily_network()
    submitted_reset = reset_all_switches(deepcopy(network))
    adjustments = network.redispatch.get("adjustments", {})
    original_nodes = {nid: (n.injection, n.x, n.y) for nid, n in original.nodes.items()}
    submitted_nodes = {
        nid: (n.injection - adjustments.get(nid, 0), n.x, n.y)
        for nid, n in submitted_reset.nodes.items()
    }
    if original_nodes != submitted_nodes or set(original.lines.keys()) != set(submitted_reset.lines.keys()):
        raise HTTPException(status_code=400, detail="Submitted network does not match today's daily problem")

    resolved = resolve_dead_islands(network)
    if resolved is None:
        return rewardResponse(
            solved=False,
            player=player.package_data(),
            reward=0,
            redispatch_cost=calculate_redispatch_cost(network),
            stars=None,
        )
    network = resolved
    all_lines_ok = all(abs(line.flow) <= line.limit for line in network.lines.values())

    today = datetime.date.today().isoformat()
    reward = 0
    redispatch_cost = 0.0
    stars = None
    if all_lines_ok:
        redispatch_cost = calculate_redispatch_cost(network)
        prev_stars = player.daily_stars or 0 if player.daily_solved_date == today else 0
        stars = max(prev_stars, stars_for_redispatch_cost(redispatch_cost))
        player.daily_stars = stars

        if player.daily_solved_date != today:
            yesterday = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
            if player.daily_solved_date == yesterday:
                player.daily_streak = (player.daily_streak or 0) + 1
            else:
                player.daily_streak = 1
            player.daily_solved_date = today
            player.daily_solved_count = (player.daily_solved_count or 0) + 1
            reward = 50
            player.money += reward

        db.commit()

    return rewardResponse(
        solved=all_lines_ok,
        player=player.package_data(),
        reward=reward,
        redispatch_cost=redispatch_cost,
        stars=stars,
    )


@router.get("/generated_network/count")
def generated_network_count(player: Player = Depends(get_current_player)):
    return {"count": len(_generated_network_files())}


@router.get("/generated_network/{index}")
def get_generated_network(index: int, player: Player = Depends(get_current_player)):
    files = _generated_network_files()
    if not files:
        raise HTTPException(status_code=404, detail="No generated networks available")
    with open(files[index % len(files)]) as f:
        data = json.load(f)
    return dict_to_network_state(data)


@app.get("/privacy", response_class=HTMLResponse)
def privacy_policy():
    return """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Privacy Policy — Flux Control</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           max-width: 680px; margin: 60px auto; padding: 0 24px;
           color: #1a1a1a; line-height: 1.6; }
    h1 { font-size: 1.6rem; margin-bottom: 0.25em; }
    h2 { font-size: 1.1rem; margin-top: 2em; }
    p, li { font-size: 0.95rem; }
    a { color: #0066cc; }
    .muted { color: #666; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p class="muted">Flux Control &mdash; Last updated July 2026</p>

  <p>Flux Control is a power-grid puzzle game. This policy describes what data
  we collect, why, and how you can request deletion.</p>

  <h2>What we collect</h2>
  <ul>
    <li><strong>Username and hashed password</strong> — required to create an
        account. We never store your password in plain text.</li>
    <li><strong>Gameplay data</strong> — your current level, solved levels,
        coin balance, daily challenge history, and streak count. This data
        exists solely to save your progress and display the leaderboard.</li>
  </ul>

  <p>We do <strong>not</strong> collect your name, email address, phone
  number, location, device identifiers, or any data for advertising or
  analytics purposes. There are no third-party SDKs in the app.</p>

  <h2>How we use it</h2>
  <p>Your data is used only to run the game: authenticate you, restore your
  progress across sessions, and calculate leaderboard rankings. It is not
  sold, shared with third parties, or used for any purpose outside the
  game.</p>

  <h2>Where it is stored</h2>
  <p>Account and progress data is stored on our server at
  <a href="https://fluxcontrol.eu">fluxcontrol.eu</a>. Your authentication
  token is stored locally on your device.</p>

  <h2>Data retention and deletion</h2>
  <p>Your account and all associated data are retained for as long as the
  service is running. To request deletion of your account and data, email
  <a href="mailto:felixvonsamson@gmail.com">felixvonsamson@gmail.com</a> with the
  subject line "Flux Control account deletion" and your username. We will
  delete your account within 30 days.</p>

  <h2>Children</h2>
  <p>The game is rated 4+ and is suitable for all ages. We do not knowingly
  collect data from children under 13 beyond what is described above (a
  username and gameplay progress), and we do not use that data for any
  purpose other than running the game.</p>

  <h2>Changes</h2>
  <p>If this policy changes materially, we will update the date at the top of
  this page. Continued use of the app after a change constitutes acceptance
  of the updated policy.</p>

  <h2>Contact</h2>
  <p><a href="mailto:felixvonsamson@gmail.com">felixvonsamson@gmail.com</a></p>
</body>
</html>"""


@app.get("/.well-known/apple-app-site-association")
def apple_app_site_association():
    return JSONResponse(
        content={
            "webcredentials": {
                "apps": ["776YBR3ZGA.mglst.Flux-Control"]
            }
        },
        media_type="application/json",
    )

app.include_router(router)
