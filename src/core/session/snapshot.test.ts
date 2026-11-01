import { describe, expect, it } from "vitest";
import { fixedClock, fixedIds, MemoryFs } from "../../../test/support/memory-fs.js";
import { newLog } from "../../../test/support/session.js";
import { sha256 } from "../hash.js";
import { captureSnapshot, DEFAULT_SNAPSHOT_SETTINGS } from "../snapshot/snapshot.js";
import { recordSnapshot } from "./snapshot.js";

// Snapshot records (IMPL §4.3, §4.4.1): the destination's bytes go to content/, never inline.

const capture = (tree: Record<string, string>) =>
  captureSnapshot(
    { fs: new MemoryFs(tree), clock: fixedClock, ids: fixedIds },
    DEFAULT_SNAPSHOT_SETTINGS,
  );

describe("snapshot records (IMPL §4.4.1)", () => {
  it("keeps the snapshot's ID and blocks, and references the destination bytes by hash", async () => {
    const text = "# Rules\n\nRun the tests.\n";
    const snapshot = await capture({ "CLAUDE.md": text, "src/a.ts": "export {};\n" });
    const log = newLog();
    const { record, content } = recordSnapshot(log, snapshot);
    const hex = sha256(new TextEncoder().encode(text)).slice("sha256:".length);
    expect(record.id).toBe(snapshot.id);
    expect(record.destination).toMatchObject({
      state: "present",
      contentRef: `content/sha256-${hex}`,
      blocks: snapshot.destination.state === "present" ? snapshot.destination.blocks : [],
    });
    expect(record.destination).not.toHaveProperty("bytes");
    expect(content?.ref).toBe(`content/sha256-${hex}`);
    expect(new TextDecoder().decode(content?.bytes)).toBe(text);
    expect(record.files).toEqual(snapshot.files);
  });

  it("an absent destination has no content file", async () => {
    const { record, content } = recordSnapshot(newLog(), await capture({ "a.md": "x\n" }));
    expect(record.destination).toEqual({ state: "absent" });
    expect(content).toBeUndefined();
  });
});
