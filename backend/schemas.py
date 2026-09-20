from pydantic import BaseModel
from typing import List, Optional
import json
import os


class Node(BaseModel):
    id: str
    injection: float = 0.0
    x: float = 0.0
    y: float = 0.0


class Line(BaseModel):
    # TODO: add from_bus and to_bus
    id: str
    from_node: str
    to_node: str
    flow: float = 0.0
    limit: float = 50.0


class NetworkState(BaseModel):
    nodes: dict[str, Node]
    lines: dict[str, Line]
    cost: float = 10**6
    redispatch: dict = {
        "cost": 0.0,
        "unbalance": 0.0,
        "adjustments": {}
    }
    level: Optional[int] = None
    tutorial_info: Optional[str] = None
    difficulty: Optional[str] = None

    def __lt__(self, other):
        return self.cost < other.cost


class TopologyChangeRequest(BaseModel):
    line_id: str
    direction: str  # "to" or "from"

class LoadLevelRequest(BaseModel):
    level_num: int

class NetworkStateRequest(BaseModel):
    network_data: dict

class SwitchNodeRequest(BaseModel):
    network_data: dict
    switch_id: str

class ResetSwitchesRequest(BaseModel):
    network_data: dict
    node_id: str


def update_network_from_file(file_path: str) -> NetworkState:
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File {file_path} does not exist.")
    with open(file_path, "r") as f:
        data = json.load(f)
    nodes = {
        node_id: Node(**node_data)
        for node_id, node_data in data.get("nodes", {}).items()
    }
    lines = {
        line_id: Line(**line_data)
        for line_id, line_data in data.get("lines", {}).items()
    }
    level = None if "Level" not in file_path else int(file_path.split("Level")[-1].split(".")[0])
    return NetworkState(
        nodes=nodes,
        lines=lines,
        level=level,
        tutorial_info=data.get("tutorial_info", None),
        difficulty=data.get("difficulty", None),
        )

def dict_to_network_state(data: dict) -> NetworkState:
    nodes = {
        node_id: Node(**node_data)
        for node_id, node_data in data.get("nodes", {}).items()
    }
    lines = {
        line_id: Line(**line_data)
        for line_id, line_data in data.get("lines", {}).items()
    }
    return NetworkState(
        nodes=nodes,
        lines=lines,
        cost=data.get("cost", 10**6),
        redispatch=data.get("redispatch", {"cost": 0.0, "unbalance": 0.0, "adjustments": {}}),
        level=data.get("level", None),
        tutorial_info=data.get("tutorial_info", None),
        difficulty=data.get("difficulty", None),
        )

class RegisterRequest(BaseModel):
    username: str
    password: str

class LoginRequest(BaseModel):
    username: str
    password: str

class ProgressUpdateRequest(BaseModel):
    current_level: int
    unlocked_levels: int

class rewardResponse(BaseModel):
    solved: bool
    player: dict
    reward: int
    redispatch_cost: int = 0
    stars: Optional[int] = None

class DailyProblemResponse(BaseModel):
    network: dict
    already_solved: bool
