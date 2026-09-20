"""
Island handling for lines opened at both ends ("dead lines").

Ported from the iOS app's IslandTests.swift. Run with `pytest test_islands.py`
or directly with `python test_islands.py`.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from backend.network import (
    calculate_power_flow,
    island_partition,
    resolve_dead_islands,
    update_network,
)
from backend.schemas import Line, NetworkState, Node, TopologyChangeRequest


def ring() -> NetworkState:
    """Level 1's shape: a balanced 4-cycle. 0(31) - 1(49) - 2(-90) - 3(10)."""
    nodes = {
        "0": Node(id="0", injection=31, x=150, y=250),
        "1": Node(id="1", injection=49, x=250, y=150),
        "2": Node(id="2", injection=-90, x=350, y=250),
        "3": Node(id="3", injection=10, x=250, y=350),
    }
    lines = {
        "L0-1": Line(id="L0-1", from_node="0", to_node="1"),
        "L0-3": Line(id="L0-3", from_node="0", to_node="3"),
        "L1-2": Line(id="L1-2", from_node="1", to_node="2"),
        "L2-3": Line(id="L2-3", from_node="2", to_node="3"),
    }
    return NetworkState(nodes=nodes, lines=lines)


def toggle(network: NetworkState, line_id: str, direction: str) -> NetworkState:
    return update_network(network, TopologyChangeRequest(line_id=line_id, direction=direction))


def dead_line() -> NetworkState:
    """L0-1 opened at both ends: floats on the phantom buses 0b and 1b."""
    state = ring()
    toggle(state, "L0-1", "from")
    toggle(state, "L0b-1", "to")
    return state


def main_split() -> NetworkState:
    """The cycle cut twice: {0, 3, 1b} vs {1, 2, 3b}."""
    state = ring()
    toggle(state, "L0-1", "to")
    toggle(state, "L2-3", "to")
    return state


def test_connected_grid_is_one_island():
    _, main_count = island_partition(ring())
    islands, _ = island_partition(ring())
    assert len(set(islands.values())) == 1
    assert main_count == 1


def test_line_opened_at_both_ends_is_a_dead_island():
    state = dead_line()
    # calculate_power_flow keeps its NaN semantics: the solver relies on it.
    assert math.isnan(calculate_power_flow(state).cost)

    islands, main_count = island_partition(state)
    assert len(set(islands.values())) == 2
    assert main_count == 1
    assert islands["0b"] == islands["1b"]
    assert islands["0"] != islands["0b"]

    resolved = resolve_dead_islands(state)
    assert resolved is not None
    assert resolved.lines["L0b-1b"].flow == 0
    assert abs(resolved.lines["L0-3"].flow - 31) < 1e-9
    assert abs(resolved.lines["L1-2"].flow - 49) < 1e-9
    assert abs(resolved.lines["L2-3"].flow + 41) < 1e-9
    assert resolved.cost == 0


def test_main_split_has_no_resolved_flows():
    state = main_split()
    assert math.isnan(calculate_power_flow(state).cost)

    islands, main_count = island_partition(state)
    assert len(set(islands.values())) == 2
    assert main_count == 2
    assert islands["0"] == islands["3"]
    assert islands["1"] == islands["2"]
    assert islands["0"] != islands["1"]
    assert islands["1b"] == islands["0"]
    assert islands["3b"] == islands["2"]

    assert resolve_dead_islands(state) is None


def test_resolving_a_connected_grid_matches_calculate_power_flow():
    direct = calculate_power_flow(ring())
    resolved = resolve_dead_islands(ring())
    assert resolved is not None
    for line_id, line in direct.lines.items():
        assert abs(resolved.lines[line_id].flow - line.flow) < 1e-12
    assert resolved.cost == direct.cost


def test_resolving_does_not_mutate_its_input():
    state = dead_line()
    before = state.model_dump()
    resolve_dead_islands(state)
    assert state.model_dump() == before


def test_fabricated_flows_are_not_trusted():
    """A disconnected submission with invented flows used to be accepted."""
    state = main_split()
    for line in state.lines.values():
        line.flow = 0.0
    state.cost = 0.0
    assert resolve_dead_islands(state) is None


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_")]
    for name, fn in tests:
        fn()
        print(f"ok  {name}")
    print(f"{len(tests)} passed")
