import { describe, expect, it } from "vitest";
import { hashOf, newLog } from "../../../test/support/session.js";
import { pathHash } from "../context/secrets.js";
import type { Hash } from "../hash.js";
import type { SnapshotFile } from "../snapshot/snapshot.js";
import { acknowledgeWarnings, checkFreshness, type Rescan } from "./freshness.js";
import type { Revised, SessionLog } from "./log.js";

// Tiered freshness (DM §11.1, §16 D, §17 "Freshness blocks relevant changes, warns on unrelated
// ones, and records acknowledgement").

const DEST = hashOf("d");
const file = (path: string, hash: Hash = hashOf("1")): SnapshotFile => ({
  path,
  status: "read",
  size: 1,
  hash,
});

const BASE: readonly SnapshotFile[] = [
  file("CLAUDE.md", DEST),
  file("docs/guide.md"),
  file("src/api/client.ts"),
  file("src/web/app.ts"),
];

type Scope = { kind: "repository" } | { kind: "paths"; paths: string[] };
type Support = Revised<"recommendation_revision">["support"];
type Reference = Revised<"recommendation_revision">["references"][number];

interface Fixture {
  readonly log: SessionLog;
  readonly snapshotId: string;
}

function fixture(
  files: readonly SnapshotFile[] = BASE,
  destination: { state: "absent" } | { state: "present"; hash: Hash } = {
    state: "present",
    hash: DEST,
  },
): Fixture {
  const log = newLog();
  const snapshot = log.append({
    type: "snapshot",
    capturedAt: "2026-11-01T10:15:00.000Z",
    scope: { roots: ["."] },
    exclusions: [],
    files: [...files],
    destination:
      destination.state === "absent"
        ? { state: "absent" }
        : {
            state: "present",
            contentRef: `content/sha256-${destination.hash.slice(7)}`,
            hash: destination.hash,
            blocks: [],
            lineEndings: { style: "none", counts: { lf: 0, crlf: 0, cr: 0 } },
            roundTrip: { state: "verified" },
          },
    readFailures: [],
    stability: { state: "stable" },
    git: { state: "unknown", reason: "not_inspected" },
    ignoreRules: { state: "applied" },
  } as never) as { id: string };
  return { log, snapshotId: snapshot.id };
}

/** A claim citing `paths` (lines evidence for the first, entry evidence for the rest). */
function finding(f: Fixture, paths: readonly string[], scope: Scope = { kind: "repository" }) {
  const evidenceIds = paths.map(
    (path, i) =>
      f.log.append(
        i === 0
          ? {
              type: "evidence",
              snapshotId: f.snapshotId,
              kind: "lines",
              path,
              fileHash: hashOf("1"),
              lineStart: 1,
              lineEnd: 1,
              excerpt: "x",
              basis: "documentation",
            }
          : {
              type: "evidence",
              snapshotId: f.snapshotId,
              kind: "entry",
              path,
              fileHash: hashOf("1"),
              basis: "code_observation",
            },
      ).id,
  );
  return f.log.start({
    type: "finding",
    snapshotId: f.snapshotId,
    producedBy: "call_0001",
    status: "active",
    kind: "claim",
    statement: "A claim.",
    mode: "descriptive",
    scope,
    basis: ["documentation"],
    evidenceIds,
  }).findingId;
}

function recommendation(f: Fixture, support: Support, references: Reference[] = []) {
  return f.log.start({
    type: "recommendation_revision",
    kind: "fact",
    operation: "add",
    target: { kind: "newSection", heading: "New" },
    content: "Text.",
    rationale: "Helps.",
    support,
    references,
    scope: { kind: "repository" },
    producedBy: "call_0003",
    status: "valid",
  }).id;
}

function decision(f: Fixture, link: { questionId?: string; conflictId?: string }) {
  return f.log.append({
    type: "decision",
    statement: "Use the client.",
    scope: { kind: "repository" },
    exceptions: [],
    ...link,
    origin: "answered_question",
    actor: "developer",
    decidedAt: "2026-11-01T10:20:00.000Z",
  }).id;
}

function rescan(files: readonly SnapshotFile[] = BASE, extra: Partial<Rescan> = {}): Rescan {
  return {
    files: [...files],
    destination: { state: "present", hash: DEST },
    stability: { state: "stable" },
    ...extra,
  };
}

const replace = (files: readonly SnapshotFile[], next: SnapshotFile) =>
  files.map((f) => (f.path === next.path ? next : f));
const without = (files: readonly SnapshotFile[], path: string) =>
  files.filter((f) => f.path !== path);
const check = (f: Fixture, selected: string[], scan: Rescan) =>
  checkFreshness(f.log.records, { snapshotId: f.snapshotId, selectedRevisionIds: selected }, scan);

describe("tiered freshness (DM §11.1)", () => {
  it("is fresh when the rescan matches the snapshot", () => {
    const f = fixture();
    const r = recommendation(f, [{ kind: "finding", findingId: finding(f, ["docs/guide.md"]) }]);
    expect(check(f, [r], rescan())).toEqual({ state: "fresh" });
  });

  describe("blocks when the destination changed", () => {
    it("absent → present (DM §16 A)", () => {
      const f = fixture(without(BASE, "CLAUDE.md"), { state: "absent" });
      const r = recommendation(f, [{ kind: "finding", findingId: finding(f, ["docs/guide.md"]) }]);
      // A repository-scoped finding: the destination is named only by its own rule.
      expect(check(f, [r], rescan())).toEqual({
        state: "blocked",
        blockers: [{ rule: "destination", from: "absent", to: DEST }],
        changedPaths: [],
      });
    });

    it("present → absent", () => {
      const f = fixture();
      const r = recommendation(f, [{ kind: "finding", findingId: finding(f, ["docs/guide.md"]) }]);
      const result = check(
        f,
        [r],
        rescan(without(BASE, "CLAUDE.md"), { destination: { state: "absent" } }),
      );
      expect(result).toMatchObject({
        state: "blocked",
        blockers: [{ rule: "destination", from: DEST, to: "absent" }],
      });
    });

    it("a different hash", () => {
      const f = fixture();
      const r = recommendation(f, [{ kind: "finding", findingId: finding(f, ["docs/guide.md"]) }]);
      const other = hashOf("e");
      const result = check(
        f,
        [r],
        rescan(replace(BASE, file("CLAUDE.md", other)), {
          destination: { state: "present", hash: other },
        }),
      );
      expect(result).toEqual({
        state: "blocked",
        blockers: [{ rule: "destination", from: DEST, to: other }],
        changedPaths: [],
      });
    });

    it("present → unavailable", () => {
      const f = fixture();
      const r = recommendation(f, [{ kind: "finding", findingId: finding(f, ["docs/guide.md"]) }]);
      const result = check(
        f,
        [r],
        rescan(replace(BASE, { path: "CLAUDE.md", status: "symlink", target: "x" }), {
          destination: { state: "unavailable", reason: "symlink" },
        }),
      );
      expect(result).toMatchObject({
        blockers: [{ rule: "destination", from: DEST, to: "unavailable" }],
      });
    });
  });

  describe("blocks when a cited file changed or was removed", () => {
    it("lines evidence of a supporting finding changed", () => {
      const f = fixture();
      const id = finding(f, ["src/api/client.ts"]);
      const r = recommendation(f, [{ kind: "finding", findingId: id }]);
      const result = check(f, [r], rescan(replace(BASE, file("src/api/client.ts", hashOf("2")))));
      expect(result).toEqual({
        state: "blocked",
        blockers: [
          { rule: "cited_file", path: "src/api/client.ts", change: "changed", findingId: id },
        ],
        changedPaths: [],
      });
    });

    it("entry evidence of a supporting finding was removed (DM §16 D)", () => {
      const f = fixture();
      const id = finding(f, ["docs/guide.md", "src/api/client.ts"], {
        kind: "paths",
        paths: ["docs"],
      });
      const r = recommendation(f, [{ kind: "finding", findingId: id }]);
      expect(check(f, [r], rescan(without(BASE, "src/api/client.ts")))).toEqual({
        state: "blocked",
        blockers: [
          { rule: "cited_file", path: "src/api/client.ts", change: "removed", findingId: id },
        ],
        changedPaths: [],
      });
    });

    it("a finding a supporting decision's question resolves", () => {
      const f = fixture();
      const id = finding(f, ["src/api/client.ts"], { kind: "paths", paths: ["src/api"] });
      const q = f.log.start({
        type: "question",
        producedBy: "call_0002",
        prompt: "Which?",
        reason: "Unclear.",
        findingIds: [id],
        conflictIds: [],
        gapIds: [],
        options: [],
        scope: { kind: "repository" },
        status: "answered",
      });
      const r = recommendation(f, [
        { kind: "decision", decisionId: decision(f, { questionId: q.questionId }) },
      ]);
      const result = check(f, [r], rescan(replace(BASE, file("src/api/client.ts", hashOf("2")))));
      expect(result).toMatchObject({
        state: "blocked",
        blockers: [{ rule: "cited_file", path: "src/api/client.ts", findingId: id }],
      });
    });

    it("a member of a conflict that a supporting decision's question resolves", () => {
      const f = fixture();
      const a = finding(f, ["docs/guide.md"], { kind: "paths", paths: ["docs"] });
      const b = finding(f, ["src/web/app.ts"], { kind: "paths", paths: ["src/web"] });
      const conflict = f.log.start({
        type: "conflict",
        snapshotId: f.snapshotId,
        producedBy: "call_0001",
        findingIds: [a, b],
        description: "They disagree.",
        status: "unresolved",
      });
      const q = f.log.start({
        type: "question",
        producedBy: "call_0002",
        prompt: "Which?",
        reason: "They disagree.",
        findingIds: [],
        conflictIds: [conflict.conflictId],
        gapIds: [],
        options: [],
        scope: { kind: "repository" },
        status: "answered",
      });
      const r = recommendation(f, [
        { kind: "decision", decisionId: decision(f, { questionId: q.questionId }) },
      ]);
      const result = check(f, [r], rescan(replace(BASE, file("src/web/app.ts", hashOf("2")))));
      expect(result).toMatchObject({
        blockers: [{ rule: "cited_file", path: "src/web/app.ts", findingId: b }],
      });
    });

    it("a member of a supporting decision's conflict", () => {
      const f = fixture();
      const a = finding(f, ["docs/guide.md"], { kind: "paths", paths: ["docs"] });
      const b = finding(f, ["src/web/app.ts"], { kind: "paths", paths: ["src/web"] });
      const conflict = f.log.start({
        type: "conflict",
        snapshotId: f.snapshotId,
        producedBy: "call_0001",
        findingIds: [a, b],
        description: "They disagree.",
        status: "unresolved",
      });
      const r = recommendation(f, [
        { kind: "decision", decisionId: decision(f, { conflictId: conflict.conflictId }) },
      ]);
      const result = check(f, [r], rescan(without(BASE, "docs/guide.md")));
      expect(result).toMatchObject({
        blockers: [{ rule: "cited_file", path: "docs/guide.md", change: "removed", findingId: a }],
      });
    });

    it("names each path once, with the first finding in support order", () => {
      const f = fixture();
      const a = finding(f, ["src/api/client.ts"], { kind: "paths", paths: ["src/api"] });
      const b = finding(f, ["src/api/client.ts"], { kind: "paths", paths: ["src/api"] });
      const r1 = recommendation(f, [{ kind: "finding", findingId: b }]);
      const r2 = recommendation(f, [{ kind: "finding", findingId: a }]);
      const result = check(
        f,
        [r1, r2],
        rescan(replace(BASE, file("src/api/client.ts", hashOf("2")))),
      );
      expect(result).toMatchObject({
        blockers: [{ rule: "cited_file", path: "src/api/client.ts", findingId: b }],
      });
    });
  });

  describe("blocks when a path reference no longer exists", () => {
    const pathRef = (findingId: string, value: string): Reference => ({
      kind: "path",
      value,
      supportingFindingId: findingId,
      evidenceId: "ev_0001",
      verification: "exists_in_snapshot",
    });

    it("a referenced file is gone", () => {
      const f = fixture([...BASE, file("src/lib/util.ts")]);
      const id = finding(f, ["docs/guide.md"], { kind: "paths", paths: ["docs"] });
      const r = recommendation(
        f,
        [{ kind: "finding", findingId: id }],
        [pathRef(id, "src/lib/util.ts")],
      );
      expect(check(f, [r], rescan(BASE))).toEqual({
        state: "blocked",
        blockers: [{ rule: "missing_reference", value: "src/lib/util.ts", revisionId: r }],
        changedPaths: [],
      });
    });

    it("a directory reference, normalised, exists while it holds a listed path", () => {
      const f = fixture();
      const id = finding(f, ["docs/guide.md"], { kind: "paths", paths: ["docs"] });
      const r = recommendation(
        f,
        [{ kind: "finding", findingId: id }],
        [pathRef(id, "./src/api/")],
      );
      const kept = check(f, [r], rescan([...BASE, file("src/api/other.ts")]));
      expect(kept).toEqual({ state: "warn", changedPaths: ["src/api/other.ts"] });
      const gone = check(f, [r], rescan(without(BASE, "src/api/client.ts")));
      expect(gone).toMatchObject({
        state: "blocked",
        blockers: [{ rule: "missing_reference", value: "./src/api/", revisionId: r }],
        changedPaths: ["src/api/client.ts"],
      });
    });
  });

  describe("blocks when files are added or removed within a supporting finding's scope", () => {
    it("a path scope covers everything under the directory it names", () => {
      const f = fixture();
      const id = finding(f, ["docs/guide.md"], { kind: "paths", paths: ["src/api"] });
      const r = recommendation(f, [{ kind: "finding", findingId: id }]);
      expect(check(f, [r], rescan([...BASE, file("src/api/deep/new.ts")]))).toEqual({
        state: "blocked",
        blockers: [{ rule: "scope", path: "src/api/deep/new.ts", change: "added", findingId: id }],
        changedPaths: [],
      });
    });

    it("a glob scope covers a directory it matches", () => {
      const f = fixture();
      const id = finding(f, ["docs/guide.md"], { kind: "paths", paths: ["src/*"] });
      const r = recommendation(f, [{ kind: "finding", findingId: id }]);
      expect(check(f, [r], rescan(without(BASE, "src/web/app.ts")))).toMatchObject({
        blockers: [{ rule: "scope", path: "src/web/app.ts", change: "removed", findingId: id }],
      });
    });

    it("a repository scope covers anywhere in scope", () => {
      const f = fixture();
      const id = finding(f, ["docs/guide.md"]);
      const r = recommendation(f, [{ kind: "finding", findingId: id }]);
      expect(check(f, [r], rescan([...BASE, file("tools/x.sh")]))).toMatchObject({
        blockers: [{ rule: "scope", path: "tools/x.sh", change: "added", findingId: id }],
      });
    });

    it("an addition outside the scope only warns", () => {
      const f = fixture();
      const id = finding(f, ["docs/guide.md"], { kind: "paths", paths: ["src/api"] });
      const r = recommendation(f, [{ kind: "finding", findingId: id }]);
      expect(check(f, [r], rescan([...BASE, file("src/apiary.ts")]))).toEqual({
        state: "warn",
        changedPaths: ["src/apiary.ts"],
      });
    });

    it("a change inside the scope to a file no evidence cites only warns", () => {
      const f = fixture();
      const id = finding(f, ["docs/guide.md"], { kind: "paths", paths: ["src/api"] });
      const r = recommendation(f, [{ kind: "finding", findingId: id }]);
      expect(check(f, [r], rescan(replace(BASE, file("src/api/client.ts", hashOf("2")))))).toEqual({
        state: "warn",
        changedPaths: ["src/api/client.ts"],
      });
    });
  });

  describe("warns on unrelated changes (DM §16 D)", () => {
    it("a finding that supports no selected revision doesn't block", () => {
      const f = fixture();
      const used = finding(f, ["docs/guide.md"], { kind: "paths", paths: ["docs"] });
      const unused = finding(f, ["src/web/app.ts"]);
      const r = recommendation(f, [{ kind: "finding", findingId: used }]);
      recommendation(f, [{ kind: "finding", findingId: unused }]);
      expect(check(f, [r], rescan(replace(BASE, file("src/web/app.ts", hashOf("2")))))).toEqual({
        state: "warn",
        changedPaths: ["src/web/app.ts"],
      });
    });

    it("lists changed, added and removed paths in bytewise order, under any file order", () => {
      const f = fixture([...BASE, file("z/old.ts")]);
      const id = finding(f, ["docs/guide.md"], { kind: "paths", paths: ["docs"] });
      const r = recommendation(f, [{ kind: "finding", findingId: id }]);
      // U+FF5E sorts before U+1F600 by bytes, after it by UTF-16 code units.
      const next = [
        ...replace(BASE, file("src/web/app.ts", hashOf("2"))),
        file("a/\u{1F600}.ts"),
        file("a/～.ts"),
      ];
      const expected = {
        state: "warn",
        changedPaths: ["a/～.ts", "a/\u{1F600}.ts", "src/web/app.ts", "z/old.ts"],
      };
      expect(check(f, [r], rescan(next))).toEqual(expected);
      expect(check(f, [r], rescan([...next].reverse()))).toEqual(expected);
    });

    it("a blocked result also lists the changed paths no blocking rule names", () => {
      const f = fixture();
      const id = finding(f, ["src/api/client.ts"], { kind: "paths", paths: ["src/api"] });
      const r = recommendation(f, [{ kind: "finding", findingId: id }]);
      const next = replace(
        replace(BASE, file("src/api/client.ts", hashOf("2"))),
        file("src/web/app.ts", hashOf("2")),
      );
      expect(check(f, [r], rescan(next))).toMatchObject({
        state: "blocked",
        changedPaths: ["src/web/app.ts"],
      });
    });
  });

  describe("what counts as a change", () => {
    const f = fixture([
      ...BASE,
      { path: "link", status: "symlink", target: "docs" },
      { path: "locked.txt", status: "unreadable", kind: "file", reason: "permission_denied" },
      { path: "node_modules", status: "excluded", kind: "directory", rule: "node_modules" },
    ] as SnapshotFile[]);
    const id = finding(f, ["docs/guide.md"], { kind: "paths", paths: ["docs"] });
    const r = recommendation(f, [{ kind: "finding", findingId: id }]);
    const base = f.log.records.find((x) => x.type === "snapshot")?.files as SnapshotFile[];

    it("the same bytes under another hashed status are unchanged", () => {
      const next = replace(base, {
        path: "src/web/app.ts",
        status: "ignored",
        kind: "file",
        size: 1,
        hash: hashOf("1"),
      });
      expect(check(f, [r], rescan(next))).toEqual({ state: "fresh" });
    });

    it("a symbolic link's target, an unreadable file and a different kind are changes", () => {
      const next = [
        ...replace(
          replace(replace(base, { path: "link", status: "symlink", target: "src" }), {
            path: "src/web/app.ts",
            status: "unreadable",
            kind: "file",
            reason: "permission_denied",
          }),
          { path: "node_modules", status: "excluded", kind: "symlink", rule: "node_modules" },
        ),
      ] as SnapshotFile[];
      expect(check(f, [r], rescan(next))).toEqual({
        state: "warn",
        changedPaths: ["link", "node_modules", "src/web/app.ts"],
      });
    });

    it("every path an unstable rescan names has changed, even with the same hash", () => {
      const result = check(
        f,
        [r],
        rescan(base, { stability: { state: "unstable", changedPaths: ["docs/guide.md", "link"] } }),
      );
      expect(result).toEqual({
        state: "blocked",
        blockers: [{ rule: "cited_file", path: "docs/guide.md", change: "changed", findingId: id }],
        changedPaths: ["link"],
      });
    });
  });

  describe("review findings", () => {
    const pathRef = (findingId: string, value: string): Reference => ({
      kind: "path",
      value,
      supportingFindingId: findingId,
      evidenceId: "ev_0001",
      verification: "exists_in_snapshot",
    });
    const answered = (f: Fixture, targets: { findingIds?: string[]; gapIds?: string[] }) =>
      f.log.start({
        type: "question",
        producedBy: "call_0002",
        prompt: "Which?",
        reason: "Unclear.",
        findingIds: targets.findingIds ?? [],
        conflictIds: [],
        gapIds: targets.gapIds ?? [],
        options: [],
        scope: { kind: "repository" },
        status: "answered",
      }).questionId;
    const gap = (f: Fixture, relatedPaths: string[], relatedPathHashes?: Hash[]) =>
      f.log.start({
        type: "finding",
        snapshotId: f.snapshotId,
        producedBy: "call_0001",
        status: "active",
        kind: "gap",
        statement: "No test command for the API.",
        gapType: "no_command",
        relatedPaths,
        ...(relatedPathHashes === undefined ? {} : { relatedPathHashes }),
        coverage: { state: "inspected" },
        evidenceIds: [],
      }).findingId;
    const absence = (f: Fixture, pathGlob: string) => {
      const ev = f.log.append({
        type: "evidence",
        snapshotId: f.snapshotId,
        kind: "absence_check",
        pathGlob,
        unenteredDirectories: [],
        basis: "code_observation",
      });
      return f.log.start({
        type: "finding",
        snapshotId: f.snapshotId,
        producedBy: "call_0001",
        status: "active",
        kind: "absence",
        statement: `No files matched \`${pathGlob}\` within the inspected scope.`,
        pathGlob,
        reason: "None found.",
        basis: ["code_observation"],
        evidenceIds: [ev.id],
      }).findingId;
    };
    const viaDecision = (f: Fixture, targets: { findingIds?: string[]; gapIds?: string[] }) =>
      recommendation(f, [
        { kind: "decision", decisionId: decision(f, { questionId: answered(f, targets) }) },
      ]);

    it("a finding citing the destination gives only the destination blocker", () => {
      const f = fixture();
      const id = finding(f, ["CLAUDE.md"], { kind: "paths", paths: ["docs"] });
      const r = recommendation(f, [{ kind: "finding", findingId: id }], [pathRef(id, "CLAUDE.md")]);
      const other = hashOf("e");
      const edited = check(
        f,
        [r],
        rescan(replace(BASE, file("CLAUDE.md", other)), {
          destination: { state: "present", hash: other },
        }),
      );
      expect(edited).toEqual({
        state: "blocked",
        blockers: [{ rule: "destination", from: DEST, to: other }],
        changedPaths: [],
      });
      const deleted = check(
        f,
        [r],
        rescan(without(BASE, "CLAUDE.md"), { destination: { state: "absent" } }),
      );
      expect(deleted).toEqual({
        state: "blocked",
        blockers: [{ rule: "destination", from: DEST, to: "absent" }],
        changedPaths: [],
      });
    });

    it("a path an unstable rescan names that neither listing has is changed, not added", () => {
      const f = fixture();
      const id = finding(f, ["docs/guide.md"]);
      const r = recommendation(f, [{ kind: "finding", findingId: id }]);
      const result = check(
        f,
        [r],
        rescan(BASE, { stability: { state: "unstable", changedPaths: ["tmp/flicker.txt"] } }),
      );
      // Repository scope blocks additions and removals only, so this warns.
      expect(result).toEqual({ state: "warn", changedPaths: ["tmp/flicker.txt"] });
    });

    it("a gap a supporting decision's question resolves: its related paths are its scope", () => {
      const f = fixture();
      const r = viaDecision(f, { gapIds: [gap(f, ["src/api"])] });
      expect(check(f, [r], rescan([...BASE, file("src/api/test.sh")]))).toMatchObject({
        blockers: [{ rule: "scope", path: "src/api/test.sh", change: "added" }],
      });
      expect(check(f, [r], rescan([...BASE, file("src/web/test.sh")]))).toEqual({
        state: "warn",
        changedPaths: ["src/web/test.sh"],
      });
    });

    it("a gap's withheld related path covers by hash", () => {
      const f = fixture();
      const r = viaDecision(f, { gapIds: [gap(f, [], [pathHash("secrets")])] });
      expect(check(f, [r], rescan([...BASE, file("secrets/new.env")]))).toMatchObject({
        blockers: [{ rule: "scope", path: "secrets/new.env", change: "added" }],
      });
    });

    it("an absence claim's glob is its scope", () => {
      const f = fixture();
      const r = viaDecision(f, { findingIds: [absence(f, "**/.eslintrc*")] });
      expect(check(f, [r], rescan([...BASE, file("src/.eslintrc.json")]))).toMatchObject({
        blockers: [{ rule: "scope", path: "src/.eslintrc.json", change: "added" }],
      });
    });

    it("a path reference that names nothing after normalisation always blocks", () => {
      const f = fixture();
      const id = finding(f, ["docs/guide.md"], { kind: "paths", paths: ["docs"] });
      const r = recommendation(f, [{ kind: "finding", findingId: id }], [pathRef(id, "../x.ts")]);
      expect(check(f, [r], rescan())).toEqual({
        state: "blocked",
        blockers: [{ rule: "missing_reference", value: "../x.ts", revisionId: r }],
        changedPaths: [],
      });
    });

    it("orders blockers by rule, then bytewise, under any file order", () => {
      const f = fixture([...BASE, file("src/api/b.ts"), file("src/lib/util.ts")]);
      const a = finding(f, ["src/api/client.ts", "src/api/b.ts"], {
        kind: "paths",
        paths: ["src/api"],
      });
      const b = finding(f, ["docs/guide.md"], { kind: "paths", paths: ["src/api"] });
      const r = recommendation(
        f,
        [
          { kind: "finding", findingId: b },
          { kind: "finding", findingId: a },
        ],
        [pathRef(a, "src/lib/util.ts")],
      );
      const other = hashOf("e");
      const next = [
        ...replace(
          replace(without(BASE, "src/api/client.ts"), file("CLAUDE.md", other)),
          file("src/web/app.ts", hashOf("2")),
        ),
        file("src/api/b.ts", hashOf("2")),
        file("src/api/z.ts"),
        file("src/api/a.ts"),
      ];
      const expected = {
        state: "blocked",
        blockers: [
          { rule: "destination", from: DEST, to: other },
          { rule: "cited_file", path: "src/api/b.ts", change: "changed", findingId: a },
          { rule: "cited_file", path: "src/api/client.ts", change: "removed", findingId: a },
          { rule: "missing_reference", value: "src/lib/util.ts", revisionId: r },
          // The first finding in support order whose scope covers the path.
          { rule: "scope", path: "src/api/a.ts", change: "added", findingId: b },
          { rule: "scope", path: "src/api/z.ts", change: "added", findingId: b },
        ],
        changedPaths: ["src/web/app.ts"],
      };
      const scan = (files: SnapshotFile[]) =>
        rescan(files, { destination: { state: "present", hash: other } });
      expect(check(f, [r], scan(next))).toEqual(expected);
      expect(check(f, [r], scan([...next].reverse()))).toEqual(expected);
    });

    it("throws on a supporting finding that isn't in the records", () => {
      const f = fixture();
      const r = recommendation(f, [{ kind: "finding", findingId: "fnd_missing" }]);
      expect(() => check(f, [r], rescan())).toThrow(/fnd_missing/);
    });
  });

  it("throws on a selected revision that isn't in the records", () => {
    const f = fixture();
    expect(() => check(f, ["rrev_missing"], rescan())).toThrow(/rrev_missing/);
  });
});

describe("acknowledging warnings (DM §11.1)", () => {
  it("records the changed paths the developer acknowledged", () => {
    expect(acknowledgeWarnings({ state: "warn", changedPaths: ["a.ts", "b.ts"] })).toEqual({
      state: "acknowledged",
      changedPaths: ["a.ts", "b.ts"],
    });
  });

  it("refuses a fresh or blocked result: only warnings are acknowledged", () => {
    expect(() => acknowledgeWarnings({ state: "fresh" } as never)).toThrow();
    expect(() =>
      acknowledgeWarnings({ state: "blocked", blockers: [], changedPaths: [] } as never),
    ).toThrow();
  });
});
