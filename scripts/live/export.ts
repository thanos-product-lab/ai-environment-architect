import { comparePaths } from "../../src/core/paths.js";
import type { ContentReader } from "../../src/core/session/load.js";
import type { RecordOf, SessionFile } from "../../src/core/session/records.js";
import { serialiseSession } from "../../src/core/session/serialise.js";

// The fixture export (M6 live-run protocol, step 5): each retained request and response as
// `<seq>-<call>.request.json` and `.response.json`, the content files the session names, a
// manifest, and `session.json` with its local root replaced by the repository's name. `<seq>` is
// the `seq` of the call's `started` revision, so each file names its record.
//
// Before anything is returned, every file is checked for each forbidden string (the local root,
// the storage directory and the API key): none may leave the machine in a fixture.

type ModelCall = RecordOf<"model_call">;

export interface ManifestCall {
  readonly seq: number;
  readonly modelCallId: string;
  readonly purpose: ModelCall["purpose"];
  readonly attempt: number;
  readonly retryOf?: string;
  readonly state: ModelCall["state"];
  readonly request: string;
  readonly response: string | null;
  readonly retainedInputRef: string | null;
  readonly retainedResponseRef: string | null;
  readonly versions: {
    readonly prompt: string;
    readonly schema: string;
    readonly validator: string;
    readonly detector: string;
    readonly apiVersion: string;
    readonly priceTable: ModelCall["priceTable"];
  };
  readonly requestedModel: string;
  readonly returnedModel: unknown;
  readonly error?: unknown;
  readonly counts?: unknown;
  readonly validationEvents?: unknown;
}

export interface RunManifest {
  readonly repository: string;
  readonly commit: string | null;
  readonly sessionId: string;
  readonly calls: readonly ManifestCall[];
}

export const pad = (seq: number) => String(seq).padStart(4, "0");

/** The files of a run directory, by path relative to it. */
export async function exportRun(
  file: SessionFile,
  content: ContentReader,
  forbidden: readonly string[],
): Promise<Map<string, Uint8Array>> {
  const name = file.session.repository.name;
  const out = new Map<string, Uint8Array>();
  const encode = (text: string) => new TextEncoder().encode(text);
  const read = async (ref: string) => {
    const bytes = await content.read(ref);
    if (bytes === undefined) throw new Error(`the session names ${ref}, which is missing`);
    return bytes;
  };

  const lineages = new Map<string, ModelCall[]>();
  for (const r of file.records)
    if (r.type === "model_call")
      lineages.set(r.modelCallId, [...(lineages.get(r.modelCallId) ?? []), r]);
  const calls: ManifestCall[] = [];
  for (const [modelCallId, revisions] of lineages) {
    const started = revisions[0] as ModelCall;
    const last = revisions.at(-1) as ModelCall;
    const base = `${pad(started.seq)}-${started.purpose}`;
    const request = `${base}.request.json`;
    if (started.retainedInputRef !== null) out.set(request, await read(started.retainedInputRef));
    const responseRef = last.state === "started" ? null : last.retainedResponseRef;
    const response = responseRef === null ? null : `${base}.response.json`;
    if (response !== null && responseRef !== null) out.set(response, await read(responseRef));
    calls.push({
      seq: started.seq,
      modelCallId,
      purpose: started.purpose,
      attempt: started.attempt,
      ...(started.retryOf === undefined ? {} : { retryOf: started.retryOf }),
      state: last.state,
      request,
      response,
      retainedInputRef: started.retainedInputRef,
      retainedResponseRef: responseRef,
      versions: {
        prompt: `${started.promptVersion} ${started.promptHash}`,
        schema: `${started.schemaVersion} ${started.schemaHash}`,
        validator: started.validatorVersion,
        detector: started.detectorVersion,
        apiVersion: started.apiVersion,
        priceTable: started.priceTable,
      },
      requestedModel: started.requestedModel,
      returnedModel: last.state === "started" ? null : last.returnedModel,
      ...(last.state === "started"
        ? {}
        : {
            ...(last.error === undefined ? {} : { error: last.error }),
            counts: last.counts,
            validationEvents: last.validationEvents,
          }),
    });
  }

  for (const ref of contentRefs(file)) out.set(ref, await read(ref));
  const snapshot = file.records.find((r) => r.type === "snapshot");
  const manifest: RunManifest = {
    repository: name,
    commit:
      snapshot?.type === "snapshot" && snapshot.git.state === "known" ? snapshot.git.commit : null,
    sessionId: file.session.id,
    calls,
  };
  out.set("manifest.json", encode(`${JSON.stringify(manifest, null, 2)}\n`));
  out.set(
    "session.json",
    encode(
      serialiseSession({ ...file, session: { ...file.session, repository: { name, root: name } } }),
    ),
  );

  const found = forbiddenIn(out, forbidden);
  if (found !== undefined)
    throw new Error(`${found} contains a forbidden value (a local path or the key)`);
  return out;
}

/** The first file holding any of `forbidden`, which is never named in the result. */
export function forbiddenIn(
  files: ReadonlyMap<string, Uint8Array>,
  forbidden: readonly string[],
): string | undefined {
  for (const [path, bytes] of files) {
    const text = new TextDecoder().decode(bytes);
    if (forbidden.some((value) => value !== "" && text.includes(value))) return path;
  }
  return undefined;
}

/** Every `content/` reference anywhere in the records, sorted bytewise. */
function contentRefs(file: SessionFile): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (/^content\/sha256-[0-9a-f]{64}$/.test(value)) found.add(value);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
  };
  walk(file.records);
  return [...found].sort(comparePaths);
}

/** A reader for an exported run: the session's own references, resolved through its manifest. */
export function exportedReader(files: ReadonlyMap<string, Uint8Array>): ContentReader {
  const manifest = JSON.parse(
    new TextDecoder().decode(files.get("manifest.json") ?? new Uint8Array()),
  ) as RunManifest;
  const byRef = new Map<string, string>();
  for (const call of manifest.calls) {
    if (call.retainedInputRef !== null) byRef.set(call.retainedInputRef, call.request);
    if (call.retainedResponseRef !== null && call.response !== null)
      byRef.set(call.retainedResponseRef, call.response);
  }
  return { read: async (ref) => files.get(byRef.get(ref) ?? ref) };
}
