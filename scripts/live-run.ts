// A live run against a development repository (M6 live-run protocol), in phases, each from the
// developer's own terminal:
//
//   pnpm live-run analyse    --repo <name> --root <path> --max-cost-usd <n> [--model <id>] [--effort <level>]
//   pnpm live-run recommend  --repo <name> --root <path> --run <ses_…>
//   pnpm live-run regenerate --repo <name> --root <path> --run <ses_…>
//   pnpm live-run export     --repo <name> --root <path> --run <ses_…>   (exports again, sends nothing)
//
// It refuses a repository that isn't listed in docs/DEVELOPMENT_REPOSITORIES.md, or isn't clean
// at its pinned commit, before anything is read or sent. The API key comes only from
// AI_ENVIRONMENT_ARCHITECT_LIVE_API_KEY. The session lives in the storage directory (IMPL §4.2);
// after every phase it is exported to test/fixtures/live/<repo>/<run-id>/, with `setup.json`,
// and `analyse` writes `answers.json` there to fill in. Nothing is written in the repository.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { API_VERSION, createClaudeClient } from "../src/adapters/claude/client.js";
import { PRICE_TABLE } from "../src/adapters/claude/prices.js";
import { openRepositoryFs } from "../src/adapters/fs/node-repository-fs.js";
import { openGitReader } from "../src/adapters/git/git-reader.js";
import { loadReleasedPrompts } from "../src/adapters/prompts/released.js";
import {
  checkStorageOutsideRepository,
  resolveStorageDirectory,
} from "../src/adapters/storage/location.js";
import { openStorage, releaseOnExit } from "../src/adapters/storage/node-storage.js";
import { DEFAULT_CONTEXT_SETTINGS } from "../src/core/context/tiers.js";
import { DEFAULT_TOKEN_SETTINGS } from "../src/core/context/token-settings.js";
import type { Effort } from "../src/core/request.js";
import type { RunDeps } from "../src/core/run/analysis.js";
import { openSession } from "../src/core/session/store.js";
import { DEFAULT_SNAPSHOT_SETTINGS } from "../src/core/snapshot/snapshot.js";
import {
  type AnswersFile,
  answersTemplate,
  parseAnswers,
  serialiseAnswers,
} from "./live/answers.js";
import { exportRun, forbiddenIn } from "./live/export.js";
import {
  type AnalyseSettings,
  analysePhase,
  type PhaseDeps,
  type PhaseResult,
  type Prepared,
  prepareAnalyse,
  recommendPhase,
  regeneratePhase,
} from "./live/phases.js";
import { phaseSetup, readApiKey, withPhase } from "./live/setup.js";
import { checkTarget, parseDevelopmentRepositories } from "./live/targets.js";

const PRODUCT = fileURLToPath(new URL("../", import.meta.url));
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const PHASES = ["analyse", "recommend", "regenerate", "export"] as const;
type Phase = (typeof PHASES)[number];

const USAGE = `Usage:
  pnpm live-run analyse    --repo <name> --root <path> --max-cost-usd <n> [--model <id>] [--effort <level>]
  pnpm live-run recommend  --repo <name> --root <path> --run <ses_…>
  pnpm live-run regenerate --repo <name> --root <path> --run <ses_…>
  pnpm live-run export     --repo <name> --root <path> --run <ses_…>
`;
const encode = (text: string) => new TextEncoder().encode(text);

const git = (cwd: string, args: readonly string[]) =>
  new Promise<string | undefined>((resolve) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8" }, (error, stdout) =>
      resolve(error === null ? stdout : undefined),
    );
  });

function productVersion(): string {
  const manifest = JSON.parse(readFileSync(join(PRODUCT, "package.json"), "utf8")) as {
    version: string;
  };
  return manifest.version;
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { phase, values } = parsed;
  const fail = (reason: string) => {
    process.stderr.write(`Refused: ${reason}\n`);
    return 1;
  };

  // 1. Only a listed repository at its pin, checked before any file is read. `HEAD` is read
  // through the git adapter, which writes nothing in the repository.
  const repositories = parseDevelopmentRepositories(
    readFileSync(join(PRODUCT, "docs", "DEVELOPMENT_REPOSITORIES.md"), "utf8"),
  );
  let root: string;
  try {
    root = await realpath(values.root);
  } catch {
    return fail(`${values.root} doesn't exist`);
  }
  const gitReader = openGitReader(root);
  const target = await checkTarget(values.repo, repositories, gitReader);
  if (!target.ok) return fail(target.reason);

  // `export` sends nothing, so it needs no key; a key that is set is still kept out of the files.
  const key = readApiKey(env);
  if (!key.ok && phase !== "export") return fail(key.reason);

  const storage = resolveStorageDirectory(env, homedir());
  if (!storage.ok) return fail(`the storage override ${storage.value} isn't an absolute path`);
  if ((await checkStorageOutsideRepository(storage.path, root)).inside)
    return fail(`the storage directory ${storage.path} is inside ${root}`);

  const ids = { next: (prefix: string) => `${prefix}_${randomUUID()}` };
  const clock = { now: () => new Date() };
  const sessionId = phase === "analyse" ? ids.next("ses") : values.run;
  if (sessionId === undefined) return fail(`${phase} needs --run <ses_…>`);
  const runDir = join(PRODUCT, "test", "fixtures", "live", values.repo, sessionId);
  if ((await checkStorageOutsideRepository(runDir, root)).inside)
    return fail(`the run directory ${runDir} is inside ${root}`);
  const forbidden = [
    root,
    storage.path,
    homedir(),
    PRODUCT.replace(/\/$/, ""),
    ...(key.ok ? [key.key] : []),
  ];

  // 2. The phase's own inputs, and for `analyse` the snapshot, clean at the pin, before the lock,
  // so a refusal creates no session directory.
  const fs = await openRepositoryFs(root);
  const repository = { ...target.repository, root };
  const answersPath = join(runDir, "answers.json");
  let answers: AnswersFile | undefined;
  let analyse: { settings: AnalyseSettings; prepared: Prepared } | undefined;
  if (phase === "analyse") {
    const maxCostUsd = Number(values["max-cost-usd"]);
    const effort = (values.effort ?? "medium") as Effort;
    if (!(maxCostUsd > 0)) return fail("analyse needs --max-cost-usd, a positive number of USD");
    if (!EFFORTS.includes(effort)) return fail(`--effort is one of ${EFFORTS.join(", ")}`);
    const settings: AnalyseSettings = {
      selection: {
        snapshot: DEFAULT_SNAPSHOT_SETTINGS,
        context: DEFAULT_CONTEXT_SETTINGS,
        tokens: DEFAULT_TOKEN_SETTINGS,
      },
      model: values.model ?? "claude-opus-5-5",
      effort,
      maxCostUsd,
      maxExpansionRequests: 5,
      expansionBytes: 60_000,
      expansionEntryBytes: 8_000,
      questionBudget: 5,
    };
    const ready = await prepareAnalyse(
      { snapshot: { fs, git: gitReader }, ports: { clock, ids }, repository },
      settings,
    );
    if (!ready.ok) return fail(ready.reason);
    analyse = { settings, prepared: ready.prepared };
  } else if (phase !== "export") {
    if (!existsSync(answersPath)) return fail(`${answersPath} doesn't exist`);
    answers = parseAnswers(await readFile(answersPath, "utf8"));
    if (answers.runId !== sessionId) return fail(`${answersPath} is for ${answers.runId}`);
  }

  // 3. The session, under its lock.
  const version = productVersion();
  const store = openStorage(storage.path);
  const lock = await store.lock(
    sessionId,
    { startedAt: clock.now().toISOString(), productVersion: version },
    { create: phase === "analyse" },
  );
  if (lock.state === "missing") return fail(`there is no session ${sessionId}`);
  if (lock.state === "held")
    return fail(
      `session ${sessionId} is locked${lock.owner === undefined ? "" : ` by process ${lock.owner.pid} on ${lock.owner.hostname}`}`,
    );
  const writer = lock.session;
  const stopReleasing = releaseOnExit(writer);
  const startedAt = clock.now().toISOString();

  try {
    const prompts = loadReleasedPrompts();
    let result: PhaseResult = { ok: true, steps: [] };
    if (phase !== "export") {
      const client = createClaudeClient({ apiKey: key.ok ? key.key : "" });
      const run: RunDeps = {
        sender: client,
        counter: client,
        models: client,
        prices: PRICE_TABLE,
        clock,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        fs,
        prompts,
        apiVersion: API_VERSION,
      };
      const deps: PhaseDeps = {
        writer,
        repository,
        snapshot: { fs, git: gitReader },
        ports: { clock, ids },
        run,
        productVersion: version,
      };
      if (analyse !== undefined)
        result = await analysePhase(deps, analyse.settings, analyse.prepared);
      else if (answers !== undefined)
        result =
          phase === "recommend"
            ? await recommendPhase(deps, answers)
            : await regeneratePhase(deps, answers);
    }

    // 4. The export, after every phase that saved a session, refused or not. Every file is built
    // and checked before any is written, so a refusal leaves the run directory as it was.
    const loaded = await openSession(writer);
    if (loaded.ok) {
      try {
        const files = await exportRun(loaded.file, writer, forbidden);
        const setupPath = join(runDir, "setup.json");
        if (phase !== "export") {
          const productCommit = (await git(PRODUCT, ["rev-parse", "HEAD"]))?.trim() ?? null;
          const status = await git(PRODUCT, [
            "status",
            "--porcelain",
            "--",
            ".",
            ":!test/fixtures/live",
            ":!docs/LIVE_RUNS.md",
          ]);
          const entry = phaseSetup({
            phase,
            startedAt,
            productCommit,
            productTreeClean: status === "",
            prompts,
            prices: PRICE_TABLE,
            apiVersion: API_VERSION,
            records: loaded.file.records,
          });
          const before = existsSync(setupPath) ? await readFile(setupPath, "utf8") : undefined;
          files.set("setup.json", encode(withPhase(before, entry)));
        }
        if (!existsSync(answersPath))
          files.set(
            "answers.json",
            encode(serialiseAnswers(answersTemplate(sessionId, loaded.file.records))),
          );
        const found = forbiddenIn(files, forbidden);
        if (found !== undefined)
          throw new Error(`${found} contains a forbidden value (a local path or the key)`);
        for (const [path, bytes] of files) {
          await mkdir(dirname(join(runDir, path)), { recursive: true });
          await writeFile(join(runDir, path), bytes);
        }
      } catch (error) {
        process.stderr.write(
          [
            `Not exported: ${(error as Error).message}.`,
            `The session is saved in ${join(storage.path, "sessions", sessionId)}; nothing was written to ${runDir}.`,
            `Once the cause is fixed, export it again, which sends nothing:`,
            `  pnpm live-run export --repo ${values.repo} --root ${values.root} --run ${sessionId}`,
            "",
          ].join("\n"),
        );
        return 1;
      }
    }

    if (!result.ok) return fail(result.reason);
    const out = [
      `Run ${sessionId} · ${phase}`,
      ...result.steps.map((s) => `  ${s.step}: ${s.kind}`),
      ...(result.assembly === undefined
        ? []
        : [
            `  assembly: ${result.assembly.outcome}, ${result.assembly.accepted} accepted` +
              (result.assembly.refused.length === 0
                ? ""
                : `, refused: ${result.assembly.refused.join(", ")}`) +
              (result.assembly.contentHash === undefined
                ? ""
                : `, ${result.assembly.bytes} bytes ${result.assembly.contentHash}`),
          ]),
      `  exported to ${runDir}`,
      ...(phase === "analyse"
        ? [`  fill in ${answersPath}, then run recommend --run ${sessionId}`]
        : []),
      "",
    ];
    process.stdout.write(out.join("\n"));
    return 0;
  } finally {
    stopReleasing();
    await writer.release();
  }
}

function parse(argv: readonly string[]) {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      repo: { type: "string" },
      root: { type: "string" },
      run: { type: "string" },
      "max-cost-usd": { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
    },
  });
  const [phase, ...rest] = positionals;
  if (!PHASES.includes(phase as Phase) || rest.length > 0) throw new Error("name one phase");
  if (values.repo === undefined || values.root === undefined)
    throw new Error("--repo and --root are required");
  return { phase: phase as Phase, values: { ...values, repo: values.repo, root: values.root } };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
