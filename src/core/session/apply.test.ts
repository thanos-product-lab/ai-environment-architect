import { describe, expect, it } from "vitest";
import { MemoryDestination } from "../../../test/support/memory-destination.js";
import { MemorySession } from "../../../test/support/memory-store.js";
import {
  callDraft,
  completedCall,
  hashOf,
  newLog,
  tickingClock,
} from "../../../test/support/session.js";
import { parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import { sha256 } from "../hash.js";
import type { SnapshotFile } from "../snapshot/snapshot.js";
import {
  type ApplyDeps,
  applyArtifact,
  recoverApply,
  recoverInterruptedApply,
  temporaryName,
} from "./apply.js";
import { proposeArtifact, recordReview } from "./artifacts.js";
import { currentState } from "./current.js";
import type { Rescan } from "./freshness.js";
import { loadSession } from "./load.js";
import { SessionLog } from "./log.js";
import {
  type RecordOf,
  SESSION_FORMAT,
  SESSION_SCHEMA_VERSION,
  type SessionFile,
  type SessionRecord,
} from "./records.js";
import { contentRefOf, HeldSession } from "./store.js";

// Apply and recovery (DM §11.2, §17 "Absent and empty destinations are distinguished", "An
// interrupted apply recovers without repeating the write"; IMPL §2.9, §2.11, §4.4.1, §4.7, §4.11
// "Apply recovery").

const encode = (text: string) => new TextEncoder().encode(text);
const GUIDE = ["# Guide", "", "Intro.", ""].join("\n");

const HEADER: Omit<SessionFile, "records"> = {
  format: SESSION_FORMAT,
  schemaVersion: SESSION_SCHEMA_VERSION,
  writtenBy: "0.1.0",
  session: {
    id: "ses_0001",
    createdAt: "2026-11-01T10:15:00.000Z",
    productVersion: "0.1.0",
    adapter: "claude-code",
    outputScope: ["root CLAUDE.md"],
    repository: { name: "demo", root: "/r/demo" },
    targetPath: "CLAUDE.md",
  },
};

const OTHER_FILE: SnapshotFile = {
  path: "src/app.ts",
  status: "read",
  size: 1,
  hash: sha256(encode("app")),
};
const GUIDE_FILE: SnapshotFile = {
  path: "docs/guide.md",
  status: "read",
  size: 1,
  hash: sha256(encode("guide")),
};

interface Fixture {
  readonly session: HeldSession;
  readonly store: MemorySession;
  readonly artifact: RecordOf<"artifact_revision">;
  readonly review: RecordOf<"review">;
  readonly content: Uint8Array;
  readonly original: Uint8Array | undefined;
  readonly files: readonly SnapshotFile[];
}

/**
 * A saved session with one accepted recommendation assembled into an approved artifact revision.
 * `text` is the destination's content, or null when it is absent.
 */
async function approved(text: string | null = GUIDE): Promise<Fixture> {
  const log = newLog();
  log.start({
    type: "session_state",
    productVersion: "0.1.0",
    stage: "apply",
    status: "running",
  });
  log.start({
    type: "generation_config",
    settings: {
      snapshot: { maxReadableFileBytes: 1, userExclusions: [], includeIgnored: [] },
      context: {
        initialContextBytes: 1,
        knownFactsBytes: 1,
        tierCaps: { tier1: 0, tier2: 0, tier3: 0, tier4: 0, tier5: 0 },
        maxDestinationBytes: 0,
        perFileCaps: { tier2: 0, tier3: 0, tier5: 0 },
        testReserveBytes: 0,
        testExampleBytes: 0,
        maxSourceFiles: 0,
        sourceExtensions: [],
        treeDepth: 0,
        treeCollapseThreshold: 0,
      },
    },
    settingsHash: hashOf("9"),
    requestedModel: "claude-test",
    budget: { maxCostUsd: 2 },
    expansion: { maxExpansionRequests: 0, expansionBytes: 0, expansionEntryBytes: 0 },
    questionBudget: 5,
    retainModelInputs: false,
  });
  const original = text === null ? undefined : encode(text);
  const files: SnapshotFile[] = [GUIDE_FILE, OTHER_FILE];
  if (original !== undefined)
    files.unshift({
      path: "CLAUDE.md",
      status: "read",
      size: original.length,
      hash: sha256(original),
    });
  const parsed = original === undefined ? undefined : parseGuidanceBlocks(original);
  const snapshot = log.append({
    type: "snapshot",
    capturedAt: "2026-11-01T10:15:00.000Z",
    scope: { roots: ["."] },
    exclusions: [],
    files,
    destination:
      original === undefined || parsed === undefined
        ? { state: "absent" }
        : {
            state: "present",
            contentRef: contentRefOf(original),
            hash: sha256(original),
            blocks: parsed.blocks as never,
            lineEndings: parsed.lineEndings,
            roundTrip: parsed.roundTrip,
          },
    readFailures: [],
    stability: { state: "stable" },
    git: { state: "unknown", reason: "not_inspected" },
    ignoreRules: { state: "applied" },
  });
  const call = log.start(callDraft({ purpose: "recommend" }));
  log.revise("model_call", call.modelCallId, completedCall());
  const ev = log.append({
    type: "evidence",
    snapshotId: snapshot.id,
    kind: "lines",
    path: "docs/guide.md",
    fileHash: sha256(encode("guide")),
    lineStart: 1,
    lineEnd: 1,
    excerpt: "Guide.",
    basis: "documentation",
  });
  const finding = log.start({
    type: "finding",
    snapshotId: snapshot.id,
    producedBy: call.modelCallId,
    status: "active",
    kind: "claim",
    statement: "A guide exists.",
    mode: "descriptive",
    scope: { kind: "paths", paths: ["docs"] },
    basis: ["documentation"],
    evidenceIds: [ev.id],
  });
  const revision = log.start({
    type: "recommendation_revision",
    kind: "fact",
    operation: "add",
    target: { kind: "newSection", heading: "Docs" },
    content: "Read the guide.",
    rationale: "Helps.",
    support: [{ kind: "finding", findingId: finding.findingId }],
    references: [],
    scope: { kind: "repository" },
    producedBy: call.modelCallId,
    status: "valid",
  });
  log.append({
    type: "selection",
    recommendationId: revision.recommendationId,
    revisionId: revision.id,
    state: "accepted",
    actor: "developer",
    selectedAt: "2026-11-01T10:30:00.000Z",
  });
  const outcome = proposeArtifact(log, original);
  if (outcome.kind !== "created") throw new Error(outcome.kind);
  const review = recordReview(log, {
    artifactRevisionId: outcome.artifact.id,
    contentHash: outcome.artifact.proposedHash,
    outcome: "approved",
    actor: "developer",
    reviewedAt: "2026-11-01T10:40:00.000Z",
  });
  const store = new MemorySession();
  const session = new HeldSession(store, HEADER, log);
  const contents = [outcome.content, ...(original === undefined ? [] : [original])];
  await session.save({ contents, retained: [] });
  return {
    session,
    store,
    artifact: outcome.artifact,
    review,
    content: outcome.content,
    original,
    files,
  };
}

function destinationFor(f: Fixture): MemoryDestination {
  return f.original === undefined
    ? new MemoryDestination({ kind: "absent" })
    : new MemoryDestination({ kind: "file", bytes: f.original });
}

/** A rescan of the fixture's files, the destination as it is now, with `changes` applied. */
function rescanOf(
  f: Fixture,
  destination: MemoryDestination,
  changes: { files?: readonly SnapshotFile[] } = {},
): () => Promise<Rescan> {
  return async () => {
    const state = await destination.inspect();
    return {
      files: changes.files ?? f.files,
      stability: { state: "stable" },
      destination: state,
    } as Rescan;
  };
}

function deps(
  f: Fixture,
  destination: MemoryDestination,
  rescan = rescanOf(f, destination),
): ApplyDeps {
  return {
    destination,
    rescan,
    content: f.store,
    clock: tickingClock(Date.UTC(2026, 10, 1, 11, 0, 0)),
  };
}

const attempts = (records: readonly SessionRecord[]) =>
  records.filter((r): r is RecordOf<"apply_attempt"> => r.type === "apply_attempt");

async function savedRecords(store: MemorySession): Promise<readonly SessionRecord[]> {
  const bytes = store.sessionFile;
  if (bytes === undefined) throw new Error("nothing saved");
  const result = await loadSession(bytes, store);
  if (!result.ok) throw new Error(result.failure.detail);
  return result.file.records;
}

describe("apply (DM §11.2)", () => {
  it("records started, writes the approved bytes and records succeeded with the result hash", async () => {
    const f = await approved();
    const destination = destinationFor(f);
    const outcome = await applyArtifact(f.session, deps(f, destination));

    expect(outcome.kind).toBe("succeeded");
    expect(destination.text).toBe(new TextDecoder().decode(f.content));
    const [started, ended] = attempts(await savedRecords(f.store));
    expect(started).toMatchObject({
      revision: 1,
      state: "started",
      artifactRevisionId: f.artifact.id,
      reviewId: f.review.id,
      expectedOriginal: sha256(encode(GUIDE)),
      intendedHash: f.artifact.proposedHash,
      freshness: { state: "fresh" },
    });
    expect(ended).toMatchObject({
      revision: 2,
      applyAttemptId: started?.applyAttemptId,
      supersedes: [started?.id],
      state: "succeeded",
      resultHash: f.artifact.proposedHash,
      endedAt: { state: "known" },
    });
    expect(ended).not.toHaveProperty("error");
    expect(destination.temporaries.size).toBe(0);
  });

  it("saves the started attempt before the temporary file is written (step 4)", async () => {
    const f = await approved();
    let savedBeforeWrite: readonly SessionRecord[] = [];
    const destination = destinationFor(f);
    destination.hooks.writeTemporary = () => {
      // The store's file is what a crash here would leave.
      savedBeforeWrite = attempts(
        JSON.parse(new TextDecoder().decode(f.store.sessionFile)).records,
      );
      return { ok: true };
    };
    await applyArtifact(f.session, deps(f, destination));
    expect(savedBeforeWrite).toHaveLength(1);
    expect(savedBeforeWrite[0]).toMatchObject({ state: "started" });
  });

  it("writes the temporary file in the destination's directory, named after the attempt", async () => {
    const f = await approved();
    const destination = destinationFor(f);
    await applyArtifact(f.session, deps(f, destination));
    const [started] = attempts(f.session.records);
    const name = temporaryName(started?.applyAttemptId as string);
    expect(name).toBe(`.CLAUDE.md.${started?.applyAttemptId}.tmp`);
    expect(destination.operations).toEqual([
      "inspect", // step 1
      "inspect", // the rescan (step 3)
      `write ${name}`,
      "inspect", // the re-check (step 5)
      `replace ${name}`,
      "inspect", // the result (step 6)
    ]);
  });

  it("creates an absent destination, expecting `absent` (DM §17)", async () => {
    const f = await approved(null);
    const destination = destinationFor(f);
    const outcome = await applyArtifact(f.session, deps(f, destination));
    expect(outcome.kind).toBe("succeeded");
    expect(destination.text).toBe(new TextDecoder().decode(f.content));
    expect(attempts(f.session.records)[0]?.expectedOriginal).toBe("absent");
  });

  it("expects an empty destination by the empty file's hash, not `absent` (DM §17)", async () => {
    const f = await approved("");
    const destination = destinationFor(f);
    const outcome = await applyArtifact(f.session, deps(f, destination));
    expect(outcome.kind).toBe("succeeded");
    expect(attempts(f.session.records)[0]?.expectedOriginal).toBe(sha256(new Uint8Array()));
  });

  it("refuses without a usable approval, recording and writing nothing (step 2)", async () => {
    const f = await approved();
    await f.session.change((log) =>
      recordReview(log, {
        artifactRevisionId: f.artifact.id,
        contentHash: f.artifact.proposedHash,
        outcome: "rejected",
        actor: "developer",
        reviewedAt: "2026-11-01T10:45:00.000Z",
      }),
    );
    const destination = destinationFor(f);
    const outcome = await applyArtifact(f.session, deps(f, destination));
    expect(outcome).toEqual({ kind: "refused", reason: "no_usable_approval" });
    expect(attempts(f.session.records)).toHaveLength(0);
    expect(destination.operations.filter((op) => op !== "inspect")).toEqual([]);
  });

  it("refuses a symbolic link or a directory at the destination, recording and writing nothing (step 1)", async () => {
    for (const kind of ["symlink", "directory"] as const) {
      const f = await approved();
      const destination = new MemoryDestination({ kind });
      const outcome = await applyArtifact(f.session, deps(f, destination));
      expect(outcome).toEqual({
        kind: "refused",
        reason: "destination_unsafe",
        destination: {
          state: "unavailable",
          reason: kind === "symlink" ? "symlink" : "not_regular_file",
        },
      });
      expect(attempts(f.session.records)).toHaveLength(0);
      expect(destination.operations).toEqual(["inspect"]);
    }
  });

  it("records a blocked attempt and writes nothing when freshness blocks (step 3)", async () => {
    const f = await approved();
    const destination = MemoryDestination.file(`${GUIDE}Edited.\n`);
    const outcome = await applyArtifact(f.session, deps(f, destination));
    expect(outcome.kind).toBe("blocked");
    const recorded = attempts(await savedRecords(f.store));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      revision: 1,
      state: "blocked",
      freshness: {
        state: "blocked",
        blockers: [{ rule: "destination", from: sha256(encode(GUIDE)) }],
      },
      endedAt: { state: "known" },
    });
    expect(destination.writes).toBe(0);
    expect(destination.temporaries.size).toBe(0);
  });

  it("asks to acknowledge a warning, recording nothing, then records the acknowledged paths (IMPL §2.9)", async () => {
    const f = await approved();
    const destination = destinationFor(f);
    const changed = { ...OTHER_FILE, hash: sha256(encode("changed")) };
    const rescan = rescanOf(f, destination, {
      files: f.files.map((x) => (x.path === "src/app.ts" ? changed : x)),
    });

    const first = await applyArtifact(f.session, deps(f, destination, rescan));
    expect(first).toEqual({ kind: "needs_acknowledgement", changedPaths: ["src/app.ts"] });
    expect(attempts(f.session.records)).toHaveLength(0);
    expect(destination.writes).toBe(0);

    const other = await applyArtifact(f.session, deps(f, destination, rescan), {
      acknowledged: ["src/other.ts"],
    });
    expect(other.kind).toBe("needs_acknowledgement");
    expect(attempts(f.session.records)).toHaveLength(0);

    const second = await applyArtifact(f.session, deps(f, destination, rescan), {
      acknowledged: ["src/app.ts"],
    });
    expect(second.kind).toBe("succeeded");
    expect(attempts(f.session.records)[0]?.freshness).toEqual({
      state: "acknowledged",
      changedPaths: ["src/app.ts"],
    });
  });

  it("records failed and doesn't write when the destination changes after the temporary file (step 5)", async () => {
    const f = await approved();
    const destination = destinationFor(f);
    destination.hooks.afterTemporary = (d) => {
      d.node = { kind: "file", bytes: encode("# Someone else\n") };
    };
    const outcome = await applyArtifact(f.session, deps(f, destination));
    expect(outcome.kind).toBe("failed");
    expect(destination.text).toBe("# Someone else\n");
    expect(destination.writes).toBe(0);
    expect(destination.temporaries.size).toBe(0);
    expect(attempts(await savedRecords(f.store)).at(-1)).toMatchObject({
      state: "failed",
      error: { reason: "destination_changed", destination: sha256(encode("# Someone else\n")) },
    });
  });

  it("records failed when the temporary file or the rename fails, and removes the temporary file", async () => {
    for (const step of ["writeTemporary", "replace"] as const) {
      const f = await approved();
      const destination = destinationFor(f);
      destination.hooks[step] = () => ({ ok: false, reason: "no_space" });
      const outcome = await applyArtifact(f.session, deps(f, destination));
      expect(outcome.kind).toBe("failed");
      expect(destination.text).toBe(GUIDE);
      expect(destination.temporaries.size).toBe(0);
      expect(attempts(f.session.records).at(-1)).toMatchObject({
        state: "failed",
        error: { reason: "write_failed", detail: "no_space" },
      });
    }
  });

  it("records failed when the destination differs from the approved bytes after the rename (step 6)", async () => {
    const f = await approved();
    const destination = destinationFor(f);
    destination.hooks.afterReplace = (d) => {
      d.node = { kind: "file", bytes: encode("# Overwritten\n") };
    };
    const outcome = await applyArtifact(f.session, deps(f, destination));
    expect(outcome.kind).toBe("failed");
    const last = attempts(f.session.records).at(-1);
    expect(last).toMatchObject({
      state: "failed",
      error: { reason: "result_mismatch", destination: sha256(encode("# Overwritten\n")) },
    });
    expect(last).not.toHaveProperty("resultHash");
  });

  it("throws before recording anything when the stored content doesn't match the approved hash", async () => {
    const f = await approved();
    const destination = destinationFor(f);
    f.store.files.set(f.artifact.proposedContent, encode("tampered"));
    await expect(applyArtifact(f.session, deps(f, destination))).rejects.toThrow(/proposedHash/);
    expect(attempts(f.session.records)).toHaveLength(0);
    expect(destination.writes).toBe(0);
  });

  it("refuses while an earlier attempt is still started, until recovery runs", async () => {
    const f = await approved();
    const destination = destinationFor(f);
    destination.hooks.writeTemporary = () => {
      throw new Error("process stopped");
    };
    await expect(applyArtifact(f.session, deps(f, destination))).rejects.toThrow("process stopped");
    destination.hooks = {};
    const outcome = await applyArtifact(f.session, deps(f, destination));
    expect(outcome).toEqual({ kind: "refused", reason: "interrupted_attempt" });
  });

  it("leaves a file already at the temporary name alone, since it isn't this attempt's", async () => {
    const f = await approved();
    const destination = destinationFor(f);
    destination.hooks.writeTemporary = () => ({ ok: false, reason: "exists" });
    const outcome = await applyArtifact(f.session, deps(f, destination));
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(outcome).not.toHaveProperty("temporaryFileLeft");
    expect(destination.operations.some((op) => op.startsWith("remove"))).toBe(false);
  });

  it("names a temporary file it couldn't remove", async () => {
    const f = await approved();
    const destination = destinationFor(f);
    destination.hooks.replace = () => ({ ok: false, reason: "permission_denied" });
    destination.hooks.remove = () => ({ ok: false, reason: "permission_denied" });
    const outcome = await applyArtifact(f.session, deps(f, destination));
    const [started] = attempts(f.session.records);
    expect(outcome).toMatchObject({
      kind: "failed",
      temporaryFileLeft: temporaryName(started?.applyAttemptId as string),
    });
    expect(destination.temporaries.size).toBe(1);
  });

  it("runs freshness again after the acknowledgement, and records blocked if it now blocks", async () => {
    const f = await approved();
    const destination = destinationFor(f);
    const changedApp = { ...OTHER_FILE, hash: sha256(encode("changed")) };
    const changedGuide = { ...GUIDE_FILE, hash: sha256(encode("changed")) };
    let scans = 0;
    const rescan = async (): Promise<Rescan> => {
      scans++;
      const files = f.files.map((x) =>
        x.path === "src/app.ts"
          ? changedApp
          : scans > 1 && x.path === "docs/guide.md"
            ? changedGuide
            : x,
      );
      return {
        files,
        stability: { state: "stable" },
        destination: await destination.inspect(),
      } as Rescan;
    };
    const first = await applyArtifact(f.session, deps(f, destination, rescan));
    expect(first).toEqual({ kind: "needs_acknowledgement", changedPaths: ["src/app.ts"] });
    const second = await applyArtifact(f.session, deps(f, destination, rescan), {
      acknowledged: ["src/app.ts"],
    });
    expect(second.kind).toBe("blocked");
    expect(attempts(f.session.records)[0]?.freshness).toMatchObject({
      state: "blocked",
      blockers: [{ rule: "cited_file", path: "docs/guide.md" }],
    });
    expect(destination.writes).toBe(0);
  });
});

describe("apply recovery (DM §11.2, IMPL §2.11, §4.11)", () => {
  /** A session whose apply stopped at `stop`: before the temporary file, or after the rename. */
  async function interrupted(stop: "before_write" | "after_write", text: string | null = GUIDE) {
    const f = await approved(text);
    const destination = destinationFor(f);
    const crash = () => {
      throw new Error("process stopped");
    };
    if (stop === "before_write") destination.hooks.writeTemporary = crash;
    else destination.hooks.afterReplace = crash;
    await expect(applyArtifact(f.session, deps(f, destination))).rejects.toThrow("process stopped");
    destination.hooks = {};
    // Resume: load what was saved.
    const records = await savedRecords(f.store);
    expect(attempts(records).at(-1)?.state).toBe("started");
    const resumed = new HeldSession(f.store, HEADER, logOf(records));
    return { f, destination, resumed };
  }

  it("records succeeded without writing again when the destination holds the intended bytes", async () => {
    const { f, destination, resumed } = await interrupted("after_write");
    expect(destination.writes).toBe(1);
    const { attempts: recovered } = await recoverInterruptedApply(resumed, destination);
    expect(recovered).toEqual([
      expect.objectContaining({
        state: "succeeded",
        resultHash: f.artifact.proposedHash,
        endedAt: { state: "unknown", reason: "interrupted" },
      }),
    ]);
    expect(destination.writes).toBe(1);
    expect(attempts(await savedRecords(f.store)).at(-1)?.state).toBe("succeeded");
  });

  it("records failed with interrupted_before_write, removes the temporary file, and a retry is a new attempt under the same approval", async () => {
    const { f, destination, resumed } = await interrupted("before_write");
    const [started] = attempts(resumed.records);
    const name = temporaryName(started?.applyAttemptId as string);
    destination.temporaries.set(name, encode("partial"));

    const { attempts: recovered } = await recoverInterruptedApply(resumed, destination);
    expect(recovered).toEqual([
      expect.objectContaining({
        state: "failed",
        error: { reason: "interrupted_before_write" },
        endedAt: { state: "unknown", reason: "interrupted" },
      }),
    ]);
    expect(destination.temporaries.size).toBe(0);
    expect(destination.writes).toBe(0);
    expect(currentState(resumed.records).usableApproval?.id).toBe(f.review.id);

    const retry = await applyArtifact(resumed, deps(f, destination));
    expect(retry.kind).toBe("succeeded");
    const all = attempts(resumed.records);
    const lineages = [...new Set(all.map((a) => a.applyAttemptId))];
    expect(lineages).toHaveLength(2);
    expect(all.at(-1)).toMatchObject({ reviewId: f.review.id, state: "succeeded", revision: 2 });
  });

  it("records recovery_required, naming what the destination holds, when it matches neither", async () => {
    const { f, destination, resumed } = await interrupted("before_write");
    destination.node = { kind: "file", bytes: encode("# Someone else\n") };
    const { attempts: recovered } = await recoverInterruptedApply(resumed, destination);
    expect(recovered).toEqual([
      expect.objectContaining({
        state: "recovery_required",
        error: { reason: "destination_conflict", destination: sha256(encode("# Someone else\n")) },
      }),
    ]);
    expect(destination.text).toBe("# Someone else\n");
    void f;
  });

  it("treats an unavailable destination as matching neither", async () => {
    const { destination, resumed } = await interrupted("before_write");
    destination.node = { kind: "symlink" };
    const {
      attempts: [record],
    } = await recoverInterruptedApply(resumed, destination);
    expect(record).toMatchObject({
      state: "recovery_required",
      error: { reason: "destination_conflict", destination: "unavailable" },
    });
  });

  it("recovers an attempt on an absent destination: still absent, or now an empty file", async () => {
    const absent = await interrupted("before_write", null);
    const {
      attempts: [failed],
    } = await recoverInterruptedApply(absent.resumed, absent.destination);
    expect(failed).toMatchObject({
      state: "failed",
      error: { reason: "interrupted_before_write" },
    });

    const empty = await interrupted("before_write", null);
    empty.destination.node = { kind: "file", bytes: new Uint8Array() };
    const {
      attempts: [conflict],
    } = await recoverInterruptedApply(empty.resumed, empty.destination);
    expect(conflict).toMatchObject({
      state: "recovery_required",
      error: { reason: "destination_conflict", destination: sha256(new Uint8Array()) },
    });
  });

  it("a retry after recovery runs the freshness checks again", async () => {
    const { f, destination, resumed } = await interrupted("before_write");
    await recoverInterruptedApply(resumed, destination);
    const changedGuide = { ...GUIDE_FILE, hash: sha256(encode("changed")) };
    const rescan = rescanOf(f, destination, {
      files: f.files.map((x) => (x.path === "docs/guide.md" ? changedGuide : x)),
    });
    const retry = await applyArtifact(resumed, deps(f, destination, rescan));
    expect(retry.kind).toBe("blocked");
    expect(destination.writes).toBe(0);
  });

  it("names a temporary file recovery couldn't remove, and still records the outcome", async () => {
    const { destination, resumed } = await interrupted("before_write");
    const [started] = attempts(resumed.records);
    destination.hooks.remove = () => ({ ok: false, reason: "permission_denied" });
    const recovery = await recoverInterruptedApply(resumed, destination);
    expect(recovery.temporaryFilesLeft).toEqual([temporaryName(started?.applyAttemptId as string)]);
    expect(recovery.attempts[0]?.state).toBe("failed");
  });

  it("appends nothing and touches nothing when no attempt is started", async () => {
    const f = await approved();
    const destination = destinationFor(f);
    await applyArtifact(f.session, deps(f, destination));
    const operations = destination.operations.length;
    expect(await recoverInterruptedApply(f.session, destination)).toEqual({
      attempts: [],
      temporaryFilesLeft: [],
    });
    expect(destination.operations.length).toBe(operations);
  });

  it("recoverApply is a pure function of the records and the destination's state", () => {
    const log = newLog();
    expect(recoverApply(log, { state: "absent" })).toEqual([]);
  });
});

/** A log holding `records`, as a resumed session's. */
function logOf(records: readonly SessionRecord[]): SessionLog {
  return new SessionLog(
    { clock: tickingClock(Date.UTC(2026, 10, 1, 12, 0, 0)), ids: idsAfter(records) },
    records,
  );
}

/** IDs that continue past every ID in `records`. */
function idsAfter(records: readonly SessionRecord[]) {
  let n = records.length + 1000;
  return { next: (prefix: string) => `${prefix}_${String(n++).padStart(4, "0")}` };
}
