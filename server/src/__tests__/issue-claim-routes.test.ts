import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const callerAgentId = "11111111-1111-4111-8111-111111111111";
const otherAgentId = "22222222-2222-4222-8222-222222222222";
const companyId = "company-1";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueService = vi.hoisted(() => ({
  claim: vi.fn(),
  getById: vi.fn(async () => null),
  getByIdentifier: vi.fn(async () => null),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
  }),
  companyService: () => ({
    getById: vi.fn(async () => ({ id: companyId, attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => [companyId]),
  }),
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

type TestActor = Record<string, unknown>;

async function createApp(actor: TestActor) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

const agentActor: TestActor = {
  type: "agent",
  agentId: callerAgentId,
  companyId,
  source: "agent_key",
};

function makeIssue(input: { id: string; status?: string; assigneeAgentId?: string | null }) {
  return {
    id: input.id,
    companyId,
    identifier: "PAP-9000",
    title: "Claimable work",
    description: null,
    status: input.status ?? "in_progress",
    priority: "medium",
    parentId: null,
    assigneeAgentId: input.assigneeAgentId ?? callerAgentId,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    executionWorkspaceId: null,
    labels: [],
    labelIds: [],
  };
}

describe("POST /issues/:id/claim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects non-agent (board) actors with agent_scope_required", async () => {
    const boardActor: TestActor = {
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
    };
    const res = await request(await createApp(boardActor)).post("/api/issues/issue-1/claim");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, reason: "agent_scope_required" });
    expect(mockIssueService.claim).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("claims an unassigned issue, returns 200, and wakes the winner", async () => {
    const issue = makeIssue({ id: "issue-1", status: "in_progress", assigneeAgentId: callerAgentId });
    mockIssueService.claim.mockResolvedValue({ outcome: "claimed", issue, prevAssignee: null });

    const res = await request(await createApp(agentActor)).post("/api/issues/issue-1/claim");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, claimed: true, issue });
    expect(mockIssueService.claim).toHaveBeenCalledWith({
      id: "issue-1",
      agentId: callerAgentId,
      companyId,
    });
    expect(mockWakeup).toHaveBeenCalledWith(
      callerAgentId,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        payload: expect.objectContaining({ issueId: "issue-1", mutation: "claim" }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.claimed",
        entityId: "issue-1",
        details: expect.objectContaining({ prevAssignee: null, result: "claimed" }),
      }),
    );
  });

  it("returns 409 with currentAssigneeAgentId when the issue is already claimed by another agent", async () => {
    mockIssueService.claim.mockResolvedValue({
      outcome: "already_claimed",
      currentAssigneeAgentId: otherAgentId,
    });

    const res = await request(await createApp(agentActor)).post("/api/issues/issue-1/claim");

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      ok: false,
      claimed: false,
      currentAssigneeAgentId: otherAgentId,
      reason: "already_claimed",
    });
    expect(mockWakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("returns 404 issue_not_found (with reason) for unknown or cross-tenant ids", async () => {
    mockIssueService.claim.mockResolvedValue({ outcome: "not_found" });

    const res = await request(await createApp(agentActor)).post("/api/issues/issue-x/claim");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, reason: "issue_not_found" });
    expect(res.body.currentAssigneeAgentId).toBeUndefined();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("is idempotent for the rightful owner and does not re-wake", async () => {
    const issue = makeIssue({ id: "issue-1", status: "in_progress", assigneeAgentId: callerAgentId });
    mockIssueService.claim.mockResolvedValue({ outcome: "claimed", issue, prevAssignee: callerAgentId });

    const res = await request(await createApp(agentActor)).post("/api/issues/issue-1/claim");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, claimed: true, issue });
    expect(issue.status).toBe("in_progress");
    expect(mockWakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.claimed",
        details: expect.objectContaining({ prevAssignee: callerAgentId }),
      }),
    );
  });
});
