import { sha256 } from "../../src/core/hash.js";
import type { DestinationFs, DestinationState, WriteResult } from "../../src/core/session/apply.js";

// An in-memory root `CLAUDE.md` and its directory, for apply tests (DM §11.2). Hooks run at each
// step so a test can change the destination, fail a write, or crash: a hook that throws stands
// for the process stopping there.

export type MemoryDestinationNode =
  | { readonly kind: "absent" }
  | { readonly kind: "file"; readonly bytes: Uint8Array }
  | { readonly kind: "symlink" }
  | { readonly kind: "directory" };

export interface MemoryDestinationHooks {
  /** After the temporary file is written, before the destination is checked again. */
  afterTemporary?: (destination: MemoryDestination) => void;
  /** After the rename, before the destination is hashed. */
  afterReplace?: (destination: MemoryDestination) => void;
  writeTemporary?: () => WriteResult;
  replace?: () => WriteResult;
  remove?: () => WriteResult;
}

export class MemoryDestination implements DestinationFs {
  node: MemoryDestinationNode;
  readonly temporaries = new Map<string, Uint8Array>();
  /** Each operation, in order: `inspect`, `write <name>`, `replace <name>`, `remove <name>`. */
  readonly operations: string[] = [];
  /** How many times the destination's bytes were replaced. */
  writes = 0;
  hooks: MemoryDestinationHooks;

  constructor(node: MemoryDestinationNode, hooks: MemoryDestinationHooks = {}) {
    this.node = node;
    this.hooks = hooks;
  }

  static file(text: string, hooks?: MemoryDestinationHooks): MemoryDestination {
    return new MemoryDestination({ kind: "file", bytes: new TextEncoder().encode(text) }, hooks);
  }

  get text(): string | undefined {
    return this.node.kind === "file" ? new TextDecoder().decode(this.node.bytes) : undefined;
  }

  async inspect(): Promise<DestinationState> {
    this.operations.push("inspect");
    switch (this.node.kind) {
      case "absent":
        return { state: "absent" };
      case "file":
        return { state: "present", hash: sha256(this.node.bytes) };
      case "symlink":
        return { state: "unavailable", reason: "symlink" };
      case "directory":
        return { state: "unavailable", reason: "not_regular_file" };
    }
  }

  async writeTemporary(name: string, bytes: Uint8Array): Promise<WriteResult> {
    this.operations.push(`write ${name}`);
    const result = this.hooks.writeTemporary?.() ?? { ok: true };
    if (!result.ok) return result;
    if (this.temporaries.has(name)) return { ok: false, reason: "exists" };
    this.temporaries.set(name, bytes.slice());
    this.hooks.afterTemporary?.(this);
    return { ok: true };
  }

  async replace(name: string): Promise<WriteResult> {
    this.operations.push(`replace ${name}`);
    const result = this.hooks.replace?.() ?? { ok: true };
    if (!result.ok) return result;
    const bytes = this.temporaries.get(name);
    if (bytes === undefined) return { ok: false, reason: "io_error" };
    this.temporaries.delete(name);
    this.node = { kind: "file", bytes };
    this.writes++;
    this.hooks.afterReplace?.(this);
    return { ok: true };
  }

  async remove(name: string): Promise<WriteResult> {
    this.operations.push(`remove ${name}`);
    const result = this.hooks.remove?.() ?? { ok: true };
    if (!result.ok) return result;
    this.temporaries.delete(name);
    return { ok: true };
  }
}
