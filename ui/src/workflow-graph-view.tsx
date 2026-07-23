import { graphlib, layout as layoutDirectedGraph } from "@dagrejs/dagre";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  useReactFlow,
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppLanguage } from "./app-language";
import type { DemoWorkflowSummary } from "./demo-runtime";
import { useTopmostModal } from "./modal-focus";
import {
  fetchProductWorkflowGraph,
  updateProductWorkflowGraph,
} from "./product-runtime";
import { isRuntimeRequestStatus } from "./runtime-request";
import { WorkflowNodeReferences } from "./workflow-node-references";
import type {
  ProductWorkflowGraphEditInput,
  ProductWorkflowGraphEditResponse,
  ProductWorkflowGraphResponse,
} from "../../src/product/contracts.js";
import type {
  OysterWorkflowGraph,
  WorkflowGraphNode,
  WorkflowGraphTransition,
} from "../../src/types/contracts.js";

type GraphSelection =
  { kind: "node"; id: string } | { kind: "transition"; id: string };

interface WorkflowGraphPanelProps {
  workflow: DemoWorkflowSummary;
  language: AppLanguage;
  mode?: "preview" | "full";
  onGraphSaved?: (response: ProductWorkflowGraphEditResponse) => void;
}

const copy = {
  en: {
    map: "Workflow map",
    fullMap: "Full workflow map",
    closeFullMap: "Close full workflow map",
    loading: "Loading the workflow graph",
    empty: "No graph artifact is available yet.",
    legacy: "This legacy workflow has no editable graph.",
    invalid: "Some graph artifacts could not be opened.",
    incompatible: "This case does not belong to the selected workflow family.",
    selectItem: "Select a node or route to inspect its logic.",
    edit: "Edit",
    cancel: "Cancel",
    save: "Save new version",
    saving: "Saving",
    staleHint: "Refresh the graph, then edit the latest version.",
    saved: "New graph revision saved.",
    required: "This field is required.",
    onePerLine: "One item per line.",
    actsRequired: "Add at least one action instruction.",
    maxAttemptsInvalid: "Enter a whole number of at least 1.",
    hints: "Hints",
    acts: "Action instructions",
    routes: "Routes",
    app: "App",
    outcome: "Outcome",
    objective: "Objective",
    decision: "Decision",
    waitFor: "Wait for",
    resume: "Resume when",
    summary: "Summary",
    title: "Title",
    condition: "Condition",
    maxAttempts: "Maximum attempts",
    noHints: "No hints saved for this node.",
    fit: "Fit graph",
    start: "Start",
    overview: "Overview",
  },
  zh: {
    map: "工作流图",
    fullMap: "完整工作流图",
    closeFullMap: "关闭完整工作流图",
    loading: "正在加载工作流图",
    empty: "目前还没有可用的图产物。",
    legacy: "此旧版工作流暂无可编辑 Graph。",
    invalid: "部分图产物无法打开。",
    incompatible: "这个案例不属于当前选择的工作流 Family。",
    selectItem: "选择一个节点或路线以查看其逻辑。",
    edit: "编辑",
    cancel: "取消",
    save: "保存新版本",
    saving: "保存中",
    staleHint: "请刷新 Graph，再编辑最新版本。",
    saved: "新的 Graph 修订已保存。",
    required: "此字段不能为空。",
    onePerLine: "每行填写一项。",
    actsRequired: "请至少添加一条动作指令。",
    maxAttemptsInvalid: "请输入不小于 1 的整数。",
    hints: "提示",
    acts: "动作指令",
    routes: "后续路线",
    app: "应用",
    outcome: "结果",
    objective: "目标",
    decision: "判断内容",
    waitFor: "等待内容",
    resume: "恢复条件",
    summary: "总结",
    title: "标题",
    condition: "条件",
    maxAttempts: "最大尝试次数",
    noHints: "此节点没有保存提示。",
    fit: "适配画布",
    start: "起点",
    overview: "全图",
  },
} as const;

interface WorkflowRouteEdgeData extends Record<string, unknown> {
  label: string;
  routeType: WorkflowGraphTransition["type"];
  routePoints: Array<{ x: number; y: number }>;
  labelPosition: { x: number; y: number } | null;
  onSelect?: (transitionId: string) => void;
}

type WorkflowRouteFlowEdge = Edge<WorkflowRouteEdgeData, "workflowRoute">;

const workflowEdgeTypes: EdgeTypes = {
  workflowRoute: WorkflowRouteEdge,
};

interface WorkflowGraphModalProps {
  workflow: DemoWorkflowSummary;
  language: AppLanguage;
  onClose: () => void;
  onGraphSaved?: (response: ProductWorkflowGraphEditResponse) => void;
}

/**
 * EN: Hosts the editable workflow map in a focused full-window dialog.
 * 中文: 在聚焦的全窗口弹窗中承载可编辑工作流图。
 * @param props workflow identity, language, close action, and save callback.
 * @returns full workflow map dialog.
 */
export function WorkflowGraphModal({
  workflow,
  language,
  onClose,
  onGraphSaved,
}: WorkflowGraphModalProps) {
  const text = copy[language];
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useTopmostModal({
    open: true,
    containerRef: dialogRef,
    onClose,
    initialFocusRef: closeButtonRef,
  });

  return (
    <div
      className="modal-layer workflow-graph-modal-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="workflow-graph-modal-title"
    >
      <button
        className="modal-backdrop"
        type="button"
        aria-label={text.closeFullMap}
        onClick={onClose}
      />
      <section className="workflow-graph-modal" ref={dialogRef}>
        <header className="modal-header">
          <div>
            <p className="section-kicker">{text.fullMap}</p>
            <h2 id="workflow-graph-modal-title">{workflow.title}</h2>
          </div>
          <button
            ref={closeButtonRef}
            className="icon-button"
            type="button"
            aria-label={text.closeFullMap}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <WorkflowGraphPanel
          workflow={workflow}
          language={language}
          mode="full"
          onGraphSaved={onGraphSaved}
        />
      </section>
    </div>
  );
}

/**
 * EN: Displays and edits only the canonical workflow graph.
 * 中文: 只展示并编辑规范工作流图，不再把旧 Steps 伪装成 Graph。
 * @param props workflow identity, language, display mode, and save callback.
 * @returns interactive canonical graph review and editing surface.
 */
export function WorkflowGraphPanel({
  workflow,
  language,
  mode = "preview",
  onGraphSaved,
}: WorkflowGraphPanelProps) {
  const text = copy[language];
  const [bundle, setBundle] = useState<ProductWorkflowGraphResponse | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  const [readyGraphKey, setReadyGraphKey] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setLoadError(null);
    setBundle(null);
    void fetchProductWorkflowGraph({
      workflowId: workflow.id,
      graphPath: workflow.graphPath,
      candidatePath: workflow.candidatePath,
      mergeProposalPath: workflow.mergeProposalPath,
    })
      .then((response) => {
        if (active) setBundle(response);
      })
      .catch((error) => {
        if (active) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    workflow.candidatePath,
    workflow.graphPath,
    workflow.id,
    workflow.mergeProposalPath,
  ]);

  const graph = bundle?.canonicalGraph ?? null;
  const activeGraphKey = graph
    ? [workflow.id, mode, graph.revision.revisionId].join(":")
    : null;
  const initialNodeIds = useMemo(
    () => (graph ? initialFocusNodeIds(graph) : []),
    [graph],
  );

  useEffect(() => {
    if (!activeGraphKey) return;
    const frame = window.requestAnimationFrame(() => {
      setReadyGraphKey(activeGraphKey);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeGraphKey]);

  useEffect(() => {
    if (!graph) {
      setSelection(null);
      return;
    }
    const selectionExists =
      selection?.kind === "node"
        ? graph.nodes.some((node) => node.id === selection.id)
        : selection?.kind === "transition"
          ? graph.transitions.some(
              (transition) => transition.id === selection.id,
            )
          : false;
    if (!selectionExists) {
      setSelection({ kind: "node", id: graph.entryNodeId });
    }
  }, [graph, selection]);

  if (isLoading) {
    return (
      <div className={`workflow-graph-state is-loading ${mode}`}>
        <span className="workflow-graph-skeleton wide" />
        <span className="workflow-graph-skeleton branch" />
        <span>{text.loading}</span>
      </div>
    );
  }

  if (!graph) {
    return (
      <div className="workflow-graph-state is-empty">
        <strong>{workflow.steps.length > 0 ? text.legacy : text.empty}</strong>
        {loadError ? <span>{loadError}</span> : null}
      </div>
    );
  }

  const selectedNode =
    selection?.kind === "node"
      ? (graph.nodes.find((node) => node.id === selection.id) ?? null)
      : null;
  const selectedTransition =
    selection?.kind === "transition"
      ? (graph.transitions.find(
          (transition) => transition.id === selection.id,
        ) ?? null)
      : null;
  const isFullMap = mode === "full";
  const selectGraphItem = (nextSelection: GraphSelection) => {
    setSelection((current) =>
      current?.kind === nextSelection.kind && current.id === nextSelection.id
        ? current
        : nextSelection,
    );
  };
  const flow = buildFlowElements(
    graph,
    language,
    isFullMap ? selection : null,
    isFullMap ? (id) => selectGraphItem({ kind: "transition", id }) : undefined,
  );

  return (
    <section className={`workflow-graph-review workflow-graph-${mode}`}>
      <header className="workflow-graph-toolbar">
        <div>
          <h3>{text.map}</h3>
          <p>{graph.goal}</p>
        </div>
      </header>

      {bundle?.mergeProposal?.result === "incompatible" ? (
        <p className="workflow-graph-notice is-warning">{text.incompatible}</p>
      ) : null}
      {loadError || (bundle?.errors.length ?? 0) > 0 ? (
        <details className="workflow-graph-error">
          <summary>{text.invalid}</summary>
          {loadError ? <p>{loadError}</p> : null}
          {bundle?.errors.map((error) => (
            <p key={`${error.artifact}-${error.message}`}>{error.message}</p>
          ))}
        </details>
      ) : null}

      <div className="workflow-graph-layout">
        <div className="workflow-graph-canvas" aria-label={text.map}>
          {readyGraphKey === activeGraphKey ? (
            <ReactFlow
              key={activeGraphKey}
              nodes={flow.nodes}
              edges={flow.edges}
              edgeTypes={workflowEdgeTypes}
              fitView
              fitViewOptions={{
                nodes:
                  mode === "full"
                    ? initialNodeIds.map((id) => ({ id }))
                    : graph.nodes.map((node) => ({ id: node.id })),
                padding: 0.16,
                minZoom: 0.3,
                maxZoom: 1,
              }}
              minZoom={mode === "full" ? 0.2 : 0.3}
              maxZoom={1.65}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={isFullMap}
              nodesFocusable={isFullMap}
              edgesFocusable={isFullMap}
              onNodeClick={
                isFullMap
                  ? (_event, node) =>
                      selectGraphItem({ kind: "node", id: node.id })
                  : undefined
              }
              onEdgeClick={
                isFullMap
                  ? (_event, edge) => {
                      const route = graph.transitions.find(
                        (transition) => transition.id === edge.id,
                      );
                      if (route?.type !== "default") {
                        selectGraphItem({ kind: "transition", id: edge.id });
                      }
                    }
                  : undefined
              }
              onSelectionChange={
                isFullMap
                  ? ({ nodes, edges }) => {
                      const selectedRoute = edges[0]
                        ? graph.transitions.find(
                            (transition) => transition.id === edges[0]?.id,
                          )
                        : null;
                      if (edges[0] && selectedRoute?.type !== "default") {
                        selectGraphItem({
                          kind: "transition",
                          id: edges[0].id,
                        });
                      } else if (nodes[0]) {
                        selectGraphItem({ kind: "node", id: nodes[0].id });
                      }
                    }
                  : undefined
              }
              proOptions={{ hideAttribution: true }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={22}
                size={1}
                color="rgba(20, 66, 63, 0.12)"
              />
              <Controls
                showInteractive={false}
                aria-label={text.fit}
                position="bottom-left"
              />
              {mode === "full" ? (
                <GraphViewportNavigation
                  initialNodeIds={initialNodeIds}
                  startLabel={text.start}
                  overviewLabel={text.overview}
                />
              ) : null}
            </ReactFlow>
          ) : (
            <div className="workflow-graph-state is-loading full">
              <span className="workflow-graph-skeleton wide" />
              <span className="workflow-graph-skeleton branch" />
              <span>{text.loading}</span>
            </div>
          )}
        </div>

        {isFullMap ? (
          <aside className="workflow-graph-inspector">
            {selectedNode || selectedTransition ? (
              <GraphInspector
                key={`${graph.revision.revisionId}:${selection?.kind}:${selection?.id}`}
                graph={graph}
                node={selectedNode}
                transition={selectedTransition}
                workflowId={workflow.id}
                language={language}
                onSelectTransition={(id) => {
                  const route = graph.transitions.find(
                    (transition) => transition.id === id,
                  );
                  if (route?.type !== "default") {
                    selectGraphItem({ kind: "transition", id });
                  }
                }}
                onSaved={(response) => {
                  setBundle((current) =>
                    current
                      ? { ...current, canonicalGraph: response.canonicalGraph }
                      : current,
                  );
                  onGraphSaved?.(response);
                }}
              />
            ) : (
              <p>{text.selectItem}</p>
            )}
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function buildFlowElements(
  graph: OysterWorkflowGraph,
  language: AppLanguage,
  selection: GraphSelection | null,
  onSelectTransition?: (transitionId: string) => void,
): { nodes: Node[]; edges: Edge[] } {
  const layout = layoutReviewGraph(graph, language);
  const nodes: Node[] = graph.nodes.map((node) => ({
    id: node.id,
    position: layout.positions.get(node.id) ?? { x: 0, y: 0 },
    initialWidth: WORKFLOW_NODE_WIDTH,
    initialHeight: WORKFLOW_NODE_HEIGHT,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
    handles: [
      {
        type: "target",
        position: Position.Top,
        x: WORKFLOW_NODE_WIDTH / 2 - 4,
        y: -4,
        width: 8,
        height: 8,
      },
      {
        type: "source",
        position: Position.Bottom,
        x: WORKFLOW_NODE_WIDTH / 2 - 4,
        y: WORKFLOW_NODE_HEIGHT - 4,
        width: 8,
        height: 8,
      },
    ],
    className: `workflow-flow-node is-${node.type}`,
    data: {
      type: node.type,
      label: <GraphNodeLabel node={node} language={language} />,
    },
    selected: selection?.kind === "node" && node.id === selection.id,
  }));
  const edges: WorkflowRouteFlowEdge[] = graph.transitions.map(
    (transition) => ({
      id: transition.id,
      source: transition.from,
      target: transition.to,
      type: "workflowRoute",
      data: {
        label: transitionLabel(transition, language),
        routeType: transition.type,
        routePoints: layout.routes.get(transition.id)?.points ?? [],
        labelPosition: layout.routes.get(transition.id)?.labelPosition ?? null,
        onSelect:
          transition.type === "default" ? undefined : onSelectTransition,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 18,
        height: 18,
        color: workflowRouteVisualStyle(transition.type).stroke,
      },
      className: `workflow-flow-edge is-${transition.type}`,
      selectable: transition.type !== "default",
      selected:
        selection?.kind === "transition" && transition.id === selection.id,
    }),
  );
  return { nodes, edges };
}

/**
 * EN: Renders one routed edge and a selectable wrapping condition label.
 * 中文: 渲染一条路线及可选择、可换行的条件标签。
 * @param props React Flow edge geometry and route metadata.
 * @returns a routed edge with readable condition text.
 */
function WorkflowRouteEdge(props: EdgeProps<WorkflowRouteFlowEdge>) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    markerEnd,
    style,
    data,
    selected,
  } = props;
  const routePoints = data?.routePoints ?? [];
  const points = [
    { x: sourceX, y: sourceY },
    ...routePoints.slice(1, -1),
    { x: targetX, y: targetY },
  ];
  const edgePath = roundedPolylinePath(points);
  const labelPosition = data?.labelPosition ?? midpoint(points);
  const label = data?.label ?? "";
  const routeType = data?.routeType ?? "default";
  const routeVisualStyle = workflowRouteVisualStyle(
    routeType,
    Boolean(selected),
  );
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          fill: "none",
          ...routeVisualStyle,
        }}
      />
      {label ? (
        <EdgeLabelRenderer>
          <WorkflowRouteLabel
            id={id}
            label={label}
            routeType={routeType}
            selected={Boolean(selected)}
            position={labelPosition}
            onSelect={data?.onSelect}
          />
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

/**
 * EN: Renders the visible route condition as a keyboard-accessible selection target.
 * 中文: 将可见路线条件渲染为支持键盘操作的选择控件。
 * @param props route identity, appearance, position, and selection callback.
 * @returns an accessible route label button.
 */
export function WorkflowRouteLabel({
  id,
  label,
  routeType,
  selected,
  position,
  onSelect,
}: {
  id: string;
  label: string;
  routeType: WorkflowGraphTransition["type"];
  selected: boolean;
  position: { x: number; y: number };
  onSelect?: (transitionId: string) => void;
}) {
  const className = `workflow-route-label nodrag nopan is-${routeType}${selected ? " selected" : ""}`;
  const style = {
    transform: `translate(-50%, -50%) translate(${position.x}px, ${position.y}px)`,
  };
  if (!onSelect) {
    return (
      <span className={className} style={style} title={label}>
        {label}
      </span>
    );
  }
  return (
    <button
      className={className}
      type="button"
      aria-pressed={selected}
      style={style}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.(id);
      }}
    >
      {label}
    </button>
  );
}

/**
 * EN: Returns explicit SVG path styling for every workflow route type.
 * 中文: 返回每种工作流路线对应的显式 SVG 路径样式。
 * @param type route semantic type.
 * @param selected whether the route is selected in the full map.
 * @returns visible stroke styling independent of outer CSS selectors.
 */
export function workflowRouteVisualStyle(
  type: WorkflowGraphTransition["type"],
  selected = false,
): {
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
} {
  const stroke = (() => {
    if (selected) return "#007b78";
    switch (type) {
      case "conditional":
        return "#b7791f";
      case "retry":
        return "#a84f4a";
      case "resume":
        return "#4f7394";
      default:
        return "#668f8a";
    }
  })();
  return {
    stroke,
    strokeWidth: selected ? 2.8 : 1.9,
    ...(type === "retry" ? { strokeDasharray: "5 4" } : {}),
  };
}

function GraphInspector({
  graph,
  node,
  transition,
  workflowId,
  language,
  onSelectTransition,
  onSaved,
}: {
  graph: OysterWorkflowGraph;
  node: WorkflowGraphNode | null;
  transition: WorkflowGraphTransition | null;
  workflowId: string;
  language: AppLanguage;
  onSelectTransition: (transitionId: string) => void;
  onSaved: (response: ProductWorkflowGraphEditResponse) => void;
}) {
  const text = copy[language];
  const target = node ?? transition;
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    createInspectorDraft(node, transition),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<{
    message: string;
    isRevisionConflict: boolean;
  } | null>(null);
  const editable = node !== null || transition?.type !== "default";

  if (!target) return null;

  const save = async () => {
    const validation = validateInspectorDraft(
      node,
      transition,
      draft,
      language,
    );
    setFieldErrors(validation.errors);
    setSaveError(null);
    if (!validation.input) return;
    setIsSaving(true);
    try {
      const response = await updateProductWorkflowGraph(
        workflowId,
        validation.input(graph.revision.revisionId),
      );
      onSaved(response);
      setIsEditing(false);
    } catch (error) {
      setSaveError({
        message: error instanceof Error ? error.message : String(error),
        isRevisionConflict: isRuntimeRequestStatus(error, 409),
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="workflow-graph-inspector-body">
      <div className="workflow-graph-inspector-actions">
        <span className={`workflow-node-type is-${target.type}`}>
          {node
            ? nodeTypeLabel(node.type, language)
            : routeTypeLabel(transition?.type ?? "default", language)}
        </span>
        {!isEditing && editable ? (
          <button
            className="secondary-button compact"
            type="button"
            onClick={() => setIsEditing(true)}
          >
            {text.edit}
          </button>
        ) : null}
      </div>

      {isEditing ? (
        <InspectorEditForm
          node={node}
          transition={transition}
          draft={draft}
          errors={fieldErrors}
          language={language}
          disabled={isSaving}
          onChange={(field, value) => {
            setDraft((current) => ({ ...current, [field]: value }));
            setFieldErrors((current) => ({ ...current, [field]: "" }));
          }}
        />
      ) : node ? (
        <NodeInspectorView
          graph={graph}
          node={node}
          language={language}
          onSelectTransition={onSelectTransition}
        />
      ) : transition ? (
        <TransitionInspectorView transition={transition} language={language} />
      ) : null}

      {isEditing ? (
        <div className="workflow-graph-edit-footer">
          {saveError ? (
            <div className="workflow-graph-save-error" role="alert">
              <span>{saveError.message}</span>
              {saveError.isRevisionConflict ? (
                <small>{text.staleHint}</small>
              ) : null}
            </div>
          ) : null}
          <div>
            <button
              className="secondary-button"
              type="button"
              disabled={isSaving}
              onClick={() => {
                setDraft(createInspectorDraft(node, transition));
                setFieldErrors({});
                setSaveError(null);
                setIsEditing(false);
              }}
            >
              {text.cancel}
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={isSaving}
              onClick={() => void save()}
            >
              {isSaving ? text.saving : text.save}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NodeInspectorView({
  graph,
  node,
  language,
  onSelectTransition,
}: {
  graph: OysterWorkflowGraph;
  node: WorkflowGraphNode;
  language: AppLanguage;
  onSelectTransition: (transitionId: string) => void;
}) {
  const text = copy[language];
  const outgoing = graph.transitions.filter(
    (transition) =>
      transition.from === node.id && transition.type !== "default",
  );
  const referenceById = new Map(
    (graph.references ?? []).map((reference) => [reference.id, reference]),
  );
  const references = (node.referenceRefs ?? [])
    .map((referenceId) => referenceById.get(referenceId))
    .filter((reference) => reference !== undefined);
  return (
    <>
      <h4>{node.title}</h4>
      <p>{nodeDetail(node, language)}</p>
      {node.type === "action" ? (
        <>
          <ReadOnlyField label={text.app} value={node.operationApp} />
          <InspectorList title={text.acts} items={node.act} empty="" />
        </>
      ) : null}
      {node.type === "terminal" ? (
        <ReadOnlyField label={text.outcome} value={node.outcome} />
      ) : null}
      <InspectorList
        title={text.hints}
        items={node.hints}
        empty={text.noHints}
      />
      <WorkflowNodeReferences references={references} language={language} />
      {outgoing.length > 0 ? (
        <section className="workflow-graph-inspector-section">
          <h5>{text.routes}</h5>
          <div className="workflow-route-list">
            {outgoing.map((route) => (
              <button
                key={route.id}
                type="button"
                onClick={() => onSelectTransition(route.id)}
              >
                <span>{routeTypeLabel(route.type, language)}</span>
                <strong>{transitionLabel(route, language)}</strong>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

function TransitionInspectorView({
  transition,
  language,
}: {
  transition: WorkflowGraphTransition;
  language: AppLanguage;
}) {
  const text = copy[language];
  return (
    <>
      <h4>{transitionLabel(transition, language)}</h4>
      {transition.type !== "default" ? (
        <ReadOnlyField label={text.condition} value={transition.when} />
      ) : null}
      {transition.type === "retry" ? (
        <ReadOnlyField
          label={text.maxAttempts}
          value={String(transition.maxAttempts)}
        />
      ) : null}
    </>
  );
}

function InspectorEditForm({
  node,
  transition,
  draft,
  errors,
  language,
  disabled,
  onChange,
}: {
  node: WorkflowGraphNode | null;
  transition: WorkflowGraphTransition | null;
  draft: Record<string, string>;
  errors: Record<string, string>;
  language: AppLanguage;
  disabled: boolean;
  onChange: (field: string, value: string) => void;
}) {
  const text = copy[language];
  if (transition) {
    return (
      <div className="workflow-graph-edit-form">
        <EditField
          field="when"
          label={text.condition}
          value={draft.when ?? ""}
          error={errors.when}
          disabled={disabled}
          multiline
          onChange={onChange}
        />
        {transition.type === "retry" ? (
          <EditField
            field="maxAttempts"
            label={text.maxAttempts}
            value={draft.maxAttempts ?? ""}
            error={errors.maxAttempts}
            disabled={disabled}
            inputMode="numeric"
            onChange={onChange}
          />
        ) : null}
      </div>
    );
  }
  if (!node) return null;
  return (
    <div className="workflow-graph-edit-form">
      <EditField
        field="title"
        label={text.title}
        value={draft.title ?? ""}
        error={errors.title}
        disabled={disabled}
        onChange={onChange}
      />
      {node.type === "action" ? (
        <>
          <EditField
            field="objective"
            label={text.objective}
            value={draft.objective ?? ""}
            error={errors.objective}
            disabled={disabled}
            multiline
            onChange={onChange}
          />
          <EditField
            field="act"
            label={text.acts}
            value={draft.act ?? ""}
            error={errors.act}
            hint={text.onePerLine}
            disabled={disabled}
            multiline
            onChange={onChange}
          />
          <EditField
            field="operationApp"
            label={text.app}
            value={draft.operationApp ?? ""}
            error={errors.operationApp}
            disabled={disabled}
            onChange={onChange}
          />
        </>
      ) : null}
      {node.type === "decision" ? (
        <EditField
          field="decision"
          label={text.decision}
          value={draft.decision ?? ""}
          error={errors.decision}
          disabled={disabled}
          multiline
          onChange={onChange}
        />
      ) : null}
      {node.type === "wait" ? (
        <>
          <EditField
            field="waitFor"
            label={text.waitFor}
            value={draft.waitFor ?? ""}
            error={errors.waitFor}
            disabled={disabled}
            multiline
            onChange={onChange}
          />
          <EditField
            field="resumeCondition"
            label={text.resume}
            value={draft.resumeCondition ?? ""}
            error={errors.resumeCondition}
            disabled={disabled}
            multiline
            onChange={onChange}
          />
        </>
      ) : null}
      {node.type === "terminal" ? (
        <>
          <label className="workflow-graph-edit-field">
            <span>{text.outcome}</span>
            <select
              value={draft.outcome ?? "completed"}
              disabled={disabled}
              onChange={(event) => onChange("outcome", event.target.value)}
            >
              <option value="completed">completed</option>
              <option value="stopped">stopped</option>
              <option value="rejected">rejected</option>
              <option value="failed">failed</option>
            </select>
          </label>
          <EditField
            field="summary"
            label={text.summary}
            value={draft.summary ?? ""}
            error={errors.summary}
            disabled={disabled}
            multiline
            onChange={onChange}
          />
        </>
      ) : null}
      <EditField
        field="hints"
        label={text.hints}
        value={draft.hints ?? ""}
        error={errors.hints}
        hint={text.onePerLine}
        disabled={disabled}
        multiline
        onChange={onChange}
      />
    </div>
  );
}

function EditField({
  field,
  label,
  value,
  error,
  hint,
  disabled,
  multiline = false,
  inputMode,
  onChange,
}: {
  field: string;
  label: string;
  value: string;
  error?: string;
  hint?: string;
  disabled: boolean;
  multiline?: boolean;
  inputMode?: "numeric";
  onChange: (field: string, value: string) => void;
}) {
  const id = `workflow-graph-field-${field}`;
  return (
    <label className="workflow-graph-edit-field" htmlFor={id}>
      <span>{label}</span>
      {multiline ? (
        <textarea
          id={id}
          value={value}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          onChange={(event) => onChange(field, event.target.value)}
        />
      ) : (
        <input
          id={id}
          value={value}
          disabled={disabled}
          inputMode={inputMode}
          aria-invalid={Boolean(error)}
          onChange={(event) => onChange(field, event.target.value)}
        />
      )}
      {hint ? <small>{hint}</small> : null}
      {error ? <em role="alert">{error}</em> : null}
    </label>
  );
}

function createInspectorDraft(
  node: WorkflowGraphNode | null,
  transition: WorkflowGraphTransition | null,
): Record<string, string> {
  if (node?.type === "action") {
    return {
      title: node.title,
      objective: node.objective,
      act: node.act.join("\n"),
      operationApp: node.operationApp,
      hints: node.hints.join("\n"),
    };
  }
  if (node?.type === "decision") {
    return {
      title: node.title,
      decision: node.decision,
      hints: node.hints.join("\n"),
    };
  }
  if (node?.type === "wait") {
    return {
      title: node.title,
      waitFor: node.waitFor,
      resumeCondition: node.resumeCondition,
      hints: node.hints.join("\n"),
    };
  }
  if (node?.type === "terminal") {
    return {
      title: node.title,
      outcome: node.outcome,
      summary: node.summary,
      hints: node.hints.join("\n"),
    };
  }
  if (transition?.type === "retry") {
    return {
      when: transition.when,
      maxAttempts: String(transition.maxAttempts),
    };
  }
  if (transition && transition.type !== "default") {
    return { when: transition.when };
  }
  return {};
}

function validateInspectorDraft(
  node: WorkflowGraphNode | null,
  transition: WorkflowGraphTransition | null,
  draft: Record<string, string>,
  language: AppLanguage,
): {
  errors: Record<string, string>;
  input: ((expectedRevisionId: string) => ProductWorkflowGraphEditInput) | null;
} {
  const text = copy[language];
  const errors: Record<string, string> = {};
  const required = (field: string) => {
    const value = draft[field]?.trim() ?? "";
    if (!value) errors[field] = text.required;
    return value;
  };
  const lines = (field: string) =>
    (draft[field] ?? "")
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);

  if (node?.type === "action") {
    const title = required("title");
    const objective = required("objective");
    const act = lines("act");
    const operationApp = required("operationApp");
    if (act.length === 0) errors.act = text.actsRequired;
    return {
      errors,
      input:
        Object.keys(errors).length === 0
          ? (expectedRevisionId) => ({
              expectedRevisionId,
              target: { kind: "node", id: node.id, type: "action" },
              patch: {
                title,
                objective,
                act,
                operationApp,
                hints: lines("hints"),
              },
            })
          : null,
    };
  }
  if (node?.type === "decision") {
    const title = required("title");
    const decision = required("decision");
    return {
      errors,
      input:
        Object.keys(errors).length === 0
          ? (expectedRevisionId) => ({
              expectedRevisionId,
              target: { kind: "node", id: node.id, type: "decision" },
              patch: { title, decision, hints: lines("hints") },
            })
          : null,
    };
  }
  if (node?.type === "wait") {
    const title = required("title");
    const waitFor = required("waitFor");
    const resumeCondition = required("resumeCondition");
    return {
      errors,
      input:
        Object.keys(errors).length === 0
          ? (expectedRevisionId) => ({
              expectedRevisionId,
              target: { kind: "node", id: node.id, type: "wait" },
              patch: {
                title,
                waitFor,
                resumeCondition,
                hints: lines("hints"),
              },
            })
          : null,
    };
  }
  if (node?.type === "terminal") {
    const title = required("title");
    const summary = required("summary");
    const outcome = draft.outcome as
      "completed" | "stopped" | "rejected" | "failed";
    return {
      errors,
      input:
        Object.keys(errors).length === 0
          ? (expectedRevisionId) => ({
              expectedRevisionId,
              target: { kind: "node", id: node.id, type: "terminal" },
              patch: { title, outcome, summary, hints: lines("hints") },
            })
          : null,
    };
  }
  if (transition && transition.type !== "default") {
    const when = required("when");
    if (transition.type === "retry") {
      const maxAttempts = Number(draft.maxAttempts);
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        errors.maxAttempts = text.maxAttemptsInvalid;
      }
      return {
        errors,
        input:
          Object.keys(errors).length === 0
            ? (expectedRevisionId) => ({
                expectedRevisionId,
                target: {
                  kind: "transition",
                  id: transition.id,
                  type: "retry",
                },
                patch: { when, maxAttempts },
              })
            : null,
      };
    }
    return {
      errors,
      input:
        Object.keys(errors).length === 0
          ? (expectedRevisionId) =>
              transition.type === "conditional"
                ? {
                    expectedRevisionId,
                    target: {
                      kind: "transition",
                      id: transition.id,
                      type: "conditional",
                    },
                    patch: { when },
                  }
                : {
                    expectedRevisionId,
                    target: {
                      kind: "transition",
                      id: transition.id,
                      type: "resume",
                    },
                    patch: { when },
                  }
          : null,
    };
  }
  return { errors, input: null };
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <dl className="workflow-graph-readonly-field">
      <div>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    </dl>
  );
}

function InspectorList({
  title,
  items,
  empty,
}: {
  title: string;
  items: string[];
  empty: string;
}) {
  return (
    <section className="workflow-graph-inspector-section">
      <h5>{title}</h5>
      {items.length > 0 ? (
        <ul>
          {items.map((item, index) => (
            <li key={`${item}-${index}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
}

function GraphNodeLabel({
  node,
  language,
}: {
  node: WorkflowGraphNode;
  language: AppLanguage;
}) {
  return (
    <div className="workflow-flow-node-content">
      <div className="workflow-flow-node-meta">
        <span>{nodeTypeLabel(node.type, language)}</span>
        {node.hints.length > 0 ? <small>{node.hints.length}</small> : null}
      </div>
      <strong>{node.title}</strong>
      <p>{nodeDetail(node, language)}</p>
    </div>
  );
}

/**
 * EN: Adds explicit orientation controls for large learned graphs.
 * 中文: 为大型学习图提供明确的回到起点和查看全图操作。
 * @param props node ids for the entry neighborhood and localized labels.
 * @returns compact viewport navigation rendered inside React Flow.
 */
function GraphViewportNavigation({
  initialNodeIds,
  startLabel,
  overviewLabel,
}: {
  initialNodeIds: string[];
  startLabel: string;
  overviewLabel: string;
}) {
  const { fitView } = useReactFlow();
  return (
    <Panel position="top-left" className="workflow-graph-navigation">
      <button
        type="button"
        onClick={() =>
          void fitView({
            nodes: initialNodeIds.map((id) => ({ id })),
            padding: 0.2,
            minZoom: 0.34,
            maxZoom: 0.92,
            duration: 220,
          })
        }
      >
        {startLabel}
      </button>
      <button
        type="button"
        onClick={() =>
          void fitView({
            padding: 0.12,
            minZoom: 0.2,
            maxZoom: 0.82,
            duration: 240,
          })
        }
      >
        {overviewLabel}
      </button>
    </Panel>
  );
}

const WORKFLOW_NODE_WIDTH = 254;
const WORKFLOW_NODE_HEIGHT = 140;

interface WorkflowRouteLayout {
  points: Array<{ x: number; y: number }>;
  labelPosition: { x: number; y: number } | null;
}

/**
 * EN: Uses Dagre to place graphs with branches, joins, and cycles without overlap.
 * 中文: 使用 Dagre 布局包含分支、汇合与回路的工作流图。
 * @param graph graph currently displayed.
 * @param language current UI language for route label sizing.
 * @returns node positions and routed edge geometry.
 */
function layoutReviewGraph(
  graph: OysterWorkflowGraph,
  language: AppLanguage,
): {
  positions: Map<string, { x: number; y: number }>;
  routes: Map<string, WorkflowRouteLayout>;
} {
  const layoutGraph = new graphlib.Graph({ directed: true, multigraph: true })
    .setGraph({
      rankdir: "TB",
      ranker: "network-simplex",
      acyclicer: "greedy",
      nodesep: 178,
      edgesep: 34,
      ranksep: 118,
      marginx: 48,
      marginy: 48,
    })
    .setDefaultEdgeLabel(() => ({}));

  for (const node of graph.nodes) {
    layoutGraph.setNode(node.id, {
      width: WORKFLOW_NODE_WIDTH,
      height: WORKFLOW_NODE_HEIGHT,
    });
  }
  for (const transition of graph.transitions) {
    const label = transitionLabel(transition, language);
    const isDefault = transition.type === "default";
    layoutGraph.setEdge(
      transition.from,
      transition.to,
      {
        width: isDefault ? 48 : 188,
        height: isDefault ? 24 : routeLabelHeight(label),
        labelpos: "c",
      },
      transition.id,
    );
  }

  layoutDirectedGraph(layoutGraph);
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of graph.nodes) {
    const placed = layoutGraph.node(node.id);
    positions.set(node.id, {
      x: placed.x - WORKFLOW_NODE_WIDTH / 2,
      y: placed.y - WORKFLOW_NODE_HEIGHT / 2,
    });
  }
  const routes = new Map<string, WorkflowRouteLayout>();
  for (const transition of graph.transitions) {
    const placed = layoutGraph.edge({
      v: transition.from,
      w: transition.to,
      name: transition.id,
    });
    routes.set(transition.id, {
      points: placed.points ?? [],
      labelPosition:
        typeof placed.x === "number" && typeof placed.y === "number"
          ? { x: placed.x, y: placed.y }
          : null,
    });
  }
  return { positions, routes };
}

function routeLabelHeight(label: string): number {
  const approximateLines = Math.max(1, Math.ceil(label.length / 34));
  return Math.min(104, 22 + approximateLines * 14);
}

function midpoint(points: Array<{ x: number; y: number }>): {
  x: number;
  y: number;
} {
  if (points.length === 0) return { x: 0, y: 0 };
  const first = points[0];
  const last = points[points.length - 1];
  return { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };
}

function roundedPolylinePath(
  points: Array<{ x: number; y: number }>,
  radius = 12,
): string {
  const compact = points.filter(
    (point, index) =>
      index === 0 ||
      point.x !== points[index - 1].x ||
      point.y !== points[index - 1].y,
  );
  if (compact.length === 0) return "";
  if (compact.length === 1) return `M ${compact[0].x} ${compact[0].y}`;
  let path = `M ${compact[0].x} ${compact[0].y}`;
  for (let index = 1; index < compact.length - 1; index += 1) {
    const previous = compact[index - 1];
    const current = compact[index];
    const next = compact[index + 1];
    const previousDistance = Math.hypot(
      current.x - previous.x,
      current.y - previous.y,
    );
    const nextDistance = Math.hypot(next.x - current.x, next.y - current.y);
    const cornerRadius = Math.min(
      radius,
      previousDistance / 2,
      nextDistance / 2,
    );
    const before = pointToward(current, previous, cornerRadius);
    const after = pointToward(current, next, cornerRadius);
    path += ` L ${before.x} ${before.y} Q ${current.x} ${current.y} ${after.x} ${after.y}`;
  }
  const last = compact[compact.length - 1];
  return `${path} L ${last.x} ${last.y}`;
}

function pointToward(
  from: { x: number; y: number },
  to: { x: number; y: number },
  distance: number,
): { x: number; y: number } {
  const total = Math.hypot(to.x - from.x, to.y - from.y);
  if (total === 0) return from;
  const ratio = distance / total;
  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio,
  };
}

/**
 * EN: Selects the entry neighborhood from graph connectivity.
 * 中文: 根据图连接关系选择起点邻域。
 * @param graph graph currently displayed.
 * @returns up to five ids covering the first three workflow depths.
 */
function initialFocusNodeIds(graph: OysterWorkflowGraph): string[] {
  const outgoing = new Map<string, string[]>();
  for (const transition of graph.transitions) {
    outgoing.set(transition.from, [
      ...(outgoing.get(transition.from) ?? []),
      transition.to,
    ]);
  }
  const result: string[] = [];
  const queue: Array<{ id: string; depth: number }> = [
    { id: graph.entryNodeId, depth: 0 },
  ];
  const visited = new Set<string>();
  while (queue.length > 0 && result.length < 5) {
    const current = queue.shift();
    if (!current || visited.has(current.id) || current.depth > 2) continue;
    visited.add(current.id);
    result.push(current.id);
    for (const target of outgoing.get(current.id) ?? []) {
      queue.push({ id: target, depth: current.depth + 1 });
    }
  }
  return result.length > 0
    ? result
    : graph.nodes.slice(0, 1).map(({ id }) => id);
}

function nodeTypeLabel(
  type: WorkflowGraphNode["type"],
  language: AppLanguage,
): string {
  const labels =
    language === "zh"
      ? { action: "动作", decision: "判断", wait: "等待", terminal: "结束" }
      : {
          action: "Action",
          decision: "Decision",
          wait: "Wait",
          terminal: "Terminal",
        };
  return labels[type];
}

function routeTypeLabel(
  type: WorkflowGraphTransition["type"],
  language: AppLanguage,
): string {
  const labels =
    language === "zh"
      ? { default: "默认", conditional: "条件", retry: "重试", resume: "恢复" }
      : {
          default: "Default",
          conditional: "Conditional",
          retry: "Retry",
          resume: "Resume",
        };
  return labels[type];
}

function nodeDetail(node: WorkflowGraphNode, language: AppLanguage): string {
  if (node.type === "action") return node.objective;
  if (node.type === "decision") return node.decision;
  if (node.type === "wait") {
    const waitFor = trimTerminalPunctuation(node.waitFor);
    const resumeCondition = trimTerminalPunctuation(node.resumeCondition);
    return language === "zh"
      ? `${copy.zh.waitFor}: ${waitFor}。${copy.zh.resume}: ${resumeCondition}。`
      : `${copy.en.waitFor}: ${waitFor}. ${copy.en.resume}: ${resumeCondition}.`;
  }
  return node.summary;
}

function transitionLabel(
  transition: WorkflowGraphTransition,
  _language: AppLanguage,
): string {
  if (transition.type === "default") return "";
  if (transition.type === "retry") {
    return `${transition.when} (${transition.maxAttempts}x)`;
  }
  return transition.when;
}

function trimTerminalPunctuation(value: string): string {
  return value.trim().replace(/[.!?。！？]+$/u, "");
}
