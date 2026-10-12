import type { SecretRuleId } from "../../src/core/context/secrets.js";

// Secret-scan fixtures, one set per rule (IMPL §1.7).
//
// Committed files must never contain anything that looks like a real credential: push protection
// may block the push, and scanners would flag the repository. Matching values are therefore
// joined from fragments at test time, or are documented example values such as AWS's
// AKIAIOSFODNN7EXAMPLE.

const join = (...fragments: string[]): string => fragments.join("");

/** 20 mixed letters and digits. */
const body20 = join("a1B2c3D4e5", "F6g7H8i9J0");

export interface SecretFixture {
  readonly rule: SecretRuleId;
  /** Lines the rule must match. */
  readonly matches: readonly string[];
  /** Near misses that no rule may match. */
  readonly misses: readonly string[];
}

export const SECRET_FIXTURES: readonly SecretFixture[] = [
  {
    rule: "private-key",
    matches: [
      join("-----BEGIN", " RSA PRIVATE", " KEY-----"),
      join("-----BEGIN", " PRIVATE", " KEY-----"),
      join("-----BEGIN", " OPENSSH PRIVATE", " KEY-----"),
      join("-----BEGIN", " ENCRYPTED PRIVATE", " KEY-----"),
      join("-----BEGIN", " PGP PRIVATE", " KEY BLOCK-----"),
    ],
    misses: [
      "-----BEGIN PUBLIC KEY-----",
      "-----BEGIN CERTIFICATE-----",
      "Paste your private key here.",
    ],
  },
  {
    rule: "aws-access-key-id",
    matches: [
      "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
      "AKIAIOSFODNN7EXAMPLE",
      join("ASIA", "IOSFODNN7EXAMPLE"),
    ],
    misses: [
      // 15 characters after the prefix, lower case, and a longer run.
      "AKIAIOSFODNN7EXAMPL",
      "akiaiosfodnn7example",
      "AKIAIOSFODNN7EXAMPLEX",
    ],
  },
  {
    rule: "github-token",
    matches: [
      join("gh", "p_", body20, "k1L2m3N4o5P6q7R8"),
      join("gh", "s_", body20, "k1L2m3N4o5P6q7R8"),
      join("github", "_pat_", body20, "_k1"),
    ],
    misses: [
      // 35 characters after the prefix, and an unknown prefix.
      join("gh", "p_", body20, "k1L2m3N4o5P6q7R"),
      join("gh", "x_", body20, "k1L2m3N4o5P6q7R8"),
    ],
  },
  {
    rule: "slack-token",
    matches: [join("xo", "xb-", "1234567890-", body20), join("xo", "xp-", "0123456789")],
    misses: [join("xo", "xz-", "1234567890"), join("xo", "xb-", "short")],
  },
  {
    rule: "stripe-key",
    matches: [join("sk", "_live_", body20), join("rk", "_test_", body20)],
    misses: [
      // Publishable keys are not secrets.
      join("pk", "_live_", body20),
      join("sk", "_live_", "short"),
    ],
  },
  {
    rule: "anthropic-key",
    matches: [join("sk-", "ant-", "api03-", body20, body20)],
    misses: [join("sk-", "ant-", "api03-", "short")],
  },
  {
    rule: "openai-key",
    matches: [
      join("sk-", "proj-", body20, "_x-Y"),
      join("sk-", "svcacct-", body20),
      join("sk-", body20, "T3Blbk", "FJ", body20),
    ],
    misses: [join("sk-", "proj-", "short"), join("sk-", body20, body20)],
  },
  {
    rule: "connection-string",
    matches: [
      join("postgres://", "app:", "s3cret", "@db.internal:5432/app"),
      join("redis://", ":hunter2", "@cache:6379"),
      join("mongodb+srv://", "admin:", "pa55", "@cluster0.example.net/test"),
      // A URL-encoded password is a literal.
      join("postgres://", "app:", "%40bc1", "@db/app"),
    ],
    misses: [
      // References, not literals.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell-style reference, not a template
      "postgres://${DB_USER}:${DB_PASSWORD}@db:5432/app",
      "postgres://app:$DB_PASSWORD@db:5432/app",
      "postgres://app:{password}@db/app",
      "postgres://app:<password>@db/app",
      "postgres://app:%s@db/app",
      // No password, or no credentials at all.
      "git+ssh://git@github.com:org/repo.git",
      "https://user@example.com/",
      "http://localhost:3000/@user",
    ],
  },
  {
    rule: "generic-assignment",
    matches: [
      // AWS's documented example secret access key.
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      `api_key: "${body20}"`,
      `"apiKey": "${body20}",`,
      `const SESSION_SECRET = '${body20}';`,
      `password := \`${body20}\``,
      `'auth_token' => '${body20}'`,
      `DB_PASSWORD=${body20}`,
      `token: "${body20}=="`,
      `  - "POSTGRES_PASSWORD=${body20}"`,
      `ID_TOKEN=${join("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0In0", ".", "SflKxwRJSMeKKF2QT4fw")}`,
      `   3 | GITHUB_TOKEN=${body20} # rendered line`,
    ],
    misses: [
      "const token = request.headers.authorization;",
      "password: process.env.DB_PASSWORD,",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell-style reference, not a template
      "API_TOKEN=${API_TOKEN}",
      "API_TOKEN=your_api_token_goes_here",
      'tokenUrl = "https://example.com/oauth/token/2"',
      'password: "correct horse battery staple 42"',
      "API_TOKEN=changeme1",
      `if (token === "${body20}") {`,
      `if (token == "${body20}") {`,
      `token !== "${body20}"`,
      "tokens.map((token) => token.value1234567890)",
      `api_key:\n  ${body20}`,
      `monkey = "${body20}"`,
      // Code references, not literals.
      "apiKey: process.env.STRIPE_KEY_V2,",
      "clientSecret: config.auth0.clientSecret1,",
      "password: hashedPasswords.user1234567890,",
      "const tokenPath = path/to/token/file2.json;",
    ],
  },
];
