from datetime import datetime

from sqlalchemy.orm import Session

from .models import LevelStats, Player

# The count is client-reported, so it only needs to be sane, not trusted.
MAX_SWITCH_DELTA = 500


def record_level_switches(db: Session, player: Player, level: int, delta: int, solved: bool) -> None:
    """Add `delta` switch flips to the player's tally for `level`, and close the
    tally if the level was just solved without redispatch. A closed tally is
    frozen: later switching and re-solves never change it. Does not commit."""
    if not 1 <= level <= player.unlocked_levels:
        return
    row = (
        db.query(LevelStats)
        .filter(LevelStats.player_id == player.id, LevelStats.level == level)
        .first()
    )
    if row is None:
        row = LevelStats(player_id=player.id, level=level, switch_count=0)
        db.add(row)
    if row.solved_at is not None:
        return
    now = datetime.utcnow()
    row.switch_count += max(0, min(delta, MAX_SWITCH_DELTA))
    row.updated_at = now
    if solved:
        row.solved_at = now
