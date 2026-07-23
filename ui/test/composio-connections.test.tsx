import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposioConnections } from "../src/composio-connections";

const productRuntimeMock = vi.hoisted(() => ({
  fetchProductComposioOverview: vi.fn(),
  authorizeProductComposioToolkit: vi.fn(),
  fetchProductComposioConnection: vi.fn(),
  disconnectProductComposioConnection: vi.fn(),
}));

const runtimeEnvMock = vi.hoisted(() => ({
  openExternalUrl: vi.fn(),
}));

vi.mock("../src/product-runtime", () => productRuntimeMock);
vi.mock("../src/runtime-env", () => runtimeEnvMock);

beforeEach(() => {
  vi.clearAllMocks();
  runtimeEnvMock.openExternalUrl.mockResolvedValue(undefined);
  productRuntimeMock.disconnectProductComposioConnection.mockResolvedValue({
    disconnected: true,
    connectionId: "conn-github",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Composio high-density connections", () => {
  it("does not expose provider credentials while the initial check runs", async () => {
    const request = deferred<ReturnType<typeof overview>>();
    productRuntimeMock.fetchProductComposioOverview.mockReturnValue(
      request.promise,
    );

    render(<ComposioConnections language="en" />);

    expect(
      screen.getByText("Loading the application catalog..."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/service key/iu)).not.toBeInTheDocument();

    request.resolve(overview(false, []));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Application connections are temporarily unavailable.",
    );
    expect(screen.queryByText(/service key/iu)).not.toBeInTheDocument();
  });

  it("shows a retry when the initial hosted-provider check fails", async () => {
    productRuntimeMock.fetchProductComposioOverview
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce(overview(true, [toolkit("gmail", "Gmail")]));
    const user = userEvent.setup();

    render(<ComposioConnections language="en" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "provider unavailable",
    );
    expect(screen.queryByText(/service key/iu)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Gmail")).toBeInTheDocument();
  });

  it("renders the hosted-provider unavailable state in Chinese", async () => {
    productRuntimeMock.fetchProductComposioOverview.mockResolvedValue(
      overview(false, []),
    );

    render(<ComposioConnections language="zh" />);

    expect(
      await screen.findByRole("heading", { name: "连接应用" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("应用连接服务暂时不可用，请重新登录或稍后重试。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("全量工具目录")).not.toBeInTheDocument();
    expect(screen.queryByText(/Composio/u)).not.toBeInTheDocument();
  });

  it("loads the hosted application catalog without a key prompt", async () => {
    productRuntimeMock.fetchProductComposioOverview.mockResolvedValue(
      overview(true, [
        toolkit("github", "GitHub", { connected: true }),
        toolkit("gmail", "Gmail"),
        toolkit("notion", "Notion"),
        toolkit("hackernews", "Hacker News", {
          connected: true,
          noAuth: true,
        }),
      ]),
    );
    render(<ComposioConnections language="en" />);

    expect(await screen.findByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Gmail")).toBeInTheDocument();
    expect(screen.getByText("Notion")).toBeInTheDocument();
    expect(screen.queryByText("Hacker News")).not.toBeInTheDocument();
    expect(screen.queryByText("Dynamic discovery")).not.toBeInTheDocument();
    expect(screen.queryByText(/Composio/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/service key/iu)).not.toBeInTheDocument();
  });

  it("discards an old load-more page after the search query changes", async () => {
    const oldPage = deferred<ReturnType<typeof overview>>();
    productRuntimeMock.fetchProductComposioOverview
      .mockResolvedValueOnce({
        ...overview(true, [toolkit("github", "GitHub")]),
        nextCursor: "old-next-page",
        totalPages: 2,
      })
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce(overview(true, [toolkit("gmail", "Gmail")]));
    const user = userEvent.setup();

    render(<ComposioConnections language="en" />);

    expect(await screen.findByText("GitHub")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Load more applications" }),
    );
    await user.type(
      screen.getByPlaceholderText("Search every available application..."),
      "gmail",
    );
    expect(await screen.findByText("Gmail")).toBeInTheDocument();

    oldPage.resolve(overview(true, [toolkit("stale", "Stale result")]));
    await waitFor(() => {
      expect(screen.queryByText("Stale result")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Gmail")).toBeInTheDocument();
  });

  it("opens OAuth, polls to ACTIVE, and manages connected accounts", async () => {
    const github = toolkit("github", "GitHub", {
      connected: true,
      connections: [
        {
          id: "conn-github",
          toolkitSlug: "github",
          status: "ACTIVE",
          alias: "Work",
          statusReason: null,
          isDisabled: false,
          createdAt: null,
          updatedAt: null,
        },
      ],
    });
    const gmail = toolkit("gmail", "Gmail");
    productRuntimeMock.fetchProductComposioOverview.mockResolvedValue(
      overview(true, [github, gmail]),
    );
    productRuntimeMock.authorizeProductComposioToolkit.mockResolvedValue({
      connectionId: "conn-gmail",
      redirectUrl: "https://connect.composio.dev/conn-gmail",
      status: "INITIATED",
    });
    productRuntimeMock.fetchProductComposioConnection.mockResolvedValue({
      connection: {
        id: "conn-gmail",
        toolkitSlug: "gmail",
        status: "ACTIVE",
        alias: null,
        statusReason: null,
        isDisabled: false,
        createdAt: null,
        updatedAt: null,
      },
    });
    const user = userEvent.setup();
    render(<ComposioConnections language="en" />);

    const gmailCard = (await screen.findByText("Gmail")).closest("article");
    expect(gmailCard).not.toBeNull();
    await user.click(
      within(gmailCard!).getByRole("button", { name: "Connect" }),
    );
    await waitFor(() =>
      expect(runtimeEnvMock.openExternalUrl).toHaveBeenCalledWith(
        "https://connect.composio.dev/conn-gmail",
      ),
    );
    expect(
      productRuntimeMock.authorizeProductComposioToolkit,
    ).toHaveBeenCalledWith({
      toolkitSlug: "gmail",
      options: { toolkitName: "Gmail", language: "en" },
    });
    expect(
      await screen.findByText(
        "Connection complete. This application is ready for AI workers.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done" }));

    const githubCard = screen.getByText("GitHub").closest("article");
    await user.click(
      within(githubCard!).getByRole("button", { name: "Manage" }),
    );
    const manageDialog = screen.getByRole("dialog", {
      name: "GitHub connections",
    });
    expect(within(manageDialog).getByText("Work")).toBeInTheDocument();
    await user.click(
      within(manageDialog).getByRole("button", { name: "Disconnect" }),
    );
    await waitFor(() =>
      expect(
        productRuntimeMock.disconnectProductComposioConnection,
      ).toHaveBeenCalledWith("conn-github"),
    );
  });

  it("serializes connect mutations across every toolkit", async () => {
    const authorization = deferred<{
      connectionId: string;
      redirectUrl: string;
      status: string;
    }>();
    productRuntimeMock.fetchProductComposioOverview.mockResolvedValue(
      overview(true, [toolkit("github", "GitHub"), toolkit("gmail", "Gmail")]),
    );
    productRuntimeMock.authorizeProductComposioToolkit.mockReturnValue(
      authorization.promise,
    );
    const user = userEvent.setup();
    render(<ComposioConnections language="en" />);

    const githubCard = (await screen.findByText("GitHub")).closest("article")!;
    const gmailCard = screen.getByText("Gmail").closest("article")!;
    const githubConnect = within(githubCard).getByRole("button", {
      name: "Connect",
    });
    const gmailConnect = within(gmailCard).getByRole("button", {
      name: "Connect",
    });
    await user.click(githubConnect);
    await waitFor(() => expect(gmailConnect).toBeDisabled());
    await user.click(gmailConnect);
    expect(
      productRuntimeMock.authorizeProductComposioToolkit,
    ).toHaveBeenCalledTimes(1);

    authorization.resolve({
      connectionId: "conn-github",
      redirectUrl: "https://connect.example/conn-github",
      status: "ACTIVE",
    });
    await waitFor(() =>
      expect(runtimeEnvMock.openExternalUrl).toHaveBeenCalled(),
    );
  });

  it("serializes disconnect mutations and removes only the completed account", async () => {
    const firstDisconnect = deferred<{
      disconnected: boolean;
      connectionId: string;
    }>();
    const github = toolkit("github", "GitHub", {
      connected: true,
      connections: [
        connection("conn-one", "github", "First account"),
        connection("conn-two", "github", "Second account"),
      ],
    });
    productRuntimeMock.fetchProductComposioOverview.mockResolvedValue(
      overview(true, [github]),
    );
    productRuntimeMock.disconnectProductComposioConnection.mockReturnValueOnce(
      firstDisconnect.promise,
    );
    const user = userEvent.setup();
    render(<ComposioConnections language="en" />);

    const githubCard = (await screen.findByText("GitHub")).closest("article")!;
    await user.click(
      within(githubCard).getByRole("button", { name: "Manage" }),
    );
    const dialog = screen.getByRole("dialog", { name: "GitHub connections" });
    const disconnectButtons = within(dialog).getAllByRole("button", {
      name: "Disconnect",
    });
    await user.click(disconnectButtons[0]);
    await waitFor(() => expect(disconnectButtons[1]).toBeDisabled());
    await user.click(disconnectButtons[1]);
    expect(
      productRuntimeMock.disconnectProductComposioConnection,
    ).toHaveBeenCalledTimes(1);
    expect(
      productRuntimeMock.disconnectProductComposioConnection,
    ).toHaveBeenCalledWith("conn-one");

    firstDisconnect.resolve({ disconnected: true, connectionId: "conn-one" });
    await waitFor(() =>
      expect(
        within(dialog).queryByText("First account"),
      ).not.toBeInTheDocument(),
    );
    expect(within(dialog).getByText("Second account")).toBeVisible();
  });

  it("does not overlap authorization polling requests", async () => {
    const slowPoll = deferred<{
      connection: ReturnType<typeof connection>;
    }>();
    productRuntimeMock.fetchProductComposioOverview.mockResolvedValue(
      overview(true, [toolkit("gmail", "Gmail")]),
    );
    productRuntimeMock.authorizeProductComposioToolkit.mockResolvedValue({
      connectionId: "conn-gmail",
      redirectUrl: "https://connect.example/conn-gmail",
      status: "INITIATED",
    });
    productRuntimeMock.fetchProductComposioConnection
      .mockReturnValueOnce(slowPoll.promise)
      .mockResolvedValueOnce({
        connection: connection("conn-gmail", "gmail", null, "ACTIVE"),
      });
    const user = userEvent.setup();
    render(<ComposioConnections language="en" />);

    const card = (await screen.findByText("Gmail")).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(
        productRuntimeMock.fetchProductComposioConnection,
      ).toHaveBeenCalledTimes(1),
    );

    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(
      productRuntimeMock.fetchProductComposioConnection,
    ).toHaveBeenCalledTimes(1);

    await act(async () => {
      slowPoll.resolve({
        connection: connection("conn-gmail", "gmail", null, "INITIATED"),
      });
      await slowPoll.promise;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(
      productRuntimeMock.fetchProductComposioConnection,
    ).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      productRuntimeMock.fetchProductComposioConnection,
    ).toHaveBeenCalledTimes(2);
  });
});

function providerStatus(configured: boolean) {
  return {
    id: "composio" as const,
    configured,
    apiKeySource: configured ? ("hosted" as const) : ("none" as const),
    sessionReady: configured,
    sessionId: configured ? "session-full" : null,
    lastError: null,
    features: {
      unrestrictedToolkits: true as const,
      dynamicDiscovery: true as const,
      fullToolCatalog: true as const,
      remoteSandbox: true as const,
      mcp: true as const,
    },
  };
}

function overview(configured: boolean, items: ReturnType<typeof toolkit>[]) {
  return {
    provider: providerStatus(configured),
    items,
    nextCursor: null,
    totalPages: configured ? 1 : 0,
  };
}

function toolkit(
  slug: string,
  name: string,
  input: {
    connected?: boolean;
    noAuth?: boolean;
    connections?: Array<{
      id: string;
      toolkitSlug: string;
      status: string;
      alias: string | null;
      statusReason: string | null;
      isDisabled: boolean;
      createdAt: string | null;
      updatedAt: string | null;
    }>;
  } = {},
) {
  return {
    slug,
    name,
    logo: null,
    noAuth: input.noAuth ?? false,
    connected: input.connected ?? false,
    connections: input.connections ?? [],
  };
}

function connection(
  id: string,
  toolkitSlug: string,
  alias: string | null,
  status = "ACTIVE",
) {
  return {
    id,
    toolkitSlug,
    status,
    alias,
    statusReason: null,
    isDisabled: false,
    createdAt: null,
    updatedAt: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
