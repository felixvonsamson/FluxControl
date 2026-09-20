import math
import random
import time
import logging
import datetime
from .schemas import (
    NetworkState,
    TopologyChangeRequest,
    Node,
    Line,
    update_network_from_file,
    dict_to_network_state,
)
import numpy as np
import heapq
import json
from copy import deepcopy
from collections import deque
from pathlib import Path

logger = logging.getLogger(__name__)

# --- Generator / solver constants ---

# Flow target when scaling injections: max flow will be set to this % of DEFAULT_LINE_LIMIT.
# Must be > DEFAULT_LINE_LIMIT to guarantee at least one overloaded line.
SCALING_TARGET = 54

# Minimum max-flow before scaling is considered meaningful. Below this the
# scaling factor becomes extreme (> 1.8×) and produces unrealistic injections.
MIN_MAX_FLOW_BEFORE_SCALING = 30

# Fraction of edges kept after pruning the Delaunay triangulation.
EDGE_REDUCTION_FACTOR = 0.85

# Fraction of highest-degree nodes whose edges are never pruned.
HIGH_DEGREE_NODE_FACTOR = 0.1

# Capacity limit assigned to every line (MW).
DEFAULT_LINE_LIMIT = 50.0

# Hard wall-clock timeout for the solver (seconds).
SOLVER_TIMEOUT_SECONDS = 10

# Maximum retries when generate_network fails to produce a solvable level.
MAX_GENERATION_RETRIES = 10

# Range for randomly assigned redispatch costs on generated nodes (€/MW),
# matching the spread used across the hand-built levels.
COST_INCREASE_RANGE = (20, 100)
COST_DECREASE_RANGE = (-20, 40)


def calculate_redispatch_cost(network: NetworkState) -> float:
    """Total cost of a submitted solution's redispatch adjustments."""
    cost = 0.0
    for node_id, adjustment in network.redispatch.get("adjustments", {}).items():
        node = network.nodes[node_id]
        if adjustment > 0:
            cost += adjustment * node.cost_increase
        else:
            cost += -adjustment * node.cost_decrease
    return cost


def stars_for_redispatch_cost(cost: float) -> int:
    """3 stars for a zero-redispatch solve, 2 under 100€, 1 otherwise."""
    if cost <= 1e-6:
        return 3
    if cost < 100:
        return 2
    return 1


def validate_network(network: NetworkState):
    """Raise ValueError if any line references a node that does not exist."""
    for line in network.lines.values():
        if line.from_node not in network.nodes:
            raise ValueError(
                f"Line {line.id} references unknown from_node '{line.from_node}'"
            )
        if line.to_node not in network.nodes:
            raise ValueError(
                f"Line {line.id} references unknown to_node '{line.to_node}'"
            )


def is_connected(network: NetworkState) -> bool:
    """BFS connectivity check — O(n + m), much cheaper than matrix rank."""
    if not network.nodes:
        return True
    adjacency = {node_id: [] for node_id in network.nodes}
    for line in network.lines.values():
        adjacency[line.from_node].append(line.to_node)
        adjacency[line.to_node].append(line.from_node)

    start = next(iter(network.nodes))
    visited = {start}
    queue = deque([start])
    while queue:
        node_id = queue.popleft()
        for neighbor in adjacency[node_id]:
            if neighbor not in visited:
                visited.add(neighbor)
                queue.append(neighbor)
    return len(visited) == len(network.nodes)


def generate_network(
    num_nodes: int = 12,
    width: float = 500.0,
    height: float = 500.0,
    seed: int | None = None,
):
    """
    Generate a planar graph with nodes positioned in 2D space.
    Each node will have at least degree 3. Edges are created using
    Delaunay triangulation for initial connectivity, then pruned.

    Retries up to MAX_GENERATION_RETRIES times until a solvable level is found.
    """
    import random
    import math
    from scipy.spatial import Delaunay

    if seed is not None:
        random.seed(seed)
        np.random.seed(seed)

    for attempt in range(MAX_GENERATION_RETRIES):
        network = _generate_once(num_nodes, width, height)
        if network is None:
            continue
        solution = solve_network(deepcopy(network), label_difficulty=True)
        if solution.cost == 0.0:
            network.difficulty = solution.difficulty
            return network
        logger.warning(
            "generate_network: unsolvable level on attempt %d/%d "
            "(nodes=%d, lines=%d, cost=%.2f) — retrying",
            attempt + 1,
            MAX_GENERATION_RETRIES,
            len(network.nodes),
            len(network.lines),
            solution.cost,
        )

    raise RuntimeError(
        f"generate_network: failed to produce a solvable level after {MAX_GENERATION_RETRIES} attempts"
    )


def _generate_once(num_nodes: int, width: float, height: float):
    """Single generation attempt. Returns a NetworkState or None if degenerate."""
    import random
    import math
    from scipy.spatial import Delaunay

    # 1. Random 2D positions
    points = [
        (random.random() * width, random.random() * height) for _ in range(num_nodes)
    ]

    # 2. Delaunay triangulation for initial connectivity
    tri = Delaunay(points)
    edges = set()
    for simplex in tri.simplices:
        a, b, c = simplex
        edges.add(tuple(sorted((a, b))))
        edges.add(tuple(sorted((b, c))))
        edges.add(tuple(sorted((a, c))))

    # Build adjacency to enforce min degree 3
    adjacency = {i: set() for i in range(num_nodes)}
    for u, v in edges:
        adjacency[u].add(v)
        adjacency[v].add(u)

    # Ensure each node has degree >= 3 by adding nearest neighbors if needed
    for i in range(num_nodes):
        if len(adjacency[i]) < 3:
            dists = sorted(
                [
                    (j, math.dist(points[i], points[j]))
                    for j in range(num_nodes)
                    if j != i
                ],
                key=lambda x: x[1],
            )
            for j, _ in dists:
                if j not in adjacency[i]:
                    adjacency[i].add(j)
                    adjacency[j].add(i)
                if len(adjacency[i]) >= 3:
                    break

    # Assign random injections to nodes
    raw = [random.uniform(-100, 100) for _ in range(len(points))]

    pos_sum = sum(x for x in raw if x > 0)
    neg_sum = -sum(x for x in raw if x < 0)

    if pos_sum > neg_sum and pos_sum > 0:
        scale = neg_sum / pos_sum if pos_sum > 0 else 0.0
        raw = [x * scale if x > 0 else x for x in raw]
    elif neg_sum > pos_sum and neg_sum > 0:
        scale = pos_sum / neg_sum if neg_sum > 0 else 0.0
        raw = [x * scale if x < 0 else x for x in raw]

    nodes = {}
    for i, (x, y) in enumerate(points):
        nodes[str(i)] = Node(
            id=str(i),
            x=x,
            y=y,
            injection=raw[i],
            cost_increase=random.randint(*COST_INCREASE_RANGE),
            cost_decrease=random.randint(*COST_DECREASE_RANGE),
        )

    lines = {}
    for u in adjacency:
        for v in adjacency[u]:
            if int(u) < int(v):
                lines[f"L{u}-{v}"] = Line(
                    id=f"L{u}-{v}",
                    from_node=str(u),
                    to_node=str(v),
                    flow=0.0,
                    limit=DEFAULT_LINE_LIMIT,
                )

    network = NetworkState(nodes=nodes, lines=lines)
    network = reduce_edges(network)
    network = force_directed_layout(network, k=150.0)

    state = calculate_power_flow(network)
    if state.cost == 0.0:
        max_flow = max(abs(line.flow) for line in state.lines.values())
        if max_flow < MIN_MAX_FLOW_BEFORE_SCALING:
            # Degenerate: scaling would be too extreme, discard this attempt
            return None
        scale = SCALING_TARGET / max_flow
        for node in network.nodes.values():
            node.injection *= scale
        state = calculate_power_flow(network)
    return state


def reduce_edges(
    network,
    factor=EDGE_REDUCTION_FACTOR,
    high_degree_node_factor=HIGH_DEGREE_NODE_FACTOR,
):
    """
    Reduces the number of edges in the network while maintaining connectivity.
    Edges belonging to the top HIGH_DEGREE_NODE_FACTOR fraction of nodes are
    never removed. Mutates network.lines in place.
    """
    nodes = network.nodes
    lines = network.lines
    node_degree = {node.id: 0 for node in nodes.values()}
    for line in lines.values():
        node_degree[line.from_node] += 1
        node_degree[line.to_node] += 1

    sorted_node_degree = sorted(node_degree.items(), key=lambda x: x[1], reverse=True)
    high_degree_nodes = {
        nid
        for nid, _ in sorted_node_degree[
            : math.floor(len(nodes) * high_degree_node_factor)
        ]
    }

    target_num_edges = math.floor(len(lines) * factor)
    shuffled_lines = list(lines.values())
    random.shuffle(shuffled_lines)
    for line in shuffled_lines:
        if len(lines) <= target_num_edges:
            break
        if (
            line.from_node not in high_degree_nodes
            and line.to_node not in high_degree_nodes
            and node_degree[line.from_node] > 3
            and node_degree[line.to_node] > 3
        ):
            del lines[line.id]
            node_degree[line.from_node] -= 1
            node_degree[line.to_node] -= 1
    return network


def force_directed_layout(
    network,
    k=50.0,
    iterations=50,
    repulsion=1.0,
    spring=0.02,
    damping=0.85,
    angular_spring=0.5,
):
    """
    Simple force-directed layout algorithm to adjust node positions.
    Nodes repel each other, edges act as springs.
    """
    nodes = network.nodes
    lines = network.lines
    positions = {
        node.id: np.array([node.x, node.y], dtype=float) for node in nodes.values()
    }
    velocities = {node.id: np.array([0.0, 0.0], dtype=float) for node in nodes.values()}

    for _ in range(iterations):
        forces = {node.id: np.array([0.0, 0.0], dtype=float) for node in nodes.values()}

        # Repulsion
        for i, node_a in nodes.items():
            for j, node_b in nodes.items():
                if i != j:
                    delta = positions[node_a.id] - positions[node_b.id]
                    dist = np.linalg.norm(delta) + 1e-6
                    force_magnitude = repulsion / (dist**2)
                    forces[node_a.id] += (delta / dist) * force_magnitude

        # Spring forces
        for line in lines.values():
            pos_from = positions[line.from_node]
            pos_to = positions[line.to_node]
            delta = pos_to - pos_from
            dist = np.linalg.norm(delta) + 1e-6
            force_magnitude = spring * (dist - k)
            force = (delta / dist) * force_magnitude
            forces[line.from_node] += force
            forces[line.to_node] -= force

        # Angular springs
        adjacency = {node.id: [] for node in nodes.values()}
        for line in lines.values():
            adjacency[line.from_node].append(line.to_node)
            adjacency[line.to_node].append(line.from_node)
        for node_id in adjacency:
            neighbors = adjacency[node_id]
            num_neighbors = len(neighbors)
            node_pos = positions[node_id]
            angles = []
            for neighbor_id in neighbors:
                vec = positions[neighbor_id] - node_pos
                angle = np.arctan2(vec[1], vec[0])
                angles.append((neighbor_id, angle))
            angles.sort(key=lambda x: x[1])
            ideal_angle = 2 * np.pi / num_neighbors
            for i in range(num_neighbors):
                neighbor_id, angle = angles[i]
                next_neighbor_id, next_angle = angles[(i + 1) % num_neighbors]
                gap = (next_angle - angle) % (2 * np.pi)
                angle_diff = gap - ideal_angle
                torque_magnitude = angular_spring * angle_diff
                vec_1 = positions[neighbor_id] - node_pos
                vec_2 = positions[next_neighbor_id] - node_pos
                # Apply torque as forces perpendicular to the vectors
                perp_1 = np.array([-vec_1[1], vec_1[0]])
                perp_2 = np.array([vec_2[1], -vec_2[0]])
                perp_1 /= np.linalg.norm(perp_1) + 1e-6
                perp_2 /= np.linalg.norm(perp_2) + 1e-6
                forces[neighbor_id] += perp_1 * torque_magnitude
                forces[next_neighbor_id] += perp_2 * torque_magnitude
                forces[node_id] -= (perp_1 + perp_2) * torque_magnitude

        # Update velocities and positions
        for node in nodes.values():
            velocities[node.id] = (velocities[node.id] + forces[node.id]) * damping
            positions[node.id] += velocities[node.id]

    # Update node positions
    for node in nodes.values():
        node.x, node.y = positions[node.id].tolist()

    return network


def calculate_power_flow(network):
    """
    DC power flow using Kirchhoff laws.
    Steps:
    - map node ids to indices
    - build incidence matrix A
    - build susceptance Laplacian B
    - solve B * theta = p
    - compute flows on lines
    """
    validate_network(network)

    nodes = network.nodes
    lines = network.lines
    n = len(nodes)

    id_to_idx = {node.id: i for i, node in enumerate(nodes.values())}

    p = np.array([node.injection for node in nodes.values()], dtype=float)

    m = len(lines)
    A = np.zeros((n, m))

    for ell, line in enumerate(lines.values()):
        i = id_to_idx[line.from_node]
        j = id_to_idx[line.to_node]
        A[i, ell] = 1
        A[j, ell] = -1

    # BFS connectivity check — cheaper than matrix rank
    if not is_connected(network):
        return NetworkState(
            nodes=nodes, lines=lines, cost=float("nan"), level=network.level
        )

    B = A @ A.T

    B_red = B[1:, 1:]
    p_red = p[1:]

    try:
        theta_red = np.linalg.solve(B_red, p_red)
    except np.linalg.LinAlgError:
        theta_red = np.zeros(n - 1)

    theta = np.zeros(n)
    theta[1:] = theta_red

    flows = A.T @ theta

    updated_lines = {}
    for ell, line in enumerate(lines.values()):
        updated_lines[line.id] = Line(
            id=line.id,
            from_node=line.from_node,
            to_node=line.to_node,
            flow=float(flows[ell]),
            limit=line.limit,
        )

    network.cost = sum(
        max(0.0, abs(updated_lines[line.id].flow) - line.limit)
        for line in lines.values()
    )
    network.lines = updated_lines

    return network


def island_partition(network: NetworkState) -> tuple[dict[str, int], int]:
    """
    Connected components of the network, with base buses classified apart from
    bypass ("b") buses.

    Returns (island_of_node, main_island_count): every bus mapped to an island
    index (numbered by the smallest node id in it, so deterministic), and the
    number of distinct islands holding at least one base (non-"b") bus.
    """
    adjacency: dict[str, list[str]] = {node_id: [] for node_id in network.nodes}
    for line in network.lines.values():
        adjacency[line.from_node].append(line.to_node)
        adjacency[line.to_node].append(line.from_node)

    island_of_node: dict[str, int] = {}
    main_islands: set[int] = set()
    island_count = 0
    for seed in sorted(network.nodes):
        if seed in island_of_node:
            continue
        island = island_count
        island_count += 1
        island_of_node[seed] = island
        queue = deque([seed])
        while queue:
            node_id = queue.popleft()
            if not node_id.endswith("b"):
                main_islands.add(island)
            for neighbor in adjacency[node_id]:
                if neighbor not in island_of_node:
                    island_of_node[neighbor] = island
                    queue.append(neighbor)
    return island_of_node, len(main_islands)


def resolve_dead_islands(network: NetworkState) -> NetworkState | None:
    """
    Flows for a grid whose only detached islands are dead bypass islands.

    A line opened at both ends floats on two phantom "b" buses. Bypass buses
    carry no injection, so such an island genuinely carries zero flow and the
    real grid is unaffected — a legal state. The island holding the base buses
    is solved normally, every dead line is pinned at zero flow, and `cost`
    comes from the live island alone.

    Returns None when the base buses themselves span more than one island: no
    flows are well defined then, and the submission must not be trusted.

    Mirrors `resolvingDeadIslands()` in the iOS app's FluxEngine. It sits above
    `calculate_power_flow`, which keeps returning NaN cost for any
    disconnection — the solver relies on that to skip disconnected states.
    Does not mutate `network`.
    """
    validate_network(network)
    if is_connected(network):
        return calculate_power_flow(deepcopy(network))

    island_of_node, main_island_count = island_partition(network)
    if main_island_count != 1:
        return None

    main_node = next(node_id for node_id in network.nodes if not node_id.endswith("b"))
    main_island = island_of_node[main_node]

    # A line's endpoints always share an island, so filtering on from_node
    # keeps exactly the live island's lines.
    live = deepcopy(network)
    live.nodes = {
        node_id: node
        for node_id, node in network.nodes.items()
        if island_of_node[node_id] == main_island
    }
    live.lines = {
        line_id: line
        for line_id, line in network.lines.items()
        if island_of_node[line.from_node] == main_island
    }
    live = calculate_power_flow(live)

    resolved = deepcopy(network)
    for line_id, line in resolved.lines.items():
        live_line = live.lines.get(line_id)
        line.flow = live_line.flow if live_line is not None else 0.0
    resolved.cost = live.cost
    return resolved


def update_network(network, req: TopologyChangeRequest):
    """
    Switch the connection to a second node placed at the same location.
    """
    if req.direction == "to":
        target_node_id = req.line_id.split("-")[1]
        from_node_id = req.line_id.split("-")[0][1:]
        if "b" in target_node_id:
            new_node = network.nodes[target_node_id[:-1]]
            connected_lines = [
                line
                for line in network.lines.values()
                if line.from_node == target_node_id or line.to_node == target_node_id
            ]
            if len(connected_lines) == 1:
                del network.nodes[target_node_id]
        else:
            if not network.nodes.get(target_node_id + "b"):
                new_node = Node(
                    id=target_node_id + "b",
                    injection=0.0,
                    x=network.nodes[target_node_id].x,
                    y=network.nodes[target_node_id].y,
                )
                network.nodes[new_node.id] = new_node
            else:
                new_node = network.nodes[target_node_id + "b"]
        new_line_id = f"{req.line_id.split('-')[0]}-{new_node.id}"
        network.lines[new_line_id] = Line(
            id=new_line_id,
            from_node=from_node_id,
            to_node=new_node.id,
            flow=0.0,
            limit=network.lines[req.line_id].limit,
        )
        del network.lines[req.line_id]
    else:
        target_node_id = req.line_id.split("-")[0][1:]
        to_node_id = req.line_id.split("-")[1]
        if "b" in target_node_id:
            new_node = network.nodes[target_node_id[:-1]]
            connected_lines = [
                line
                for line in network.lines.values()
                if line.from_node == target_node_id or line.to_node == target_node_id
            ]
            if len(connected_lines) == 1:
                del network.nodes[target_node_id]
        else:
            if not network.nodes.get(target_node_id + "b"):
                new_node = Node(
                    id=target_node_id + "b",
                    injection=0.0,
                    x=network.nodes[target_node_id].x,
                    y=network.nodes[target_node_id].y,
                )
                network.nodes[new_node.id] = new_node
            else:
                new_node = network.nodes[target_node_id + "b"]
        new_line_id = f"L{new_node.id}-{req.line_id.split('-')[1]}"
        network.lines[new_line_id] = Line(
            id=new_line_id,
            from_node=new_node.id,
            to_node=to_node_id,
            flow=0.0,
            limit=network.lines[req.line_id].limit,
        )
        del network.lines[req.line_id]
    return network


def _get_node_switch_states(network, node_id):
    """
    Enumerate all switch combinations for lines incident to node_id.
    Each incident non-b line endpoint can be toggled independently.
    Yields (config_frozenset, new_network) for each combination.
    """
    incident_lines = [
        line
        for line in network.lines.values()
        if (line.from_node == node_id and not line.from_node.endswith("b"))
        or (line.to_node == node_id and not line.to_node.endswith("b"))
    ]
    if not incident_lines:
        return

    # Build (line_id, direction) pairs that can be switched
    switchable = []
    for line in incident_lines:
        if line.to_node == node_id and not line.to_node.endswith("b"):
            switchable.append((line.id, "to"))
        if line.from_node == node_id and not line.from_node.endswith("b"):
            switchable.append((line.id, "from"))

    # A node can only carry its injection if enough lines remain connected to
    # it: each line can carry at most DEFAULT_LINE_LIMIT, so any config that
    # switches away too many lines is mathematically infeasible regardless of
    # topology and can be pruned before it's even built.
    min_lines_required = abs(network.nodes[node_id].injection) / DEFAULT_LINE_LIMIT

    # Enumerate all non-empty subsets of switches to toggle
    num = len(switchable)
    for mask in range(1, 1 << num):
        remaining = num - bin(mask).count("1")
        if remaining <= min_lines_required:
            continue
        candidate = deepcopy(network)
        for bit in range(num):
            if mask & (1 << bit):
                line_id, direction = switchable[bit]
                # line_id may have changed if a previous toggle renamed it
                # find the current line with matching base id
                req = TopologyChangeRequest(line_id=line_id, direction=direction)
                try:
                    candidate = update_network(candidate, req)
                except (KeyError, Exception):
                    break
        else:
            yield frozenset(candidate.lines.keys()), candidate


def _count_switches(state):
    """Number of line-endpoints moved to a bypass ('b') node — one per player move."""
    switches = 0
    for line in state.lines.values():
        if line.from_node.endswith("b"):
            switches += 1
        if line.to_node.endswith("b"):
            switches += 1
    return switches


def classify_difficulty(depth, switches):
    """
    Map a solution's depth (number of sequential switch decisions on the
    path from the initial topology to the solution) and total switch count
    to one of "Easy", "Medium", "Hard", "Very Hard".

    Depth captures how many interdependent rounds of switching a player has
    to chain together, which is what makes a level feel hard even when it
    only takes a few total switches — so it's the primary signal, with
    total switch count only used to split the depth-1 levels (a single
    round can still bundle many independent switches).
    """
    if depth >= 4:
        return "Very Hard"
    if depth == 3:
        return "Hard"
    if depth == 2:
        return "Medium"
    return "Medium" if switches > 3 else "Easy"


def solve_network(network, label_difficulty=False):
    """
    Find a solution that respects line limits by switching nodes.

    Uses best-first search over topology configurations. Each iteration pops
    the lowest-cost state and expands it by enumerating all switch combinations
    per node (exhaustive within each node), then pushes the best result per node.
    This handles cases where an intermediate high-cost state (e.g. a half-open
    bypass) is required to reach a low-cost solution.

    Cost is the sum of overloads (linear) across all lines.

    If `label_difficulty` is True and a zero-cost solution is found, the
    returned NetworkState's `difficulty` field is set via
    classify_difficulty(), based on the depth of the switch sequence
    actually needed to reach it (tracked via parent pointers) and its
    total switch count. Behavior is otherwise unchanged.
    """
    # line IDs encode topology; frozenset is sufficient for deduplication,
    # and doubles as a lookup key for the parent pointer used to reconstruct
    # solution depth when label_difficulty is requested.
    visited_parent = {}
    best_so_far = calculate_power_flow(deepcopy(network))
    initial_config = frozenset(best_so_far.lines.keys())
    visited_parent[initial_config] = None

    network_states = []
    heapq.heappush(network_states, (best_so_far, initial_config))

    deadline = time.time() + SOLVER_TIMEOUT_SECONDS

    while True:
        if not network_states:
            break
        if time.time() > deadline:
            break

        net, net_config = heapq.heappop(network_states)

        if net.cost < best_so_far.cost:
            best_so_far = net

        if net.cost == 0.0:
            if label_difficulty:
                depth = 0
                cur = net_config
                while visited_parent[cur] is not None:
                    depth += 1
                    cur = visited_parent[cur]
                net.difficulty = classify_difficulty(depth, _count_switches(net))
            return net

        # Expand by node: enumerate all switch combos per node, push every valid one
        node_ids = [nid for nid in net.nodes if not nid.endswith("b")]
        for node_id in node_ids:
            for config, candidate in _get_node_switch_states(net, node_id):
                if config in visited_parent:
                    continue
                new_state = calculate_power_flow(candidate)
                if math.isnan(new_state.cost):
                    continue
                visited_parent[config] = net_config
                heapq.heappush(network_states, (new_state, config))

    return best_so_far


def count_allowed_states(network):
    """
    Exact count of allowed topology states — states where every node has
    enough connected lines to carry its injection (the same feasibility
    check _get_node_switch_states uses to prune switch combinations) —
    computed combinatorially instead of enumerated.

    Each line contributes two independent switchable bits, one owned by
    the node at each endpoint (switching a line at one end never affects
    the other end's node). A node's feasibility depends only on its own
    bits, so the total is the product, over all nodes, of the number of
    ways that node can switch away a subset of its incident lines while
    keeping enough of them connected.
    """
    total = 1
    for node_id, node in network.nodes.items():
        if node_id.endswith("b"):
            continue
        degree = sum(
            1
            for line in network.lines.values()
            if line.from_node == node_id or line.to_node == node_id
        )
        min_lines_required = math.floor(abs(node.injection) / DEFAULT_LINE_LIMIT) + 1
        max_switched_away = degree - min_lines_required
        if max_switched_away < 0:
            return 0
        total *= sum(math.comb(degree, j) for j in range(max_switched_away + 1))
    return total


def evaluate_all_solutions(network):
    """
    Count allowed states (computed exactly via count_allowed_states) and
    search for winning states (cost == 0.0) among them.

    The allowed-state count is exact and doesn't depend on how much of
    the space the search below actually covers — this matters because
    some allowed states are only reachable by passing through an
    intermediate disconnected topology, which the search (like
    solve_network) deliberately doesn't expand through, so it can never
    enumerate 100% of allowed states even given unlimited time.

    The search itself expands lowest-cost states first (same best-first
    order as solve_network) and, unlike solve_network, does not stop at
    the first winning state — it keeps going to find as many as it can
    within 3x the normal solver timeout (exhaustive counting is inherently
    slower than best-first search for a single solution). Searching by
    cost first means winning states tend to be found early, so a partial
    search still gives a meaningful (if partial) winning-state count.

    Returns (allowed_states, winning_states, exhaustive), where
    `exhaustive` is False if the timeout was hit before the search
    frontier was exhausted.
    """
    allowed_states = count_allowed_states(network)

    visited_configs = set()
    initial_state = calculate_power_flow(deepcopy(network))
    initial_config = frozenset(initial_state.lines.keys())
    visited_configs.add(initial_config)

    winning_states = 1 if initial_state.cost == 0.0 else 0
    frontier = [initial_state]

    deadline = time.time() + 3 * SOLVER_TIMEOUT_SECONDS
    exhaustive = True

    while frontier:
        if time.time() > deadline:
            exhaustive = False
            break

        net = heapq.heappop(frontier)

        node_ids = [nid for nid in net.nodes if not nid.endswith("b")]
        for node_id in node_ids:
            for config, candidate in _get_node_switch_states(net, node_id):
                if config in visited_configs:
                    continue
                visited_configs.add(config)
                new_state = calculate_power_flow(candidate)
                if math.isnan(new_state.cost):
                    continue
                if new_state.cost == 0.0:
                    winning_states += 1
                heapq.heappush(frontier, new_state)

    return allowed_states, winning_states, exhaustive


def get_or_create_daily_network() -> NetworkState:
    """
    Return today's daily problem network, generating and caching it if needed.
    The network is stored at generated_networks/daily/YYYY-MM-DD.json.
    """
    today = datetime.date.today().isoformat()
    daily_dir = Path("generated_networks/daily")
    daily_dir.mkdir(parents=True, exist_ok=True)
    filepath = daily_dir / f"{today}.json"

    if filepath.exists():
        with open(filepath) as f:
            return dict_to_network_state(json.load(f))

    logger.info("Generating daily network for %s", today)
    network = generate_network()
    with open(filepath, "w") as f:
        json.dump(network.model_dump(), f, indent=2)
    return network


def load_level(level: int):
    level_files = list(Path("levels").glob("Level*.json"))
    max_level = len(level_files)
    if level < 1 or level > max_level:
        raise ValueError(f"Level must be between 1 and {max_level}")
    file_path = f"levels/Level{level}.json"
    network = update_network_from_file(file_path)
    network = reset_all_switches(network)
    network = calculate_power_flow(network)
    return network


def reset_all_switches(network):
    """
    Resets all switches to their original positions by removing b-nodes
    and stripping the 'b' suffix from line IDs.
    """
    for line in list(network.lines.values()):
        if "b" in line.id:
            from_node_id = line.from_node.replace("b", "")
            to_node_id = line.to_node.replace("b", "")
            new_line_id = f"L{from_node_id}-{to_node_id}"
            network.lines[new_line_id] = Line(
                id=new_line_id,
                from_node=from_node_id,
                to_node=to_node_id,
                flow=0.0,
                limit=line.limit,
            )
            del network.lines[line.id]
    for node_id in list(network.nodes.keys()):
        if node_id.endswith("b"):
            del network.nodes[node_id]
    return network
