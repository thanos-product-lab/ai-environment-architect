// Top-level declaration patterns for code outlines and excerpts (IMPL §1.6).
//
// Changing a pattern or the extension mapping changes the context, so the set is versioned.
// Increase DECLARATION_PATTERNS_VERSION with any change; a test pins the set to its version.

export const DECLARATION_PATTERNS_VERSION = "declarations/1.0.0";

export interface LanguageFamily {
  readonly name: string;
  /** File name endings, matched case-sensitively. */
  readonly extensions: readonly string[];
  /** Matched at column zero. The first matching pattern's match is the label. */
  readonly declarations: readonly RegExp[];
  /** Decorator or attribute lines that start the declaration directly below them. */
  readonly decorators: readonly RegExp[];
  /** Lines that would match a declaration pattern but are not declarations. */
  readonly notDeclarations: readonly RegExp[];
}

const JS_NAME = "[A-Za-z_$][\\w$]*";

export const DECLARATION_FAMILIES: readonly LanguageFamily[] = [
  {
    name: "javascript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    declarations: [
      new RegExp(
        `^(?:export\\s+(?:default\\s+)?)?(?:declare\\s+)?(?:async\\s+)?function\\*?\\s*${JS_NAME}`,
      ),
      new RegExp(
        `^(?:export\\s+(?:default\\s+)?)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+${JS_NAME}`,
      ),
      new RegExp(
        `^(?:export\\s+)?(?:declare\\s+)?(?:interface|type|enum|const\\s+enum|namespace|module)\\s+(?:${JS_NAME}|["'][^"']*["'])`,
      ),
      new RegExp(
        `^(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+(?:${JS_NAME}|\\{[^}]*\\}|\\[[^\\]]*\\])(?=\\s*[:=])`,
      ),
      /^export\s+default\b/,
      /^export\s*(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)(?:\s*from\s*["'][^"']*["'])?/,
    ],
    decorators: [/^@/],
    notDeclarations: [/^(?:const|let|var)\s[^=]*=\s*require\(/],
  },
  {
    name: "python",
    extensions: [".py", ".pyi"],
    declarations: [/^(?:async\s+def|def|class)\s+[A-Za-z_]\w*/],
    decorators: [/^@/],
    notDeclarations: [],
  },
  {
    name: "go",
    extensions: [".go"],
    declarations: [
      /^func\s+(?:\([^)]*\)\s*)?[A-Za-z_]\w*/,
      /^(?:type|var|const)\s+(?:[A-Za-z_]\w*|\()/,
    ],
    decorators: [],
    notDeclarations: [],
  },
  {
    name: "rust",
    extensions: [".rs"],
    declarations: [
      /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|const|unsafe|extern(?:\s+"[^"]*")?)\s+)*fn\s+[A-Za-z_]\w*/,
      /^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|union|trait|type|mod|const|static(?:\s+mut)?)\s+[A-Za-z_]\w*/,
      /^(?:unsafe\s+)?impl\b[^{;]*/,
      /^macro_rules!\s*[A-Za-z_]\w*/,
    ],
    decorators: [/^#\[/],
    notDeclarations: [],
  },
  {
    name: "jvm-dotnet-swift",
    extensions: [".java", ".kt", ".kts", ".cs", ".swift"],
    declarations: [
      /^(?:(?:public|private|protected|internal|abstract|final|sealed|static|open|data|partial|fileprivate|inline|annotation|value|readonly)\s+)*(?:class|interface|enum|record|struct|object|fun|func|protocol|extension|namespace|typealias|actor)\s+[A-Za-z_][\w.]*/,
    ],
    decorators: [/^@/, /^\[[A-Za-z]/],
    notDeclarations: [],
  },
  {
    name: "ruby",
    extensions: [".rb"],
    declarations: [/^(?:class|module|def)\s+[\w:.]+[?!=]?/],
    decorators: [],
    notDeclarations: [],
  },
  {
    name: "php",
    extensions: [".php"],
    declarations: [
      /^(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum|function)\s+&?[A-Za-z_]\w*/,
    ],
    decorators: [/^#\[/],
    notDeclarations: [],
  },
];

export interface Declaration {
  /** The 1-based line that matched a declaration pattern. */
  readonly line: number;
  /** The 1-based first line of the declaration: its first decorator, or `line`. */
  readonly start: number;
  readonly label: string;
  /** The label before it was cut, only when it was cut. The secret scan reads it (IMPL §1.7). */
  readonly uncutLabel?: string;
}

export const MAX_LABEL_CHARACTERS = 80;

function familyOf(path: string): LanguageFamily | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return DECLARATION_FAMILIES.find((family) =>
    family.extensions.some((ext) => name.length > ext.length && name.endsWith(ext)),
  );
}

export function languageFamily(path: string): string | undefined {
  return familyOf(path)?.name;
}

/** Cuts text to `MAX_LABEL_CHARACTERS` code points, ending with `…` when cut. */
export function cutLabel(text: string): string {
  const chars = Array.from(text);
  return chars.length <= MAX_LABEL_CHARACTERS
    ? text
    : `${chars.slice(0, MAX_LABEL_CHARACTERS - 1).join("")}…`;
}

/**
 * The top-level declarations in `lines`, in file order, or undefined when the path is in no
 * language family.
 */
export function findDeclarations(
  path: string,
  lines: readonly string[],
): Declaration[] | undefined {
  const family = familyOf(path);
  if (family === undefined) return undefined;
  const declarations: Declaration[] = [];
  let decoratorStart: number | undefined;
  lines.forEach((text, index) => {
    const line = index + 1;
    if (family.decorators.some((pattern) => pattern.test(text))) {
      decoratorStart ??= line;
      return;
    }
    const uncut = labelOf(family, text);
    if (uncut !== undefined) {
      const label = cutLabel(uncut);
      declarations.push({
        line,
        start: decoratorStart ?? line,
        label,
        ...(label === uncut ? {} : { uncutLabel: uncut }),
      });
    }
    decoratorStart = undefined;
  });
  return declarations;
}

function labelOf(family: LanguageFamily, text: string): string | undefined {
  if (family.notDeclarations.some((pattern) => pattern.test(text))) return undefined;
  for (const pattern of family.declarations) {
    const match = pattern.exec(text);
    if (match !== null) return match[0].trimEnd();
  }
  return undefined;
}
