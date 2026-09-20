from datetime import datetime
from typing import Optional
import json

from sqlalchemy import ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class Player(Base):
    __tablename__ = "players"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    username: Mapped[str] = mapped_column(unique=True, index=True)
    password_hash: Mapped[str] = mapped_column()

    current_level: Mapped[int] = mapped_column(default=1)
    unlocked_levels: Mapped[int] = mapped_column(default=1)

    money: Mapped[int] = mapped_column(default=100)

    # ISO date string (e.g. "2026-07-01") of the last daily problem solved
    daily_solved_date: Mapped[Optional[str]] = mapped_column(default=None)
    daily_solved_count: Mapped[int] = mapped_column(default=0)
    daily_streak: Mapped[int] = mapped_column(default=0)
    # Best star rating (1-3) earned on the daily problem matching daily_solved_date
    daily_stars: Mapped[int] = mapped_column(default=0)

    # JSON-serialized {level_num: stars} map of the best stars ever earned per level
    level_stars: Mapped[str] = mapped_column(default="{}")

    def get_level_stars(self):
        try:
            return {int(k): v for k, v in json.loads(self.level_stars or "{}").items()}
        except (ValueError, TypeError):
            return {}

    def set_level_stars(self, level_stars: dict):
        self.level_stars = json.dumps(level_stars)

    def total_stars(self):
        return sum(self.get_level_stars().values())

    def package_data(self):
        return {
            "username": self.username,
            "current_level": self.current_level,
            "unlocked_levels": self.unlocked_levels,
            "money": self.money,
            "daily_solved_date": self.daily_solved_date,
            "daily_solved_count": self.daily_solved_count or 0,
            "daily_streak": self.daily_streak or 0,
            "daily_stars": self.daily_stars or 0,
            "level_stars": self.get_level_stars(),
            "total_stars": self.total_stars(),
        }


class LevelStats(Base):
    """Difficulty telemetry: switches a player flipped on a career level,
    accumulated across visits until the level is solved without redispatch.
    Once solved_at is set the row is frozen."""
    __tablename__ = "level_stats"
    __table_args__ = (UniqueConstraint("player_id", "level"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), index=True)
    level: Mapped[int] = mapped_column()
    switch_count: Mapped[int] = mapped_column(default=0)
    solved_at: Mapped[Optional[datetime]] = mapped_column(default=None)
    updated_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)
