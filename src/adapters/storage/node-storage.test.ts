import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newLog } from "../../../test/support/session.js";
import { parseGuidanceBlocks } from "../../core/destination/guidance-blocks.js";
import { sha256 } from "../../core/hash.js";
import {
  SESSION_FORMAT,
  SESSION_SCHEMA_VERSION,
  type SessionFile,
} from "../../core/session/records.js";
import { serialiseSession } from "../../core/session/serialise.js";
import { contentRefOf, openSession, saveSession } from "../../core/session/store.js";
import {
  type FaultPoint,
  type LockedSession,
  LockUnsupportedError,
  openStorage,
  releaseOnExit,
} from "./node-storage.js";

// Atomic storage and the lock (IMPL §4.2, §4.7, §4.11).

const encode = (text: string) => new TextEncoder().encode(text);
const SUPPORT = join(import.meta.dirname, "..", "..", "..", "test", "support");
const LOCK = { productVersion: "0.1.0", startedAt: "2026-11-01T10:15:00.000Z" };

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "aea-storage-"));
  temporary.push(dir);
  return dir;
}

function sessionFile(states: number): SessionFile {
  const log = newLog();
  log.start({
    type: "session_state",
    productVersion: "0.1.0",
    stage: "inspect",
    status: "running",
  });
  for (let i = 1; i < states; i++) {
    log.revise("session_state", "session_state", {
      status: i % 2 === 1 ? "awaiting_user" : "running",
    });
  }
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
    records: [...log.records],
  };
}

async function acquire(storageDir: string, options = {}): Promise<LockedSession> {
  const result = await openStorage(storageDir, options).lock("ses_0001", LOCK, { create: true });
  if (result.state !== "acquired") throw new Error("expected the lock");
  return result.session;
}

describe("session directory layout (IMPL §4.2)", () => {
  it("writes session.json and content-addressed files under sessions/<id>/", async () => {
    const dir = scratch();
    const session = await acquire(dir);
    const bytes = encode("# Guide\n");
    await saveSession(session, sessionFile(1), [bytes]);
    const sessionDir = join(dir, "sessions", "ses_0001");
    expect(readFileSync(join(sessionDir, "session.json"), "utf8")).toBe(
      serialiseSession(sessionFile(1)),
    );
    expect(readFileSync(join(sessionDir, contentRefOf(bytes)))).toEqual(Buffer.from(bytes));
    expect(readdirSync(sessionDir).sort()).toEqual(["content", "session.json", "session.lock"]);
  });

  it("reads back through a reader that takes no lock, and the session loads unchanged", async () => {
    const dir = scratch();
    const session = await acquire(dir);
    await saveSession(session, sessionFile(2), []);
    await session.release();
    const reader = openStorage(dir).reader("ses_0001");
    const loaded = await openSession(reader);
    expect(loaded).toEqual({ ok: true, file: JSON.parse(serialiseSession(sessionFile(2))) });
    expect(existsSync(join(dir, "sessions", "ses_0001", "session.lock"))).toBe(false);
  });

  it("doesn't rewrite a content file that already exists", async () => {
    const dir = scratch();
    const session = await acquire(dir);
    const bytes = encode("kept\n");
    const ref = contentRefOf(bytes);
    await session.writeContent(ref, bytes);
    const path = join(dir, "sessions", "ses_0001", ref);
    writeFileSync(path, "marker"); // shows whether it was rewritten
    await session.writeContent(ref, bytes);
    expect(readFileSync(path, "utf8")).toBe("marker");
  });

  it("refuses a content file whose name isn't its hash", async () => {
    const session = await acquire(scratch());
    await expect(
      session.writeContent(`content/sha256-${"0".repeat(64)}`, encode("x")),
    ).rejects.toThrow(/hash/);
  });

  it.each([
    "../session.json",
    "content/../../x",
    "/etc/passwd",
    `content/sha256-${"A".repeat(64)}`,
  ])("refuses the reference %s, so nothing is read or written outside the session", async (ref) => {
    const dir = scratch();
    const session = await acquire(dir);
    await expect(session.read(ref)).rejects.toThrow(/reference/);
    await expect(session.writeContent(ref, encode("x"))).rejects.toThrow(/reference/);
  });

  it.each(["../x", "ses_0001/..", "", "ses 1", "a/b"])("refuses the session ID %j", async (id) => {
    const storage = openStorage(scratch());
    expect(() => storage.reader(id)).toThrow(/session ID/);
    await expect(storage.lock(id, LOCK)).rejects.toThrow(/session ID/);
  });

  it("reads a missing session file and a missing content file as absent", async () => {
    const reader = openStorage(scratch()).reader("ses_0001");
    expect(await reader.readSessionFile()).toBeUndefined();
    expect(await reader.read(`content/sha256-${"0".repeat(64)}`)).toBeUndefined();
  });
});

describe("retained exchanges (IMPL §4.2, §4.8)", () => {
  const request = encode('{"messages":[]}');
  const response = encode('{"content":[]}');
  const inputRef = `inputs/sha256-${sha256(request).slice("sha256:".length)}.json`;
  const responseRef = `responses/sha256-${sha256(response).slice("sha256:".length)}.json`;

  it("writes requests under inputs/ and responses under responses/, and refuses a wrong name", async () => {
    const dir = scratch();
    const session = await acquire(dir);
    await session.writeContent(inputRef, request);
    await session.writeContent(responseRef, response);
    const sessionDir = join(dir, "sessions", "ses_0001");
    expect(readFileSync(join(sessionDir, inputRef))).toEqual(Buffer.from(request));
    expect(readFileSync(join(sessionDir, responseRef))).toEqual(Buffer.from(response));
    await expect(session.writeContent(inputRef, response)).rejects.toThrow(/hash/);
  });

  it("removeExchanges deletes inputs/ and responses/ and leaves the rest", async () => {
    const dir = scratch();
    const session = await acquire(dir);
    const content = encode("# Guide\n");
    await saveSession(session, sessionFile(1), [content]);
    await session.writeContent(inputRef, request);
    await session.writeContent(responseRef, response);
    await session.removeExchanges();
    const sessionDir = join(dir, "sessions", "ses_0001");
    expect(readdirSync(sessionDir).sort()).toEqual(["content", "session.json", "session.lock"]);
    expect(await session.read(inputRef)).toBeUndefined();
    expect(Buffer.from((await session.read(contentRefOf(content))) ?? [])).toEqual(
      Buffer.from(content),
    );
  });

  it("removeExchanges succeeds when nothing was retained", async () => {
    const session = await acquire(scratch());
    await expect(session.removeExchanges()).resolves.toBeUndefined();
  });

  it("a released session can't remove exchanges", async () => {
    const session = await acquire(scratch());
    await session.writeContent(inputRef, request);
    await session.release();
    await expect(session.removeExchanges()).rejects.toThrow(/released/);
    expect(Buffer.from((await session.read(inputRef)) ?? [])).toEqual(Buffer.from(request));
  });
});

describe("atomic writes (IMPL §4.7)", () => {
  it("leaves no temporary file after a successful write", async () => {
    const dir = scratch();
    const session = await acquire(dir);
    await saveSession(session, sessionFile(1), [encode("a\n")]);
    const sessionDir = join(dir, "sessions", "ses_0001");
    expect(readdirSync(sessionDir).filter((name) => name.includes("tmp"))).toEqual([]);
    expect(readdirSync(join(sessionDir, "content")).filter((n) => n.includes("tmp"))).toEqual([]);
  });

  it("names the temporary session file session.json.tmp-<random>, with the adapter's random part", async () => {
    const dir = scratch();
    const seen: string[] = [];
    const session = await acquire(dir, {
      random: () => "r4nd0m",
      faultPoint: (point: FaultPoint, path: string) => {
        if (point === "written") seen.push(path);
      },
    });
    await saveSession(session, sessionFile(1), []);
    expect(seen).toEqual([join(dir, "sessions", "ses_0001", "session.json.tmp-r4nd0m")]);
  });
});

describe("fault injection at each point of a save (IMPL §4.7, §4.11)", () => {
  // The previous state is one session_state record; the next adds a snapshot whose destination
  // is ONE, plus an unreferenced TWO. The save writes ONE, then TWO, then session.json, and
  // each write passes three points. A crash at any of the nine leaves the complete previous
  // state or the complete next one; content files written before the crash are orphans that
  // don't stop the previous session loading, and the next save succeeds over the leftovers.
  const ONE = encode("# Guide\n\n- one\n");
  const TWO = encode("unreferenced\n");
  const POINTS = ["written", "synced", "renamed"] as const;
  const FILES = ["content file 1", "content file 2", "session.json"] as const;
  const cases = FILES.flatMap((file, f) =>
    POINTS.map((point, p) => ({ file, point, index: f * POINTS.length + p })),
  );
  const LABEL = {
    written: "after the temporary file is written, before its sync",
    synced: "after the sync, before the rename",
    renamed: "after the rename, before the directory sync",
  } as const;

  function nextState(): SessionFile {
    const log = newLog();
    log.start({
      type: "session_state",
      productVersion: "0.1.0",
      stage: "inspect",
      status: "running",
    });
    const parsed = parseGuidanceBlocks(ONE);
    log.append({
      type: "snapshot",
      capturedAt: "2026-11-01T10:15:00.000Z",
      scope: { roots: ["."] },
      exclusions: [],
      files: [{ path: "CLAUDE.md", status: "read", size: ONE.length, hash: sha256(ONE) }],
      destination: {
        state: "present",
        contentRef: contentRefOf(ONE),
        hash: sha256(ONE),
        blocks: parsed.blocks as never,
        lineEndings: parsed.lineEndings,
        roundTrip: parsed.roundTrip,
      },
      readFailures: [],
      stability: { state: "stable" },
      git: { state: "unknown", reason: "not_inspected" },
      ignoreRules: { state: "applied" },
    });
    return { ...sessionFile(1), records: [...log.records] };
  }

  it.each(cases)(
    "a crash at $file, $point, loads the complete previous or next state",
    async ({ file, point, index }) => {
      const dir = scratch();
      let calls = 0;
      let armed = false;
      const session = await acquire(dir, {
        faultPoint: () => {
          if (armed && calls++ === index) throw new Error(`crash ${LABEL[point]}`);
        },
      });
      const previous = sessionFile(1);
      await saveSession(session, previous, []);
      armed = true;
      await expect(saveSession(session, nextState(), [ONE, TWO])).rejects.toThrow(/crash/);
      armed = false;

      const sessionDir = join(dir, "sessions", "ses_0001");
      const leftovers = readdirSync(sessionDir, { recursive: true }).map(String);
      const sessionRenamed = file === "session.json" && point === "renamed";
      // A crashed write leaves its temporary file, as a real crash would.
      expect(leftovers.some((name) => name.includes(".tmp-"))).toBe(point !== "renamed");

      const loaded = await openSession(openStorage(dir).reader("ses_0001"));
      if (!loaded.ok) throw new Error(`${file}, ${point}: the session didn't load`);
      expect(serialiseSession(loaded.file)).toBe(
        serialiseSession(sessionRenamed ? nextState() : previous),
      );

      // The leftovers don't block the next save.
      await saveSession(session, nextState(), [ONE, TWO]);
      const retried = await openSession(openStorage(dir).reader("ses_0001"));
      if (!retried.ok) throw new Error("the retried save didn't load");
      expect(serialiseSession(retried.file)).toBe(serialiseSession(nextState()));
    },
  );

  it("covers all nine points, and the save with no crash completes", async () => {
    expect(cases).toHaveLength(9);
    const dir = scratch();
    const points: string[] = [];
    const session = await acquire(dir, {
      faultPoint: (point: FaultPoint) => {
        points.push(point);
      },
    });
    await saveSession(session, nextState(), [ONE, TWO]);
    expect(points).toEqual(cases.map((c) => c.point));
  });
});

describe("the lock (IMPL §4.7)", () => {
  it("records the process ID, host, start time and product version", async () => {
    const dir = scratch();
    await acquire(dir, { pid: 4242, hostname: "devbox" });
    const lock = JSON.parse(
      readFileSync(join(dir, "sessions", "ses_0001", "session.lock"), "utf8"),
    );
    expect(lock).toEqual({ pid: 4242, hostname: "devbox", ...LOCK });
  });

  it("a second process can't take a held lock, and is told who holds it", async () => {
    const dir = scratch();
    await acquire(dir, { pid: 4242, hostname: "devbox" });
    const second = await openStorage(dir, {
      pid: 5151,
      hostname: "devbox",
      isRunning: () => true,
    }).lock("ses_0001", LOCK);
    expect(second).toMatchObject({
      state: "held",
      owner: { pid: 4242, hostname: "devbox", ...LOCK },
      stale: false,
    });
  });

  it("a lock on this host whose process isn't running is stale", async () => {
    const dir = scratch();
    await acquire(dir, { pid: 4242, hostname: "devbox" });
    const second = await openStorage(dir, { hostname: "devbox", isRunning: () => false }).lock(
      "ses_0001",
      LOCK,
    );
    expect(second).toMatchObject({ state: "held", stale: true });
  });

  it("a lock from another host is never stale", async () => {
    const dir = scratch();
    await acquire(dir, { pid: 4242, hostname: "otherbox" });
    const second = await openStorage(dir, { hostname: "devbox", isRunning: () => false }).lock(
      "ses_0001",
      LOCK,
    );
    expect(second).toMatchObject({ state: "held", stale: false });
  });

  it("an unreadable lock is held by an unknown owner and isn't stale", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "sessions", "ses_0001"), { recursive: true });
    writeFileSync(join(dir, "sessions", "ses_0001", "session.lock"), "");
    const second = await openStorage(dir, { isRunning: () => false }).lock("ses_0001", LOCK);
    expect(second).toMatchObject({ state: "held", owner: undefined, stale: false });
  });

  it("a stale lock is removed only when asked, and then can be taken", async () => {
    const dir = scratch();
    await acquire(dir, { pid: 4242, hostname: "devbox" });
    const storage = openStorage(dir, { pid: 5151, hostname: "devbox", isRunning: () => false });
    const held = await storage.lock("ses_0001", LOCK);
    if (held.state !== "held" || held.owner === undefined) throw new Error("expected held");
    expect(existsSync(join(dir, "sessions", "ses_0001", "session.lock"))).toBe(true);
    expect(await storage.removeStaleLock("ses_0001", held.owner)).toBe(true);
    expect(await storage.lock("ses_0001", LOCK)).toMatchObject({ state: "acquired" });
  });

  it("doesn't remove a lock that changed since it was reported stale", async () => {
    const dir = scratch();
    await acquire(dir, { pid: 4242, hostname: "devbox" });
    const storage = openStorage(dir, {
      hostname: "devbox",
      isRunning: (pid: number) => pid !== 6363,
    });
    const held = await storage.lock("ses_0001", LOCK);
    if (held.state !== "held" || held.owner === undefined) throw new Error("expected held");
    // Meanwhile another process removed it and took the session.
    rmSync(join(dir, "sessions", "ses_0001", "session.lock"));
    await acquire(dir, { pid: 6363, hostname: "devbox" });
    expect(await storage.removeStaleLock("ses_0001", held.owner)).toBe(false);
    expect(existsSync(join(dir, "sessions", "ses_0001", "session.lock"))).toBe(true);
  });

  it("refuses to remove a lock that isn't stale", async () => {
    const dir = scratch();
    await acquire(dir, { pid: 4242, hostname: "devbox" });
    const storage = openStorage(dir, { hostname: "devbox", isRunning: () => true });
    const owner = { pid: 4242, hostname: "devbox", ...LOCK };
    expect(await storage.removeStaleLock("ses_0001", owner)).toBe(false);
  });

  it("release removes the lock, and leaves a lock that is no longer this process's", async () => {
    const dir = scratch();
    const lockPath = join(dir, "sessions", "ses_0001", "session.lock");
    const first = await acquire(dir, { pid: 4242 });
    await first.release();
    expect(existsSync(lockPath)).toBe(false);

    const second = await acquire(dir, { pid: 4242 });
    rmSync(lockPath);
    await acquire(dir, { pid: 5151 });
    await second.release();
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ pid: 5151 });
  });

  it("a released session can't write", async () => {
    const session = await acquire(scratch());
    await session.release();
    await expect(saveSession(session, sessionFile(1), [])).rejects.toThrow(/released/);
  });

  it.skipIf(process.getuid?.() === 0)("treats a process it may not signal as running", async () => {
    // pid 1 belongs to root; signalling it from a normal user fails with EPERM.
    const dir = scratch();
    await acquire(dir, { pid: 1 });
    const second = await openStorage(dir).lock("ses_0001", LOCK);
    expect(second).toMatchObject({ state: "held", stale: false });
  });

  it("treats a process that has exited as not running", async () => {
    const { pid } = spawnSync(process.execPath, ["-e", ""]);
    if (pid === undefined) throw new Error("no child process");
    const dir = scratch();
    await acquire(dir, { pid });
    const second = await openStorage(dir).lock("ses_0001", LOCK);
    expect(second).toMatchObject({ state: "held", stale: true });
  });

  it("names the lock's path when it is held", async () => {
    const dir = scratch();
    await acquire(dir, { pid: 4242, hostname: "otherbox" });
    expect(await openStorage(dir).lock("ses_0001", LOCK)).toMatchObject({
      state: "held",
      lockPath: join(dir, "sessions", "ses_0001", "session.lock"),
    });
  });

  it("doesn't create the directory of a session that doesn't exist, unless asked", async () => {
    const dir = scratch();
    expect(await openStorage(dir).lock("ses_typo", LOCK)).toEqual({ state: "missing" });
    expect(existsSync(join(dir, "sessions"))).toBe(false);
  });

  it("leaves only the lock behind: no temporary or moved-aside files", async () => {
    const dir = scratch();
    await acquire(dir, { pid: 4242, hostname: "devbox" });
    const storage = openStorage(dir, { hostname: "devbox", isRunning: () => true });
    await storage.lock("ses_0001", LOCK);
    await storage.removeStaleLock("ses_0001", { pid: 4242, hostname: "devbox", ...LOCK });
    expect(readdirSync(join(dir, "sessions", "ses_0001"))).toEqual(["session.lock"]);
  });

  it("puts back a lock that isn't the one reported stale, unchanged", async () => {
    const dir = scratch();
    await acquire(dir, { pid: 6363, hostname: "devbox" });
    const lockPath = join(dir, "sessions", "ses_0001", "session.lock");
    const before = readFileSync(lockPath, "utf8");
    const storage = openStorage(dir, { hostname: "devbox", isRunning: () => false });
    expect(
      await storage.removeStaleLock("ses_0001", { pid: 4242, hostname: "devbox", ...LOCK }),
    ).toBe(false);
    expect(readFileSync(lockPath, "utf8")).toBe(before);
  });
});

describe("a file system without hard links (IMPL §4.7)", () => {
  it.each(["EPERM", "ENOTSUP"])(
    "fails with a message naming the storage directory when the link is refused (%s), with no fallback",
    async (code) => {
      const dir = scratch();
      const storage = openStorage(dir, {
        link: async () => {
          throw Object.assign(new Error("refused"), { code });
        },
      });
      const attempt = storage.lock("ses_0001", LOCK, { create: true });
      await expect(attempt).rejects.toBeInstanceOf(LockUnsupportedError);
      await expect(attempt).rejects.toThrow(dir);
      expect(readdirSync(join(dir, "sessions", "ses_0001"))).toEqual([]);
    },
  );
});

class FakeProcess extends EventEmitter {
  readonly pid = 4242;
  readonly killed: string[] = [];
  kill(pid: number, signal: string): boolean {
    if (pid === this.pid) this.killed.push(signal);
    return true;
  }
}

describe("releasing the lock on exit (IMPL §4.7)", () => {
  it.each(["exit", "SIGINT", "SIGTERM"] as const)("removes the lock on %s", async (event) => {
    const dir = scratch();
    const session = await acquire(dir);
    const proc = new FakeProcess();
    releaseOnExit(session, proc);
    proc.emit(event, event === "exit" ? 0 : event);
    expect(existsSync(join(dir, "sessions", "ses_0001", "session.lock"))).toBe(false);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "re-raises %s after removing the lock, so the process still ends by the signal",
    async (signal) => {
      const session = await acquire(scratch());
      const proc = new FakeProcess();
      releaseOnExit(session, proc);
      proc.emit(signal, signal);
      expect(proc.killed).toEqual([signal]);
      expect(proc.listenerCount(signal)).toBe(0);
    },
  );

  it("the returned function removes the handlers", async () => {
    const session = await acquire(scratch());
    const proc = new FakeProcess();
    const stop = releaseOnExit(session, proc);
    stop();
    expect(proc.listenerCount("exit") + proc.listenerCount("SIGINT")).toBe(0);
  });
});

describe("a real signal (IMPL §4.7, §4.11)", () => {
  it("a child process holding the lock removes it on a real SIGINT, and ends by the signal", async () => {
    const dir = scratch();
    const lockPath = join(dir, "sessions", "ses_0001", "session.lock");
    const child = spawn(
      process.execPath,
      ["--import", join(SUPPORT, "ts-resolve.mjs"), join(SUPPORT, "lock-holder.ts"), dir],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("locked")) resolve();
      });
      void exited.then(() => reject(new Error(`the child exited early: ${stderr}`)));
    });
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ pid: child.pid });

    child.kill("SIGINT");
    expect(await exited).toEqual({ code: null, signal: "SIGINT" });
    expect(existsSync(lockPath)).toBe(false);
  }, 20_000);
});

describe("the data-notice file (IMPL §4.9)", () => {
  it("is notices.json in the storage directory, written whole and read back", async () => {
    const dir = scratch();
    const storage = openStorage(join(dir, "store"));
    expect(await storage.readNotices()).toBeUndefined();
    await storage.writeNotices(encode('{"a": 1}\n'));
    expect(readFileSync(join(dir, "store", "notices.json"), "utf8")).toBe('{"a": 1}\n');
    expect(new TextDecoder().decode(await storage.readNotices())).toBe('{"a": 1}\n');
    expect(readdirSync(join(dir, "store"))).toEqual(["notices.json"]);
  });
});
