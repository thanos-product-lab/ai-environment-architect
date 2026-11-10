import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { MemorySession } from "../../../test/support/memory-store.js";
import {
  callDraft,
  completedCall,
  hashOf,
  newLog,
  TEST_SETTINGS,
} from "../../../test/support/session.js";
import { sha256 } from "../hash.js";
import { type LoadFailure, loadSession } from "./load.js";
import type { SessionLog } from "./log.js";
import { SESSION_FORMAT, SESSION_SCHEMA_VERSION, type SessionFile } from "./records.js";
import {
  purgeInputs,
  type RetainedFile,
  retainedExchange,
  retainedFile,
  retainsModelInputs,
} from "./retained.js";
import { serialiseSession } from "./serialise.js";
import { HeldSession, saveSession } from "./store.js";

// Retained model exchanges (IMPL §4.8, §1.12) and load check 7 for their references (§4.9).

const encode = (text: string) => new TextEncoder().encode(text);
const REQUEST = encode('{"model":"claude-test","messages":[]}');
const RESPONSE = encode('{"content":[{"type":"text","text":"{}"}]}');
const OTHER_REQUEST = encode('{"model":"claude-test","messages":[1]}');

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
    repository: { name: "kutt", root: "/r/kutt" },
    targetPath: "CLAUDE.md",
  },
};

const fileOf = (log: SessionLog): SessionFile => ({ ...HEADER, records: [...log.records] });

/** A session state, a snapshot with no destination, and a generation config. */
function baseLog(retainModelInputs: boolean): SessionLog {
  const log = newLog();
  log.start({
    type: "session_state",
    productVersion: "0.1.0",
    stage: "inspect",
    status: "running",
  });
  log.append(
    {
      type: "snapshot",
      capturedAt: "2026-11-01T10:15:00.000Z",
      scope: { roots: ["."] },
      exclusions: [],
      files: [],
      destination: { state: "absent" },
      readFailures: [],
      stability: { state: "stable" },
      git: { state: "unknown", reason: "not_inspected" },
      ignoreRules: { state: "applied" },
    },
    { id: "snap_0001" },
  );
  log.start({
    type: "generation_config",
    settings: TEST_SETTINGS,
    settingsHash: hashOf("9"),
    requestedModel: "claude-test",
    effort: "medium",
    budget: {},
    expansion: { maxExpansionRequests: 0, expansionBytes: 0, expansionEntryBytes: 0 },
    questionBudget: 5,
    retainModelInputs,
  });
  return log;
}

/**
 * Records one completed call the way the adapter will (M6): the request retained before the
 * `started` revision, the response with the end. Returns the files to save.
 */
function recordCall(
  log: SessionLog,
  request: Uint8Array = REQUEST,
  response: Uint8Array | undefined = RESPONSE,
): RetainedFile[] {
  const retain = retainsModelInputs(log.records);
  const input = retainedExchange(retain, "inputs", request);
  const base = callDraft();
  const call = log.start(
    callDraft({
      retainedInputRef: input.ref,
      inputManifest: { ...base.inputManifest, retainedInputRef: input.ref },
    }),
  );
  const output =
    response === undefined
      ? { ref: null, file: undefined }
      : retainedExchange(retain, "responses", response);
  log.revise("model_call", call.modelCallId, completedCall({ retainedResponseRef: output.ref }));
  return [input.file, output.file].filter((f): f is RetainedFile => f !== undefined);
}

async function saved(log: SessionLog, retained: readonly RetainedFile[] = []) {
  const store = new MemorySession();
  await saveSession(store, fileOf(log), [], retained);
  return store;
}

async function failure(bytes: Uint8Array, store: MemorySession): Promise<LoadFailure> {
  const result = await loadSession(bytes, store);
  if (result.ok) throw new Error("expected the session to be rejected");
  return result.failure;
}

// biome-ignore lint/suspicious/noExplicitAny: tests corrupt the file freely.
type Json = any;

function corrupted(log: SessionLog, edit: (records: Json[]) => void): Uint8Array {
  const json = JSON.parse(serialiseSession(fileOf(log)));
  edit(json.records);
  return encode(JSON.stringify(json));
}

const calls = (records: Json[]) => records.filter((r: Json) => r.type === "model_call");

describe("retained file names (IMPL §4.2, §4.8)", () => {
  it("names a request inputs/sha256-<hex>.json and a response responses/sha256-<hex>.json, by the exact bytes", () => {
    const hex = sha256(REQUEST).slice("sha256:".length);
    expect(retainedFile("inputs", REQUEST)).toEqual({
      ref: `inputs/sha256-${hex}.json`,
      bytes: REQUEST,
    });
    expect(retainedFile("responses", REQUEST).ref).toBe(`responses/sha256-${hex}.json`);
  });

  it("reads retainModelInputs from the session's generation config", () => {
    expect(retainsModelInputs(baseLog(true).records)).toBe(true);
    expect(retainsModelInputs(baseLog(false).records)).toBe(false);
  });
});

describe("retention on (IMPL §4.8, §4.11)", () => {
  it("writes the request and response files and references them on the call and its manifest", async () => {
    const log = baseLog(true);
    const files = recordCall(log);
    const store = await saved(log, files);
    const [started, ended] = log.records.filter((r) => r.type === "model_call");
    const inputRef = retainedFile("inputs", REQUEST).ref;
    const responseRef = retainedFile("responses", RESPONSE).ref;
    expect(started).toMatchObject({
      retainedInputRef: inputRef,
      inputManifest: { retainedInputRef: inputRef },
    });
    expect(ended).toMatchObject({ retainedInputRef: inputRef, retainedResponseRef: responseRef });
    expect(store.files.get(inputRef)).toEqual(REQUEST);
    expect(store.files.get(responseRef)).toEqual(RESPONSE);
    expect((await loadSession(store.sessionFile as Uint8Array, store)).ok).toBe(true);
  });

  it("writes the retained files before session.json, and identical bytes once", async () => {
    const log = baseLog(true);
    const files = [...recordCall(log), ...recordCall(log)];
    const store = new MemorySession();
    const order: string[] = [];
    const write = store.writeContent.bind(store);
    store.writeContent = async (ref, bytes) => {
      order.push(ref);
      return write(ref, bytes);
    };
    const replace = store.replaceSessionFile.bind(store);
    store.replaceSessionFile = async (bytes) => {
      order.push("session.json");
      return replace(bytes);
    };
    await saveSession(store, fileOf(log), [], files);
    expect(order).toEqual([
      retainedFile("inputs", REQUEST).ref,
      retainedFile("responses", RESPONSE).ref,
      "session.json",
    ]);
  });

  it("a crash before session.json leaves the previous session, which still loads", async () => {
    const log = baseLog(true);
    const store = await saved(log);
    const before = store.sessionFile;
    const files = recordCall(log);
    store.writes = 0;
    store.stopBefore = files.length;
    await expect(saveSession(store, fileOf(log), [], files)).rejects.toThrow(/stopped/);
    expect(store.sessionFile).toEqual(before);
    expect((await loadSession(store.sessionFile as Uint8Array, store)).ok).toBe(true);
  });

  it("a call with no response body, such as a transport failure, has a null response ref", async () => {
    const log = baseLog(true);
    const store = await saved(log, recordCall(log, REQUEST, undefined));
    expect((await loadSession(store.sessionFile as Uint8Array, store)).ok).toBe(true);
  });
});

describe("retention off (IMPL §4.8, §4.11)", () => {
  it("leaves both references null and writes no retained file", async () => {
    const log = baseLog(false);
    const files = recordCall(log);
    expect(files).toEqual([]);
    const store = await saved(log, files);
    for (const r of log.records)
      if (r.type === "model_call") {
        expect(r.retainedInputRef).toBeNull();
        expect(r.inputManifest.retainedInputRef).toBeNull();
        if (r.state !== "started") expect(r.retainedResponseRef).toBeNull();
      }
    expect([...store.files.keys()]).toEqual([]);
    expect((await loadSession(store.sessionFile as Uint8Array, store)).ok).toBe(true);
  });
});

describe("check 7: retained exchanges (IMPL §4.9)", () => {
  async function retaining() {
    const log = baseLog(true);
    const store = await saved(log, recordCall(log));
    return { log, store };
  }

  it("rejects a missing request file, naming the call's first revision", async () => {
    const { log, store } = await retaining();
    store.files.delete(retainedFile("inputs", REQUEST).ref);
    expect(await failure(store.sessionFile as Uint8Array, store)).toMatchObject({
      check: 7,
      name: "content",
      recordId: log.records.find((r) => r.type === "model_call")?.id,
    });
  });

  it("rejects a missing response file", async () => {
    const { store } = await retaining();
    store.files.delete(retainedFile("responses", RESPONSE).ref);
    expect(await failure(store.sessionFile as Uint8Array, store)).toMatchObject({
      check: 7,
      recordId: "callr_0002",
    });
  });

  it("rejects a request file whose bytes don't hash to its name", async () => {
    const { store } = await retaining();
    store.files.set(retainedFile("inputs", REQUEST).ref, OTHER_REQUEST);
    expect(await failure(store.sessionFile as Uint8Array, store)).toMatchObject({ check: 7 });
  });

  it("rejects a response file whose bytes don't hash to its name", async () => {
    const { store } = await retaining();
    store.files.set(retainedFile("responses", RESPONSE).ref, OTHER_REQUEST);
    expect(await failure(store.sessionFile as Uint8Array, store)).toMatchObject({ check: 7 });
  });

  it("rejects a call whose retainedInputRef differs from its manifest's", async () => {
    const { log, store } = await retaining();
    const bytes = corrupted(log, (records) => {
      for (const call of calls(records)) call.inputManifest.retainedInputRef = null;
    });
    expect(await failure(bytes, store)).toMatchObject({ check: 7, recordId: "callr_0001" });
  });

  it("rejects a retained reference when retention is off", async () => {
    const log = baseLog(false);
    const store = await saved(log, recordCall(log));
    const ref = retainedFile("inputs", REQUEST).ref;
    store.files.set(ref, REQUEST);
    const bytes = corrupted(log, (records) => {
      for (const call of calls(records)) {
        call.retainedInputRef = ref;
        call.inputManifest.retainedInputRef = ref;
      }
    });
    expect(await failure(bytes, store)).toMatchObject({ check: 7, recordId: "callr_0001" });
  });

  it("rejects a retained response reference when retention is off", async () => {
    const log = baseLog(false);
    const store = await saved(log, recordCall(log));
    const ref = retainedFile("responses", RESPONSE).ref;
    store.files.set(ref, RESPONSE);
    const bytes = corrupted(log, (records) => {
      calls(records)[1].retainedResponseRef = ref;
    });
    expect(await failure(bytes, store)).toMatchObject({ check: 7, recordId: "callr_0002" });
  });

  it("rejects a null request reference when retention is on", async () => {
    const { log, store } = await retaining();
    const bytes = corrupted(log, (records) => {
      for (const call of calls(records)) {
        call.retainedInputRef = null;
        call.inputManifest.retainedInputRef = null;
      }
    });
    expect(await failure(bytes, store)).toMatchObject({ check: 7, recordId: "callr_0001" });
  });
});

describe("purge-inputs (IMPL §4.8, §4.11)", () => {
  async function purged() {
    const log = baseLog(true);
    const store = await saved(log, recordCall(log));
    const session = new HeldSession(store, HEADER, log);
    const record = await purgeInputs(session);
    return { session, store, record };
  }

  it("appends an inputs_purged record with only the envelope", async () => {
    const { record } = await purged();
    expect(Object.keys(record).sort()).toEqual(["createdAt", "id", "seq", "type"]);
    expect(record).toMatchObject({ type: "inputs_purged", id: "pur_0001" });
  });

  it("deletes the retained requests and responses, and nothing else", async () => {
    const log = baseLog(true);
    const store = await saved(log, recordCall(log));
    store.files.set("content/sha256-0", encode("kept"));
    await purgeInputs(new HeldSession(store, HEADER, log));
    expect([...store.files.keys()]).toEqual(["content/sha256-0"]);
  });

  it("the session still loads after the purge, with the references pointing at missing files", async () => {
    const { session, store } = await purged();
    const result = await loadSession(store.sessionFile as Uint8Array, store);
    expect(result.ok).toBe(true);
    expect(result.ok && result.file.records.at(-1)).toEqual(session.records.at(-1));
  });

  it("saves the record before deleting the files, so a crash in between leaves a session that loads", async () => {
    const log = baseLog(true);
    const store = await saved(log, recordCall(log));
    store.removeExchanges = async () => {
      throw new Error("crashed before removing");
    };
    await expect(purgeInputs(new HeldSession(store, HEADER, log))).rejects.toThrow(/crashed/);
    const result = await loadSession(store.sessionFile as Uint8Array, store);
    expect(result.ok && result.file.records.at(-1)?.type).toBe("inputs_purged");
  });

  it("a failed save deletes nothing and leaves the in-memory log as saved", async () => {
    const log = baseLog(true);
    const store = await saved(log, recordCall(log));
    const before = [...store.files.keys()];
    store.replaceSessionFile = async () => {
      throw new Error("disk full");
    };
    const session = new HeldSession(store, HEADER, log);
    await expect(purgeInputs(session)).rejects.toThrow(/disk full/);
    expect([...store.files.keys()]).toEqual(before);
    expect(session.records.some((r) => r.type === "inputs_purged")).toBe(false);
    const result = await loadSession(store.sessionFile as Uint8Array, store);
    expect(result.ok && JSON.parse(JSON.stringify(session.records))).toEqual(
      result.ok && result.file.records,
    );
  });

  it("still checks a retained file that survived a purge", async () => {
    const { store } = await purged();
    store.files.set(retainedFile("inputs", REQUEST).ref, OTHER_REQUEST);
    expect(await failure(store.sessionFile as Uint8Array, store)).toMatchObject({ check: 7 });
  });

  it("checks the references of a call made after the purge", async () => {
    const { session, store } = await purged();
    await session.change((log, files) => {
      files.retained.push(...recordCall(log, OTHER_REQUEST));
    });
    expect((await loadSession(store.sessionFile as Uint8Array, store)).ok).toBe(true);
    store.files.delete(retainedFile("inputs", OTHER_REQUEST).ref);
    expect(await failure(store.sessionFile as Uint8Array, store)).toMatchObject({
      check: 7,
      recordId: "callr_0003",
    });
  });

  it("a purge between a call's start and its end covers the request, not a later response", async () => {
    const log = baseLog(true);
    const input = retainedExchange(true, "inputs", REQUEST);
    const base = callDraft();
    const call = log.start(
      callDraft({
        retainedInputRef: input.ref,
        inputManifest: { ...base.inputManifest, retainedInputRef: input.ref },
      }),
    );
    const store = await saved(log, input.file === undefined ? [] : [input.file]);
    const session = new HeldSession(store, HEADER, log);
    await purgeInputs(session);
    // Resume then marks the interrupted call; its request ref is covered by the purge.
    await session.change((log) =>
      log.revise(
        "model_call",
        call.modelCallId,
        completedCall({ state: "interrupted", retainedResponseRef: null, ...interruptedEnd }),
      ),
    );
    expect((await loadSession(store.sessionFile as Uint8Array, store)).ok).toBe(true);
  });

  it("a purge before a call's end doesn't cover the response that end adds", async () => {
    const log = baseLog(true);
    const input = retainedExchange(true, "inputs", REQUEST);
    const base = callDraft();
    const call = log.start(
      callDraft({
        retainedInputRef: input.ref,
        inputManifest: { ...base.inputManifest, retainedInputRef: input.ref },
      }),
    );
    const store = await saved(log, input.file === undefined ? [] : [input.file]);
    const session = new HeldSession(store, HEADER, log);
    await purgeInputs(session);
    const responseRef = retainedFile("responses", RESPONSE).ref;
    // The response file is never written, and the purge came before the revision that adds it,
    // so the save's load checks refuse it.
    await expect(
      session.change((log) =>
        log.revise(
          "model_call",
          call.modelCallId,
          completedCall({ retainedResponseRef: responseRef }),
        ),
      ),
    ).rejects.toThrow(`check 7 (content): ${responseRef} is missing`);
  });

  it("an inputs_purged record round-trips: the saved bytes load and serialise back unchanged", async () => {
    const { store } = await purged();
    const result = await loadSession(store.sessionFile as Uint8Array, store);
    if (!result.ok) throw new Error("expected the session to load");
    expect(encode(serialiseSession(result.file))).toEqual(store.sessionFile);
  });
});

const unknown = { state: "unknown", reason: "interrupted" } as const;
const interruptedEnd = {
  usage: { input: unknown, output: unknown, cacheRead: unknown, cacheWrite: unknown },
  cost: unknown,
  endedAt: unknown,
  durationMs: unknown,
};

describe("responses are for replay only (IMPL §4.8)", () => {
  it("no source file outside the schema, saving, loading and interruption mentions retained responses", () => {
    // A new file here would be a new reader: records, the export and the review are built from
    // records, never from retained responses. calls.ts only writes a null reference on resume.
    const root = join(import.meta.dirname, "..", "..");
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sources(path);
        return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
      });
    const mentioning = sources(root)
      .filter((path) => /responses\/|retainedResponseRef/.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path).split(sep).join("/"))
      .sort();
    expect(mentioning).toEqual([
      "core/session/calls.ts",
      "core/session/load.ts",
      "core/session/records.ts",
      "core/session/retained.ts",
      "core/session/store.ts",
    ]);
  });
});
