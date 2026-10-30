// Command names in manifests (IMPL §3.2.5). Each reader takes the file's lines, as `lineTexts`
// gives them, and returns every definition with the 1-based lines it spans, in file order. None
// of them is a full parser: they read the common forms the spec lists and nothing else.
// Duplicates are kept; the caller keeps one fact per name.

export interface CommandDefinition {
  readonly name: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

// ---------------------------------------------------------------------------------------------
// package.json

export type PackageJsonResult =
  | { readonly ok: true; readonly commands: readonly CommandDefinition[] }
  | { readonly ok: false };

/**
 * String members of the top-level `scripts` object. A key that appears twice counts at its last
 * occurrence, the one `JSON.parse` keeps, in both `scripts` and the top level.
 */
export function packageJsonScripts(lines: readonly string[]): PackageJsonResult {
  const text = lines.join("\n");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const scripts = isObject(parsed) ? parsed["scripts"] : undefined;
  if (!isObject(scripts)) return { ok: true, commands: [] };

  // The text is valid JSON, so the scanner only has to find where things are.
  const scanner = new JsonScanner(text);
  const top = scanner.members();
  const value = lastValue(top, "scripts");
  if (value === undefined) return { ok: true, commands: [] };
  scanner.at = value;
  const members = scanner.members();
  const commands: CommandDefinition[] = [];
  for (const [name, member] of last(members)) {
    if (typeof scripts[name] !== "string") continue;
    commands.push({
      name,
      lineStart: lineOf(text, member.keyStart),
      lineEnd: lineOf(text, member.valueEnd - 1),
    });
  }
  return { ok: true, commands: commands.sort((a, b) => a.lineStart - b.lineStart) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface JsonMember {
  readonly key: string;
  readonly keyStart: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

/** Each key's last member, in order of those last occurrences. */
function last(members: readonly JsonMember[]): Map<string, JsonMember> {
  const byKey = new Map<string, JsonMember>();
  for (const member of members) {
    byKey.delete(member.key);
    byKey.set(member.key, member);
  }
  return byKey;
}

function lastValue(members: readonly JsonMember[], key: string): number | undefined {
  return last(members).get(key)?.valueStart;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
  return line;
}

/** Positions in text already known to be valid JSON. */
class JsonScanner {
  at = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  /** The members of the object starting at `at`, or none if it isn't an object. */
  members(): JsonMember[] {
    this.space();
    if (this.text[this.at] !== "{") return [];
    this.at++;
    const members: JsonMember[] = [];
    for (;;) {
      this.space();
      if (this.text[this.at] === "}") break;
      const keyStart = this.at;
      this.string();
      const key = JSON.parse(this.text.slice(keyStart, this.at)) as string;
      this.space();
      this.at++; // ':'
      this.space();
      const valueStart = this.at;
      this.value();
      members.push({ key, keyStart, valueStart, valueEnd: this.at });
      this.space();
      if (this.text[this.at] === ",") this.at++;
    }
    return members;
  }

  private space(): void {
    while (/[ \t\n\r]/.test(this.text[this.at] ?? "")) this.at++;
  }

  private string(): void {
    this.at++;
    while (this.text[this.at] !== '"') this.at += this.text[this.at] === "\\" ? 2 : 1;
    this.at++;
  }

  private value(): void {
    const c = this.text[this.at];
    if (c === '"') {
      this.string();
      return;
    }
    if (c === "{" || c === "[") {
      let depth = 0;
      do {
        const d = this.text[this.at];
        if (d === '"') {
          this.string();
          continue;
        }
        if (d === "{" || d === "[") depth++;
        else if (d === "}" || d === "]") depth--;
        this.at++;
      } while (depth > 0);
      return;
    }
    while (this.at < this.text.length && !/[,}\] \t\n\r]/.test(this.text[this.at] ?? "")) {
      this.at++;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// pyproject.toml

const SCRIPT_TABLE = /^\[\s*(?:project\.scripts|tool\.poetry\.scripts)\s*\]\s*(?:#.*)?$/;
const TOML_KEY = /^[ \t]*(?:([A-Za-z0-9_-]+)|"([^"\\]*)"|'([^']*)')[ \t]*=/;

/** Keys of `[project.scripts]` and `[tool.poetry.scripts]`, each on a line of its own. */
export function pyprojectScripts(lines: readonly string[]): CommandDefinition[] {
  const commands: CommandDefinition[] = [];
  let inTable = false;
  lines.forEach((line, index) => {
    if (line.startsWith("[")) {
      inTable = SCRIPT_TABLE.test(line);
      return;
    }
    if (!inTable) return;
    const match = TOML_KEY.exec(line);
    const name = match?.[1] ?? match?.[2] ?? match?.[3];
    if (name !== undefined) commands.push({ name, lineStart: index + 1, lineEnd: index + 1 });
  });
  return commands;
}

// ---------------------------------------------------------------------------------------------
// Makefile

const MAKE_DIRECTIVES =
  /^(?:include|-include|sinclude|vpath|export|unexport|override|private|define|undefine|ifeq|ifneq|ifdef|ifndef|else|endif)(?:[ \t]|$)/;

/** Target lines: everything before a colon that doesn't start an assignment. */
export function makefileTargets(lines: readonly string[]): CommandDefinition[] {
  const commands: CommandDefinition[] = [];
  let inDefine = false;
  let continued = false;
  lines.forEach((line, index) => {
    const wasContinued = continued;
    continued = line.endsWith("\\");
    if (wasContinued) return;
    if (inDefine) {
      if (/^[ \t]*endef(?:[ \t]|$)/.test(line)) inDefine = false;
      return;
    }
    if (/^[ \t]*(?:(?:override|export|private)[ \t]+)*define(?:[ \t]|$)/.test(line)) {
      inDefine = true;
      return;
    }
    if (line === "" || /^[\t #]/.test(line) || MAKE_DIRECTIVES.test(line)) return;
    const colon = line.indexOf(":");
    if (colon === -1) return;
    const before = line.slice(0, colon);
    const after = line.slice(colon + 1);
    if (before.includes("=") || after.startsWith("=") || /^:{1,2}=/.test(after)) return;
    for (const word of before.split(/[ \t]+/)) {
      if (word === "" || word === "&" || /^\.|[%$]/.test(word)) continue;
      commands.push({ name: word, lineStart: index + 1, lineEnd: index + 1 });
    }
  });
  return commands;
}

// ---------------------------------------------------------------------------------------------
// justfile

const RECIPE = /^@?([A-Za-z_][A-Za-z0-9_-]*)(?:[ \t][^:]*)?:(?!=)/;

/** Recipe lines, leaving out private recipes: `_name`, or `[private]` among the attributes. */
export function justfileRecipes(lines: readonly string[]): CommandDefinition[] {
  const commands: CommandDefinition[] = [];
  let attributes: string[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith("[")) {
      attributes.push(line);
      return;
    }
    const pending = attributes;
    attributes = [];
    if (/^(?:mod|import)\??[ \t]/.test(line)) return;
    const name = RECIPE.exec(line)?.[1];
    if (name === undefined || name.startsWith("_")) return;
    if (pending.some((attribute) => /(?<![A-Za-z0-9_-])private(?![A-Za-z0-9_-])/.test(attribute)))
      return;
    commands.push({ name, lineStart: index + 1, lineEnd: index + 1 });
  });
  return commands;
}

// ---------------------------------------------------------------------------------------------
// Taskfile

const TASKS = /^tasks:[ \t]*(?:#.*)?$/;
const TASK_KEY = /^(?:"([^"\\]*)"|'([^']*)'|((?!<<)[^\s#"'](?:[^:#]*[^\s:#])?)):(?:[ \t]|$)/;

/** Keys of the top-level block mapping `tasks:`, at the indentation of its first entry. */
export function taskfileTasks(lines: readonly string[]): CommandDefinition[] {
  const commands: CommandDefinition[] = [];
  const start = lines.findIndex((line) => TASKS.test(line));
  if (start === -1) return commands;
  let indent: string | undefined;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (lead === "") break;
    indent ??= lead;
    if (lead !== indent) continue;
    const match = TASK_KEY.exec(line.slice(lead.length));
    const name = match?.[1] ?? match?.[2] ?? match?.[3];
    if (name !== undefined) commands.push({ name, lineStart: index + 1, lineEnd: index + 1 });
  }
  return commands;
}
