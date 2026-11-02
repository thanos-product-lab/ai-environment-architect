import type { SessionWriter } from "../../src/core/session/store.js";

// An in-memory session directory for core tests (IMPL §4.1 "Layout"). `stopBefore` simulates a
// crash: the write with that index (0-based, counting content and session-file writes) throws
// before it changes anything, as a process stopped before the rename would.

export class MemorySession implements SessionWriter {
  readonly sessionId: string;
  constructor(sessionId = "ses_0001") {
    this.sessionId = sessionId;
  }

  readonly files = new Map<string, Uint8Array>();
  sessionFile: Uint8Array | undefined;
  writes = 0;
  stopBefore: number | undefined;

  async read(ref: string): Promise<Uint8Array | undefined> {
    return this.files.get(ref);
  }

  async readSessionFile(): Promise<Uint8Array | undefined> {
    return this.sessionFile;
  }

  async writeContent(ref: string, bytes: Uint8Array): Promise<void> {
    this.step();
    if (!this.files.has(ref)) this.files.set(ref, bytes.slice());
  }

  async replaceSessionFile(bytes: Uint8Array): Promise<void> {
    this.step();
    this.sessionFile = bytes.slice();
  }

  async removeExchanges(): Promise<void> {
    for (const ref of [...this.files.keys()])
      if (ref.startsWith("inputs/") || ref.startsWith("responses/")) this.files.delete(ref);
  }

  private step(): void {
    const index = this.writes++;
    if (index === this.stopBefore) throw new Error(`stopped before write ${index}`);
  }
}
