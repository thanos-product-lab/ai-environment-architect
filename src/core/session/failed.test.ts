import { describe, expect, it } from "vitest";
import { newLog } from "../../../test/support/session.js";
import { recordFailedRecommendationRevision } from "./failed.js";

// Failed recommendation revisions (IMPL §4.4.1, §4.4.3). The other failed records are covered
// through the analyse calls in `analysis.test.ts`.

const failed = (recommendationId?: string) => ({
  ...(recommendationId === undefined ? {} : { recommendationId }),
  producedBy: "call_0004",
  itemKey: "r1",
  rejectedBy: ["REF-001", "REF-001", "SUP-003"],
  proposed: { key: "r1", content: "Run `pnpm test`." },
});

describe("failed recommendation revisions (IMPL §4.4.3)", () => {
  it("a new recommendation gets a new lineage at revision 1, superseding nothing", () => {
    const log = newLog();
    const record = recordFailedRecommendationRevision(log, failed());
    expect(record).toMatchObject({
      type: "recommendation_revision",
      id: "rrev_0001",
      recommendationId: "rec_0001",
      revision: 1,
      status: "failed_validation",
      rejectedBy: ["REF-001", "SUP-003"],
      proposed: { key: "r1", content: "Run `pnpm test`." },
    });
    expect(record).not.toHaveProperty("supersedes");
  });

  it("a revise or edit keeps the lineage with the next revision number, and supersedes nothing", () => {
    const log = newLog();
    const first = recordFailedRecommendationRevision(log, failed());
    const second = recordFailedRecommendationRevision(log, failed(first.recommendationId));
    expect(second).toMatchObject({ recommendationId: first.recommendationId, revision: 2 });
    expect(second).not.toHaveProperty("supersedes");
    expect(log.isSuperseded(first.id)).toBe(false);
  });

  it("a developer edit records developer_edit as its producer", () => {
    const log = newLog();
    expect(
      recordFailedRecommendationRevision(log, { ...failed(), producedBy: "developer_edit" }),
    ).toMatchObject({ producedBy: "developer_edit" });
  });
});
