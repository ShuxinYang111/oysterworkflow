import marketingWorkerAvatarUrl from "./assets/worker-avatars/marketing-worker.png";
import productAvatarUrl from "./assets/worker-avatars/product-worker.png";
import financeWorkerAvatarUrl from "./assets/worker-avatars/finance-worker.png";
import salesWorkerAvatarUrl from "./assets/worker-avatars/sales-worker.png";
import { runtimeJsonRequest } from "./runtime-request";
import { selectProductAgentConversationEvents } from "../../src/product/agent-conversation.js";
import type {
  ProductAccountSetupInput,
  ProductAccountSetupResponse,
  ProductApplyWorkflowMergeResponse,
  ProductApproveChannelPairingInput,
  ProductApproveChannelPairingResponse,
  ProductAssignDeviceInput,
  ProductAssignDeviceResponse,
  ProductCapabilityProviderCheckResponse,
  ProductCapabilityProviderId,
  ProductClawHubAuthState,
  ProductClawHubLoginStartResponse,
  ProductClawHubLoginStatusResponse,
  ProductClawHubPublishResponse,
  ProductBeginChannelSetupInput,
  ProductBindChannelInput,
  ProductChannelBindingResponse,
  ProductChannelPeersResponse,
  ProductChannelSetupResponse,
  ProductComposioAuthorizeInput,
  ProductComposioAuthorizeResponse,
  ProductComposioConnectionResponse,
  ProductComposioDisconnectResponse,
  ProductComposioOverviewResponse,
  ProductComposioToolkitFilter,
  ProductCommandResponse,
  ProductCreateWorkflowInput,
  ProductCreateWorkflowResponse,
  ProductCreateWorkerInput,
  ProductCreateWorkerResponse,
  ProductDeleteInstalledWorkflowResponse,
  ProductDeleteWorkerResponse,
  ProductDeleteWorkflowResponse,
  ProductDisconnectChannelResponse,
  ProductInstallWorkflowInput,
  ProductInstallWorkflowResponse,
  ProductInstalledWorkflow,
  ProductInstalledWorkflowStatus,
  ProductPendingWorkflowMergesResponse,
  ProductCreateNewWorkflowDecisionResponse,
  ProductRestoreWorkflowVersionResponse,
  ProductRun,
  ProductRunEvent,
  ProductRunWorkflowResponse,
  ProductState,
  ProductStateResponse,
  ProductWorker,
  ProductWorkerChannelConfigureResponse,
  ProductWorkerChannelInput,
  ProductWorkerChannelTestResponse,
  ProductWorkerConfigInput,
  ProductWorkerConfigResponse,
  ProductWorkflowGraphResponse,
  ProductWorkflowGraphEditInput,
  ProductWorkflowGraphEditResponse,
  ProductWorkflowVersionsResponse,
} from "../../src/product/contracts.js";

export type ProductStateSnapshot = ProductState;

const workerAvatarUrls: Record<ProductWorker["avatarKey"], string> = {
  marketing: marketingWorkerAvatarUrl,
  product: productAvatarUrl,
  finance: financeWorkerAvatarUrl,
  sales: salesWorkerAvatarUrl,
};

/**
 * EN: Loads the real local product state from Runtime.
 * 中文: 从 Runtime 读取真实本地产品状态。
 * @returns product state snapshot.
 */
export async function fetchProductState(): Promise<ProductStateSnapshot> {
  const response =
    await productRequest<ProductStateResponse>("/api/product/state");
  return response.state;
}

/**
 * EN: Loads canonical, Candidate, and Call 5 proposal graph artifacts for one workflow.
 * 中文: 读取一个工作流的 canonical、Candidate 与 Call 5 proposal 图产物。
 * @param input workflow id and optional explicit artifact paths from a Runtime session.
 * @returns validated graph review bundle.
 */
export async function fetchProductWorkflowGraph(input: {
  workflowId: string;
  graphPath?: string | null;
  candidatePath?: string | null;
  mergeProposalPath?: string | null;
}): Promise<ProductWorkflowGraphResponse> {
  const search = new URLSearchParams();
  if (input.graphPath) search.set("graphPath", input.graphPath);
  if (input.candidatePath) search.set("candidatePath", input.candidatePath);
  if (input.mergeProposalPath) {
    search.set("mergeProposalPath", input.mergeProposalPath);
  }
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return productRequest<ProductWorkflowGraphResponse>(
    `/api/product/workflows/${encodeURIComponent(input.workflowId)}/graph${suffix}`,
  );
}

/**
 * EN: Saves one allow-listed node or route content patch as a new Graph revision.
 * 中文: 将一个节点或路线的白名单内容修改保存为新的 Graph 修订。
 * @param workflowId Product workflow owning the canonical Graph.
 * @param input revision-bound Graph edit request.
 * @returns updated Graph revision and Product state.
 */
export async function updateProductWorkflowGraph(
  workflowId: string,
  input: ProductWorkflowGraphEditInput,
): Promise<ProductWorkflowGraphEditResponse> {
  return productRequest<ProductWorkflowGraphEditResponse>(
    `/api/product/workflows/${encodeURIComponent(workflowId)}/graph`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

/**
 * EN: Explicitly accepts a ready merge proposal and creates a canonical revision.
 * 中文: 显式接受可应用的合并提案并创建新的规范修订。
 * @param workflowId Product workflow that owns the proposal.
 * @returns updated product state and canonical graph revision.
 */
export async function applyProductWorkflowMergeProposal(
  workflowId: string,
  targetWorkflowId?: string,
): Promise<ProductApplyWorkflowMergeResponse> {
  return productRequest<ProductApplyWorkflowMergeResponse>(
    `/api/product/workflows/${encodeURIComponent(workflowId)}/merge-proposal/apply`,
    {
      method: "POST",
      body: JSON.stringify(targetWorkflowId ? { targetWorkflowId } : {}),
    },
  );
}

/**
 * EN: Lists mergeable generated workflows that still need a user decision.
 * 中文: 读取仍需用户选择“新建或合并”的生成工作流。
 * @returns pending workflow classification decisions.
 */
export async function fetchPendingProductWorkflowMerges(): Promise<ProductPendingWorkflowMergesResponse> {
  return productRequest<ProductPendingWorkflowMergesResponse>(
    "/api/product/workflows/pending-merges",
  );
}

/**
 * EN: Keeps a mergeable capture as an independent new workflow.
 * 中文: 将可合并的录制保留为独立新工作流。
 * @param workflowId source workflow owning the proposal.
 * @returns updated Product state and persisted decision.
 */
export async function keepProductWorkflowAsNew(
  workflowId: string,
): Promise<ProductCreateNewWorkflowDecisionResponse> {
  return productRequest<ProductCreateNewWorkflowDecisionResponse>(
    `/api/product/workflows/${encodeURIComponent(workflowId)}/merge-proposal/keep-new`,
    { method: "POST" },
  );
}

/**
 * EN: Loads immutable revision history for one workflow.
 * 中文: 读取单个工作流的不可变版本历史。
 * @param workflowId Product workflow id.
 * @returns current and historical revisions.
 */
export async function fetchProductWorkflowVersions(
  workflowId: string,
): Promise<ProductWorkflowVersionsResponse> {
  return productRequest<ProductWorkflowVersionsResponse>(
    `/api/product/workflows/${encodeURIComponent(workflowId)}/versions`,
  );
}

/**
 * EN: Restores a historical version as a new current revision.
 * 中文: 将历史版本恢复为新的当前修订。
 * @param workflowId Product workflow id.
 * @param revisionId immutable historical revision id.
 * @returns updated Product state and newly created canonical revision.
 */
export async function restoreProductWorkflowVersion(
  workflowId: string,
  revisionId: string,
): Promise<ProductRestoreWorkflowVersionResponse> {
  return productRequest<ProductRestoreWorkflowVersionResponse>(
    `/api/product/workflows/${encodeURIComponent(workflowId)}/versions/restore`,
    {
      method: "POST",
      body: JSON.stringify({ revisionId }),
    },
  );
}

export async function refreshProductHermes(): Promise<ProductStateSnapshot> {
  const response = await productRequest<ProductStateResponse>(
    "/api/product/hermes/probe",
    { method: "POST" },
    { timeoutMs: 180_000 },
  );
  return response.state;
}

export async function checkProductCapabilityProvider(
  providerId: ProductCapabilityProviderId,
): Promise<ProductCapabilityProviderCheckResponse> {
  return productRequest<ProductCapabilityProviderCheckResponse>(
    `/api/product/capabilities/${encodeURIComponent(providerId)}/check`,
    { method: "POST" },
    { timeoutMs: 120_000 },
  );
}

/**
 * EN: Installs a managed capability sidecar without launching or testing its external application.
 * 中文: 安装托管能力 sidecar，但不启动或检测对应的外部应用。
 * @param providerId capability provider to prepare.
 * @returns updated provider and product state.
 */
export async function prepareProductCapabilityProvider(
  providerId: ProductCapabilityProviderId,
): Promise<ProductCapabilityProviderCheckResponse> {
  return productRequest<ProductCapabilityProviderCheckResponse>(
    `/api/product/capabilities/${encodeURIComponent(providerId)}/prepare`,
    { method: "POST" },
    { timeoutMs: 240_000 },
  );
}

export async function fetchProductComposioOverview(
  input: {
    cursor?: string;
    search?: string;
    filter?: ProductComposioToolkitFilter;
    limit?: number;
  } = {},
): Promise<ProductComposioOverviewResponse> {
  const query = new URLSearchParams();
  if (input.cursor) query.set("cursor", input.cursor);
  if (input.search) query.set("search", input.search);
  if (input.filter) query.set("filter", input.filter);
  if (input.limit) query.set("limit", String(input.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return productRequest<ProductComposioOverviewResponse>(
    `/api/product/integrations/composio${suffix}`,
  );
}

export async function authorizeProductComposioToolkit(input: {
  toolkitSlug: string;
  options?: ProductComposioAuthorizeInput;
}): Promise<ProductComposioAuthorizeResponse> {
  return productRequest<ProductComposioAuthorizeResponse>(
    `/api/product/integrations/composio/toolkits/${encodeURIComponent(input.toolkitSlug)}/authorize`,
    {
      method: "POST",
      body: JSON.stringify(input.options ?? {}),
    },
  );
}

export async function fetchProductComposioConnection(
  connectionId: string,
): Promise<ProductComposioConnectionResponse> {
  return productRequest<ProductComposioConnectionResponse>(
    `/api/product/integrations/composio/connections/${encodeURIComponent(connectionId)}`,
  );
}

export async function disconnectProductComposioConnection(
  connectionId: string,
): Promise<ProductComposioDisconnectResponse> {
  return productRequest<ProductComposioDisconnectResponse>(
    `/api/product/integrations/composio/connections/${encodeURIComponent(connectionId)}`,
    { method: "DELETE" },
  );
}

export async function installProductWorkflow(
  input: ProductInstallWorkflowInput,
): Promise<ProductInstallWorkflowResponse> {
  return productRequest<ProductInstallWorkflowResponse>(
    "/api/product/workflows/install",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function deleteProductWorkflow(input: {
  workflowId: string;
  workflowTitle: string;
}): Promise<ProductDeleteWorkflowResponse> {
  return productRequest<ProductDeleteWorkflowResponse>(
    `/api/product/workflows/${encodeURIComponent(input.workflowId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ workflowTitle: input.workflowTitle }),
    },
  );
}

/**
 * EN: Deletes one AI worker and its workspace-scoped bindings.
 * 中文: 删除一个 AI Worker 及其工作区级绑定。
 * @param workerId local product worker id.
 * @returns updated state and the deleted worker snapshot.
 */
export async function deleteProductWorker(
  workerId: string,
): Promise<ProductDeleteWorkerResponse> {
  return productRequest<ProductDeleteWorkerResponse>(
    `/api/product/workers/${encodeURIComponent(workerId)}`,
    { method: "DELETE" },
  );
}

export async function setupProductAccount(
  input: ProductAccountSetupInput,
): Promise<ProductStateSnapshot> {
  const response = await productRequest<ProductAccountSetupResponse>(
    "/api/product/account/setup",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return response.state;
}

export async function assignProductDevice(
  input: ProductAssignDeviceInput,
): Promise<ProductAssignDeviceResponse> {
  return productRequest<ProductAssignDeviceResponse>(
    "/api/product/devices/assign",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function createProductWorker(
  input: ProductCreateWorkerInput,
): Promise<ProductCreateWorkerResponse> {
  return productRequest<ProductCreateWorkerResponse>("/api/product/workers", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createProductWorkflow(
  input: ProductCreateWorkflowInput,
): Promise<ProductCreateWorkflowResponse> {
  return productRequest<ProductCreateWorkflowResponse>(
    "/api/product/workflows",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

/**
 * EN: Reads the local ClawHub publisher connection state.
 * 中文: 读取本机 ClawHub 发布账号连接状态。
 * @returns current ClawHub auth state.
 */
export async function fetchProductClawHubAuth(): Promise<ProductClawHubAuthState> {
  return productRequest<ProductClawHubAuthState>("/api/product/clawhub/auth");
}

/**
 * EN: Starts a ClawHub device authorization flow.
 * 中文: 启动 ClawHub 设备授权流程。
 * @returns verification URL, code, and local login id.
 */
export async function beginProductClawHubLogin(): Promise<ProductClawHubLoginStartResponse> {
  return productRequest<ProductClawHubLoginStartResponse>(
    "/api/product/clawhub/login",
    { method: "POST" },
  );
}

/**
 * EN: Reads progress for one ClawHub device authorization flow.
 * 中文: 读取一次 ClawHub 设备授权流程的进度。
 * @param loginId local authorization flow id.
 * @returns pending, authorized, or failed state.
 */
export async function fetchProductClawHubLoginStatus(
  loginId: string,
): Promise<ProductClawHubLoginStatusResponse> {
  return productRequest<ProductClawHubLoginStatusResponse>(
    `/api/product/clawhub/login/${encodeURIComponent(loginId)}`,
  );
}

/**
 * EN: Publishes one generated workflow publicly to ClawHub under MIT-0.
 * 中文: 以 MIT-0 将一个已生成工作流公开发布到 ClawHub。
 * @param workflowId local workflow id.
 * @returns canonical listing URL and install command.
 */
export async function publishProductWorkflowToClawHub(
  workflowId: string,
): Promise<ProductClawHubPublishResponse> {
  return productRequest<ProductClawHubPublishResponse>(
    `/api/product/workflows/${encodeURIComponent(workflowId)}/clawhub-publish`,
    {
      method: "POST",
      body: JSON.stringify({ acceptMit0: true }),
    },
  );
}

export async function updateProductWorkerConfig(input: {
  workerId: string;
  config: ProductWorkerConfigInput;
}): Promise<ProductWorkerConfigResponse> {
  return productRequest<ProductWorkerConfigResponse>(
    `/api/product/workers/${encodeURIComponent(input.workerId)}/config`,
    {
      method: "POST",
      body: JSON.stringify(input.config),
    },
  );
}

export async function configureProductWorkerChannel(input: {
  workerId: string;
  channel: ProductWorkerChannelInput;
}): Promise<ProductWorkerChannelConfigureResponse> {
  return productRequest<ProductWorkerChannelConfigureResponse>(
    `/api/product/workers/${encodeURIComponent(input.workerId)}/channel/config`,
    {
      method: "POST",
      body: JSON.stringify(input.channel),
    },
  );
}

export async function testProductWorkerChannel(
  workerId: string,
): Promise<ProductWorkerChannelTestResponse> {
  return productRequest<ProductWorkerChannelTestResponse>(
    `/api/product/workers/${encodeURIComponent(workerId)}/channel/test`,
    {
      method: "POST",
    },
  );
}

export async function beginProductWorkerChannelSetup(input: {
  workerId: string;
  setup: ProductBeginChannelSetupInput;
}): Promise<ProductChannelSetupResponse> {
  return productRequest<ProductChannelSetupResponse>(
    `/api/product/workers/${encodeURIComponent(input.workerId)}/channel/setups`,
    { method: "POST", body: JSON.stringify(input.setup) },
  );
}

export async function readProductWorkerChannelSetup(input: {
  workerId: string;
  setupId: string;
}): Promise<ProductChannelSetupResponse> {
  return productRequest<ProductChannelSetupResponse>(
    `/api/product/workers/${encodeURIComponent(input.workerId)}/channel/setups/${encodeURIComponent(input.setupId)}`,
  );
}

export async function cancelProductWorkerChannelSetup(input: {
  workerId: string;
  setupId: string;
}): Promise<ProductChannelSetupResponse> {
  return productRequest<ProductChannelSetupResponse>(
    `/api/product/workers/${encodeURIComponent(input.workerId)}/channel/setups/${encodeURIComponent(input.setupId)}`,
    { method: "DELETE" },
  );
}

export async function listProductWorkerChannelPeers(input: {
  workerId: string;
  connectionId: string;
}): Promise<ProductChannelPeersResponse> {
  return productRequest<ProductChannelPeersResponse>(
    `/api/product/workers/${encodeURIComponent(input.workerId)}/channel/connections/${encodeURIComponent(input.connectionId)}/peers`,
  );
}

export async function disconnectProductWorkerChannel(input: {
  workerId: string;
  connectionId: string;
}): Promise<ProductDisconnectChannelResponse> {
  return productRequest<ProductDisconnectChannelResponse>(
    `/api/product/workers/${encodeURIComponent(input.workerId)}/channel/connections/${encodeURIComponent(input.connectionId)}`,
    { method: "DELETE" },
  );
}

export async function bindProductWorkerChannel(input: {
  workerId: string;
  binding: ProductBindChannelInput;
}): Promise<ProductChannelBindingResponse> {
  return productRequest<ProductChannelBindingResponse>(
    `/api/product/workers/${encodeURIComponent(input.workerId)}/channel/bindings`,
    { method: "POST", body: JSON.stringify(input.binding) },
  );
}

export async function approveProductWorkerChannelPairing(input: {
  workerId: string;
  pairing: ProductApproveChannelPairingInput;
}): Promise<ProductApproveChannelPairingResponse> {
  return productRequest<ProductApproveChannelPairingResponse>(
    `/api/product/workers/${encodeURIComponent(input.workerId)}/channel/pairing/approve`,
    { method: "POST", body: JSON.stringify(input.pairing) },
  );
}

export async function startProductWorker(
  workerId: string,
): Promise<ProductStateSnapshot> {
  const response = await productRequest<{
    state: ProductStateSnapshot;
    worker: ProductWorker;
  }>(`/api/product/workers/${encodeURIComponent(workerId)}/start`, {
    method: "POST",
  });
  return response.state;
}

export async function runProductInstalledWorkflow(
  installedWorkflowId: string,
): Promise<ProductRunWorkflowResponse> {
  return productRequest<ProductRunWorkflowResponse>(
    `/api/product/installed-workflows/${encodeURIComponent(
      installedWorkflowId,
    )}/run`,
    {
      method: "POST",
    },
  );
}

export async function stopProductWorker(
  workerId: string,
): Promise<ProductStateSnapshot> {
  const response = await productRequest<ProductStateResponse>(
    `/api/product/workers/${encodeURIComponent(workerId)}/stop`,
    { method: "POST" },
  );
  return response.state;
}

export async function sendProductWorkerCommand(input: {
  workerId: string;
  command: string;
}): Promise<ProductCommandResponse> {
  return productRequest<ProductCommandResponse>(
    `/api/product/workers/${encodeURIComponent(input.workerId)}/commands`,
    {
      method: "POST",
      body: JSON.stringify({ command: input.command }),
    },
  );
}

export async function updateProductInstalledWorkflowStatus(input: {
  installedWorkflowId: string;
  status: ProductInstalledWorkflowStatus;
}): Promise<ProductStateSnapshot> {
  const response = await productRequest<ProductStateResponse>(
    `/api/product/installed-workflows/${encodeURIComponent(
      input.installedWorkflowId,
    )}/status`,
    {
      method: "POST",
      body: JSON.stringify({ status: input.status }),
    },
  );
  return response.state;
}

export async function deleteProductInstalledWorkflow(
  installedWorkflowId: string,
): Promise<ProductDeleteInstalledWorkflowResponse> {
  return productRequest<ProductDeleteInstalledWorkflowResponse>(
    `/api/product/installed-workflows/${encodeURIComponent(
      installedWorkflowId,
    )}`,
    {
      method: "DELETE",
    },
  );
}

export function productWorkerAvatarUrl(worker: ProductWorker): string {
  return workerAvatarUrls[worker.avatarKey];
}

export function productWorkerDeviceLabel(
  state: ProductStateSnapshot | null,
  worker: ProductWorker,
): string {
  return (
    state?.devices.find((device) => device.id === worker.deviceId)?.name ??
    "Unassigned"
  );
}

export function activeProductRunForWorker(
  state: ProductStateSnapshot | null,
  workerId: string,
): ProductRun | null {
  return (
    state?.runs.find(
      (run) =>
        run.workerId === workerId &&
        (run.status === "running" ||
          run.status === "waiting_for_user" ||
          run.status === "blocked"),
    ) ?? null
  );
}

/**
 * EN: Returns the recent Agent-panel conversation for one worker in the current workspace snapshot.
 * 中文: 从当前 workspace 快照中返回某个 worker 最近的 Agent 面板对话历史。
 * @param state current product state snapshot.
 * @param workerId worker whose conversation should be restored.
 * @returns at most 100 displayable run events, oldest first.
 */
export function productAgentConversationEventsForWorker(
  state: ProductStateSnapshot | null,
  workerId: string,
): ProductRunEvent[] {
  if (!state) {
    return [];
  }
  const events = state.runEvents
    .filter((event) => event.workerId === workerId)
    .sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
    );
  return selectProductAgentConversationEvents(events).slice(0, 100).reverse();
}

export function installedProductWorkflowsForWorker(
  state: ProductStateSnapshot | null,
  workerId: string,
): ProductInstalledWorkflow[] {
  return (state?.installedWorkflows ?? []).filter(
    (workflow) => workflow.workerId === workerId,
  );
}

async function productRequest<T>(
  path: string,
  init: RequestInit = {},
  options: { timeoutMs?: number } = {},
): Promise<T> {
  return runtimeJsonRequest<T>(path, init, {
    fallbackErrorMessage: (status) =>
      `Request failed with ${status}. / 请求失败，状态码 ${status}。`,
    timeoutMs: options.timeoutMs,
  });
}
