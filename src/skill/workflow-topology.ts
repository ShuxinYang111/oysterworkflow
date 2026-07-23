export type WorkflowTopologyNodeType =
  "action" | "decision" | "wait" | "terminal";

export type WorkflowTopologyTransitionType =
  "default" | "conditional" | "retry" | "resume";

export interface WorkflowTopologyNode {
  id: string;
  type: WorkflowTopologyNodeType;
}

export interface WorkflowTopologyTransition {
  id: string;
  from: string;
  to: string;
  type: WorkflowTopologyTransitionType;
  when?: string;
  maxAttempts?: number;
}

export interface ValidateWorkflowTopologyOptions {
  graphLabel: string;
  nodeLabel: string;
  transitionLabel: string;
  entryNodeId: string;
  nodes: WorkflowTopologyNode[];
  transitions: WorkflowTopologyTransition[];
}

/**
 * CN: 校验 Candidate 与 Canonical Graph 共享的结构语义，同时允许真实录制形成的 partial decision 和 open wait。
 * EN: Validates shared Candidate/Canonical topology while allowing real-trace partial decisions and open waits.
 * @param options graph labels and topology values.
 * @returns void; throws a diagnostic error for unsafe or contradictory topology.
 */
export function validateWorkflowTopology(
  options: ValidateWorkflowTopologyOptions,
): void {
  const nodes = new Map<string, WorkflowTopologyNode>();
  for (const node of options.nodes) {
    if (nodes.has(node.id)) {
      throw new Error(`Duplicate ${options.nodeLabel} id: ${node.id}`);
    }
    nodes.set(node.id, node);
  }
  if (!nodes.has(options.entryNodeId)) {
    throw new Error(
      `${options.graphLabel} entry node does not exist: ${options.entryNodeId}`,
    );
  }

  const transitionIds = new Set<string>();
  const outgoing = new Map<string, WorkflowTopologyTransition[]>();
  const adjacency = new Map<string, string[]>();
  for (const transition of options.transitions) {
    if (transitionIds.has(transition.id)) {
      throw new Error(
        `Duplicate ${options.transitionLabel} id: ${transition.id}`,
      );
    }
    transitionIds.add(transition.id);
    const source = nodes.get(transition.from);
    if (!source) {
      throw new Error(
        `${options.transitionLabel} ${transition.id} references missing source node: ${transition.from}`,
      );
    }
    if (!nodes.has(transition.to)) {
      throw new Error(
        `${options.transitionLabel} ${transition.id} references missing target node: ${transition.to}`,
      );
    }
    if (
      transition.type === "conditional" ||
      transition.type === "retry" ||
      transition.type === "resume"
    ) {
      if (!transition.when || transition.when.trim().length === 0) {
        throw new Error(
          `${options.transitionLabel} ${transition.id} requires a condition.`,
        );
      }
    }
    if (
      transition.type === "retry" &&
      (!Number.isInteger(transition.maxAttempts) ||
        (transition.maxAttempts ?? 0) < 1)
    ) {
      throw new Error(
        `Retry ${options.transitionLabel.toLowerCase()} ${transition.id} requires maxAttempts >= 1.`,
      );
    }
    if (transition.type === "resume" && source.type !== "wait") {
      throw new Error(
        `Resume ${options.transitionLabel.toLowerCase()} ${transition.id} must start from a wait node.`,
      );
    }
    const grouped = outgoing.get(transition.from) ?? [];
    grouped.push(transition);
    outgoing.set(transition.from, grouped);
    adjacency.set(transition.from, [
      ...(adjacency.get(transition.from) ?? []),
      transition.to,
    ]);
  }

  let hasKnownEndpoint = false;
  for (const node of options.nodes) {
    const routes = outgoing.get(node.id) ?? [];
    if (node.type === "terminal") {
      hasKnownEndpoint = true;
      if (routes.length > 0) {
        throw new Error(
          `${options.graphLabel} terminal node must not have outgoing transitions: ${node.id}`,
        );
      }
      continue;
    }
    if (node.type === "wait" && routes.length === 0) {
      hasKnownEndpoint = true;
      continue;
    }
    if (routes.length === 0) {
      throw new Error(
        `${options.graphLabel} non-terminal node requires an outgoing transition: ${node.id}`,
      );
    }
    const defaultRoutes = routes.filter((route) => route.type === "default");
    if (defaultRoutes.length > 1) {
      throw new Error(
        `${options.graphLabel} node has more than one default transition: ${node.id}`,
      );
    }
    if (
      node.type === "decision" &&
      !routes.some((route) => route.type === "conditional")
    ) {
      throw new Error(
        `${options.graphLabel} decision node requires at least one conditional route: ${node.id}`,
      );
    }
    if (
      node.type === "wait" &&
      !routes.some((route) => route.type === "resume")
    ) {
      throw new Error(
        `${options.graphLabel} wait node with known continuation requires a resume transition: ${node.id}`,
      );
    }
  }
  if (!hasKnownEndpoint) {
    throw new Error(
      `${options.graphLabel} must contain at least one terminal node or open wait node.`,
    );
  }

  const reachable = collectReachableNodeIds(options.entryNodeId, adjacency);
  const unreachable = options.nodes
    .map((node) => node.id)
    .filter((nodeId) => !reachable.has(nodeId));
  if (unreachable.length > 0) {
    throw new Error(
      `${options.graphLabel} contains unreachable nodes: ${unreachable.join(", ")}`,
    );
  }

  assertCyclesHaveExitOrBoundedRetry(
    options.graphLabel,
    options.nodes,
    options.transitions,
  );
}

function collectReachableNodeIds(
  entryNodeId: string,
  adjacency: Map<string, string[]>,
): Set<string> {
  const reachable = new Set<string>();
  const queue = [entryNodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || reachable.has(current)) {
      continue;
    }
    reachable.add(current);
    queue.push(...(adjacency.get(current) ?? []));
  }
  return reachable;
}

function assertCyclesHaveExitOrBoundedRetry(
  graphLabel: string,
  nodes: WorkflowTopologyNode[],
  transitions: WorkflowTopologyTransition[],
): void {
  const outgoing = groupTransitionsBySource(transitions);
  const indexByNode = new Map<string, number>();
  const lowLinkByNode = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let nextIndex = 0;

  const visit = (nodeId: string): void => {
    indexByNode.set(nodeId, nextIndex);
    lowLinkByNode.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);
    for (const transition of outgoing.get(nodeId) ?? []) {
      const target = transition.to;
      if (!indexByNode.has(target)) {
        visit(target);
        lowLinkByNode.set(
          nodeId,
          Math.min(
            lowLinkByNode.get(nodeId) ?? 0,
            lowLinkByNode.get(target) ?? 0,
          ),
        );
      } else if (onStack.has(target)) {
        lowLinkByNode.set(
          nodeId,
          Math.min(
            lowLinkByNode.get(nodeId) ?? 0,
            indexByNode.get(target) ?? 0,
          ),
        );
      }
    }
    if (lowLinkByNode.get(nodeId) !== indexByNode.get(nodeId)) {
      return;
    }
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (!member) {
        break;
      }
      onStack.delete(member);
      component.push(member);
    } while (member !== nodeId);
    const componentSet = new Set(component);
    const internalTransitions = transitions.filter(
      (transition) =>
        componentSet.has(transition.from) && componentSet.has(transition.to),
    );
    const hasCycle =
      component.length > 1 ||
      internalTransitions.some(
        (transition) => transition.from === transition.to,
      );
    if (!hasCycle) {
      return;
    }
    const hasBoundedRetry = internalTransitions.some(
      (transition) =>
        transition.type === "retry" &&
        Number.isInteger(transition.maxAttempts) &&
        (transition.maxAttempts ?? 0) >= 1,
    );
    const hasExitRoute = transitions.some(
      (transition) =>
        componentSet.has(transition.from) && !componentSet.has(transition.to),
    );
    if (!hasBoundedRetry && !hasExitRoute) {
      throw new Error(
        `${graphLabel} cycle must have an exit route or bounded retry transition: ${component.join(", ")}`,
      );
    }
  };

  for (const node of nodes) {
    if (!indexByNode.has(node.id)) {
      visit(node.id);
    }
  }
}

function groupTransitionsBySource(
  transitions: WorkflowTopologyTransition[],
): Map<string, WorkflowTopologyTransition[]> {
  const outgoing = new Map<string, WorkflowTopologyTransition[]>();
  for (const transition of transitions) {
    const grouped = outgoing.get(transition.from) ?? [];
    grouped.push(transition);
    outgoing.set(transition.from, grouped);
  }
  return outgoing;
}
