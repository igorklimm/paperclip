import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres claim service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.claim — atomic compare-and-swap", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-claim-service-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string): Promise<string> {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent-${agentId.slice(0, 8)}`,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedIssue(input: {
    companyId: string;
    status?: string;
    assigneeAgentId?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      title: "Claimable work",
      status: input.status ?? "todo",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
    });
    return id;
  }

  it("claims an unassigned todo issue and bumps it to in_progress", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedIssue({ companyId });

    const result = await svc.claim({ id: issueId, agentId, companyId });

    expect(result.outcome).toBe("claimed");
    if (result.outcome !== "claimed") throw new Error("unreachable");
    expect(result.prevAssignee).toBeNull();
    expect(result.issue.assigneeAgentId).toBe(agentId);
    expect(result.issue.status).toBe("in_progress");
  });

  it("returns already_claimed with currentAssigneeAgentId when assigned to another agent", async () => {
    const companyId = await seedCompany();
    const owner = await seedAgent(companyId);
    const other = await seedAgent(companyId);
    const issueId = await seedIssue({ companyId, status: "in_progress", assigneeAgentId: owner });

    const result = await svc.claim({ id: issueId, agentId: other, companyId });

    expect(result.outcome).toBe("already_claimed");
    if (result.outcome !== "already_claimed") throw new Error("unreachable");
    expect(result.currentAssigneeAgentId).toBe(owner);
  });

  it("is idempotent for the rightful owner and bumps a still-todo re-claim to in_progress", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedIssue({ companyId, status: "todo", assigneeAgentId: agentId });

    const result = await svc.claim({ id: issueId, agentId, companyId });

    expect(result.outcome).toBe("claimed");
    if (result.outcome !== "claimed") throw new Error("unreachable");
    expect(result.prevAssignee).toBe(agentId);
    expect(result.issue.status).toBe("in_progress");
  });

  it("returns not_found for a cross-company issue id (no assignee leak)", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const ownerInA = await seedAgent(companyA);
    const callerInB = await seedAgent(companyB);
    const issueId = await seedIssue({ companyId: companyA, status: "in_progress", assigneeAgentId: ownerInA });

    const result = await svc.claim({ id: issueId, agentId: callerInB, companyId: companyB });

    expect(result).toEqual({ outcome: "not_found" });
  });

  it("does not change a non-todo status when claiming an unassigned issue", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedIssue({ companyId, status: "blocked" });

    const result = await svc.claim({ id: issueId, agentId, companyId });

    expect(result.outcome).toBe("claimed");
    if (result.outcome !== "claimed") throw new Error("unreachable");
    expect(result.issue.assigneeAgentId).toBe(agentId);
    expect(result.issue.status).toBe("blocked");
  });

  it("returns not_found for an unknown id", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    const result = await svc.claim({ id: randomUUID(), agentId, companyId });

    expect(result).toEqual({ outcome: "not_found" });
  });

  it("lets exactly one of N concurrent claimers win", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue({ companyId, status: "todo" });
    const claimerCount = 50;
    const claimerIds = await Promise.all(
      Array.from({ length: claimerCount }, () => seedAgent(companyId)),
    );

    const results = await Promise.all(
      claimerIds.map((agentId) => svc.claim({ id: issueId, agentId, companyId })),
    );

    const claimed = results.filter((r) => r.outcome === "claimed");
    const lost = results.filter((r) => r.outcome === "already_claimed");

    expect(claimed).toHaveLength(1);
    expect(lost).toHaveLength(claimerCount - 1);

    const winner = claimed[0];
    if (winner.outcome !== "claimed") throw new Error("unreachable");
    const winnerId = winner.issue.assigneeAgentId;
    expect(claimerIds).toContain(winnerId);

    // Every loser must point at the single winner.
    for (const loss of lost) {
      if (loss.outcome !== "already_claimed") throw new Error("unreachable");
      expect(loss.currentAssigneeAgentId).toBe(winnerId);
    }

    const persisted = await db
      .select({ assigneeAgentId: issues.assigneeAgentId, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(persisted?.assigneeAgentId).toBe(winnerId);
    expect(persisted?.status).toBe("in_progress");
  });
});
