import { describe, expect, it } from "vitest";
import { MemorySession } from "../../../test/support/memory-store.js";
import { newLog } from "../../../test/support/session.js";
import { parseGuidanceBlocks } from "../destination/guidance-blocks.js";
import { sha256 } from "../hash.js";
import type { SessionLog } from "./log.js";
import { SESSION_FORMAT, SESSION_SCHEMA_VERSION, type SessionFile } from "./records.js";
import { serialiseSession } from "./serialise.js";
import { contentRefOf, openSession, saveSession } from "./store.js";

// Saving through the storage port (IMPL §4.7 "Writing", §4.11 "A session interrupted after any
// write … loads as either the previous or the next state, never a mix").

const encode = (text: string) => new TextEncoder().encode(text);

function header(records: readonly SessionFile["records"][number][]): SessionFile {
  return {
    format: SESSION_FORMAT,
    schemaVersion: SESSION_SCHEMA_VERSION,
    writtenBy: "0.1.0",
    session: {
      id: "ses_0001",
      createdAt: "2026-11-01T10:15:00.000Z",
      productVersion: "0.1.0",
      adapter: "claude-code",
      outputScope: ["root CLAUDE.md"],
      repository: { name: "kutt", root: "/r/kutt" },
      targetPath: "CLAUDE.md",
    },
    records: [...records],
  };
}

function started(): SessionLog {
  const log = newLog();
  log.start({
    type: "session_state",
    productVersion: "0.1.0",
    stage: "inspect",
    status: "running",
  });
  return log;
}

function addSnapshot(log: SessionLog, destination: Uint8Array): void {
  const parsed = parseGuidanceBlocks(destination);
  log.append({
    type: "snapshot",
    capturedAt: "2026-11-01T10:15:00.000Z",
    scope: { roots: ["."] },
    exclusions: [],
    files: [
      { path: "CLAUDE.md", status: "read", size: destination.length, hash: sha256(destination) },
    ],
    destination: {
      state: "present",
      contentRef: contentRefOf(destination),
      hash: sha256(destination),
      blocks: parsed.blocks as never,
      lineEndings: parsed.lineEndings,
      roundTrip: parsed.roundTrip,
    },
    readFailures: [],
    stability: { state: "stable" },
    git: { state: "unknown", reason: "not_inspected" },
    ignoreRules: { state: "applied" },
  });
}

describe("content references (IMPL §4.2)", () => {
  it("names content by the SHA-256 of its exact bytes", () => {
    const bytes = encode("# Guide\n");
    expect(contentRefOf(bytes)).toBe(`content/sha256-${sha256(bytes).slice("sha256:".length)}`);
  });
});

describe("saving a session (IMPL §4.7)", () => {
  it("writes content files before the session file, and the result loads", async () => {
    const destination = encode("# Guide\n\nUse pnpm.\n");
    const log = started();
    addSnapshot(log, destination);
    const store = new MemorySession();
    const order: string[] = [];
    const writeContent = store.writeContent.bind(store);
    const replace = store.replaceSessionFile.bind(store);
    store.writeContent = async (ref, bytes) => {
      order.push(ref);
      await writeContent(ref, bytes);
    };
    store.replaceSessionFile = async (bytes) => {
      order.push("session.json");
      await replace(bytes);
    };

    await saveSession(store, header(log.records), [destination]);

    expect(order).toEqual([contentRefOf(destination), "session.json"]);
    expect(store.files.get(contentRefOf(destination))).toEqual(destination);
    const loaded = await openSession(store);
    expect(loaded).toMatchObject({ ok: true });
  });

  it("writes the canonical bytes, identical when nothing changed", async () => {
    const store = new MemorySession();
    const file = header(started().records);
    await saveSession(store, file, []);
    const first = store.sessionFile;
    await saveSession(store, file, []);
    expect(new TextDecoder().decode(store.sessionFile)).toBe(serialiseSession(file));
    expect(store.sessionFile).toEqual(first);
  });

  it("stores identical content once", async () => {
    const store = new MemorySession();
    const bytes = encode("same\n");
    await saveSession(store, header(started().records), [bytes, bytes.slice()]);
    expect(store.files.size).toBe(1);
  });

  it("refuses to write a session that wouldn't load, and leaves the saved one in place", async () => {
    const store = new MemorySession();
    const previous = header(started().records);
    await saveSession(store, previous, []);
    const saved = store.sessionFile;

    const log = started();
    addSnapshot(log, encode("# Guide\n")); // its content is never given
    await expect(saveSession(store, header(log.records), [])).rejects.toThrow(/content/);
    expect(store.sessionFile).toEqual(saved);
  });

  it("refuses to save a session in another session's directory", async () => {
    const store = new MemorySession("ses_0002");
    await expect(saveSession(store, header(started().records), [])).rejects.toThrow(/directory/);
    expect(store.sessionFile).toBeUndefined();
  });

  it("reports a missing session file", async () => {
    expect(await openSession(new MemorySession())).toEqual({ ok: false, missing: true });
  });

  it("a crash before any write loads as either the previous or the next state, never a mix", async () => {
    const previousLog = started();
    const previous = header(previousLog.records);
    const nextLog = started();
    addSnapshot(nextLog, encode("# Guide\n\n- one\n"));
    const next = header(nextLog.records);
    const contents = [encode("# Guide\n\n- one\n"), encode("unreferenced\n")];
    const writesInSave = contents.length + 1;

    for (let stop = 0; stop <= writesInSave; stop++) {
      const store = new MemorySession();
      await saveSession(store, previous, []);
      store.writes = 0;
      store.stopBefore = stop;
      const saved = await saveSession(store, next, contents).then(
        () => true,
        () => false,
      );
      store.stopBefore = undefined;

      const loaded = await openSession(store);
      if (!loaded.ok) throw new Error(`stop ${stop}: the session didn't load`);
      expect(loaded.file).toEqual(saved ? next : previous);
      expect(saved).toBe(stop === writesInSave);
    }
  });
});
