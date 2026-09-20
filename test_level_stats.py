"""
Difficulty telemetry (backend/level_stats.py). Run with `pytest test_level_stats.py`.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from backend.database import Base
from backend.level_stats import MAX_SWITCH_DELTA, record_level_switches
from backend.models import LevelStats, Player


def make_db(unlocked_levels: int = 5) -> tuple[Session, Player]:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(bind=engine)
    db = Session(engine)
    player = Player(username="p", password_hash="x", unlocked_levels=unlocked_levels)
    db.add(player)
    db.commit()
    return db, player


def row(db: Session, player: Player, level: int) -> LevelStats | None:
    return db.query(LevelStats).filter_by(player_id=player.id, level=level).first()


def test_accumulates_across_visits_until_solved():
    db, player = make_db()
    record_level_switches(db, player, 3, 50, solved=False)  # first visit, gave up
    record_level_switches(db, player, 3, 30, solved=True)   # later visit, solved
    r = row(db, player, 3)
    assert r is not None and r.switch_count == 80 and r.solved_at is not None


def test_closed_tally_is_frozen():
    db, player = make_db()
    record_level_switches(db, player, 3, 10, solved=True)
    record_level_switches(db, player, 3, 99, solved=False)
    record_level_switches(db, player, 3, 99, solved=True)
    r = row(db, player, 3)
    assert r is not None and r.switch_count == 10


def test_unsolved_row_stays_open():
    """A redispatch solve calls with solved=False: the tally keeps counting."""
    db, player = make_db()
    record_level_switches(db, player, 3, 50, solved=False)
    r = row(db, player, 3)
    assert r is not None and r.solved_at is None


def test_levels_are_independent():
    db, player = make_db()
    record_level_switches(db, player, 2, 7, solved=True)
    record_level_switches(db, player, 3, 4, solved=False)
    r2, r3 = row(db, player, 2), row(db, player, 3)
    assert r2 is not None and r3 is not None
    assert (r2.switch_count, r3.switch_count) == (7, 4)


def test_locked_level_is_ignored():
    db, player = make_db(unlocked_levels=2)
    record_level_switches(db, player, 3, 10, solved=False)
    record_level_switches(db, player, 0, 10, solved=False)
    assert db.query(LevelStats).count() == 0


def test_delta_is_clamped():
    db, player = make_db()
    record_level_switches(db, player, 1, 10**9, solved=False)
    record_level_switches(db, player, 1, -5, solved=False)
    r = row(db, player, 1)
    assert r is not None and r.switch_count == MAX_SWITCH_DELTA


if __name__ == "__main__":
    import pytest
    sys.exit(pytest.main([__file__]))
