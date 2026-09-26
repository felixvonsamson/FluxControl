"""
Coin settlement in POST /api/check_solution (issue #12). Run with
`pytest test_check_solution_money.py`.

The power flow is stubbed so that the unmodified level counts as solved at a
fixed redispatch cost; what is under test is how the balance moves.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from backend import main
from backend.database import Base
from backend.models import Player
from backend.network import SOLVE_REWARD, load_level
from backend.schemas import NetworkStateRequest

LEVEL = 1
COST = 7


@pytest.fixture(autouse=True)
def solved_at_fixed_cost(monkeypatch):
    def all_lines_ok(network):
        for line in network.lines.values():
            line.flow = 0
        return network

    monkeypatch.setattr(main, "resolve_dead_islands", all_lines_ok)
    monkeypatch.setattr(main, "calculate_redispatch_cost", lambda network: COST)


def make_db(money: int, unlocked_levels: int) -> tuple[Session, Player]:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(bind=engine)
    db = Session(engine)
    player = Player(
        username="p",
        password_hash="x",
        money=money,
        unlocked_levels=unlocked_levels,
        current_level=LEVEL,
    )
    db.add(player)
    db.commit()
    return db, player


def submit(db: Session, player: Player):
    data = NetworkStateRequest(network_data=load_level(LEVEL).model_dump())
    return main.check_solution(data, player=player, db=db)


def test_first_solve_pays_reward_once_and_charges_redispatch_once():
    db, player = make_db(money=100, unlocked_levels=LEVEL)
    response = submit(db, player)
    assert response.solved
    assert (response.reward, response.redispatch_cost) == (SOLVE_REWARD, COST)
    assert player.money == 100 + SOLVE_REWARD - COST
    assert player.unlocked_levels == LEVEL + 1


def test_re_solve_is_free():
    db, player = make_db(money=100, unlocked_levels=LEVEL + 1)
    response = submit(db, player)
    assert response.solved
    assert (response.reward, response.redispatch_cost) == (0, 0)
    assert player.money == 100


def test_redispatch_cannot_be_paid_from_the_reward():
    db, player = make_db(money=COST - 1, unlocked_levels=LEVEL)
    with pytest.raises(HTTPException):
        submit(db, player)
