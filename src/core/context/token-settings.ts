// The token check's settings (IMPL §1.10, §1.14). They are part of the selection settings that
// `settingsHash` covers, because they change what the token check removes. The check itself
// arrives in M6's token-check step.

export type CallPurpose =
  | "analyse"
  | "analyse_expansion"
  | "generate_questions"
  | "recommend"
  | "regenerate_recommendations";

export interface TokenSettings {
  /** Sent as each call's `max_tokens`, so it holds thinking as well as output. Provisional (§3.9). */
  readonly reservedOutputTokens: Readonly<Record<CallPurpose, number>>;
  /** A fraction of the model's input limit, `max_input_tokens` (§1.10). */
  readonly safetyMargin: number;
}

export const DEFAULT_TOKEN_SETTINGS: TokenSettings = {
  reservedOutputTokens: {
    analyse: 16_000,
    analyse_expansion: 12_000,
    generate_questions: 16_000,
    recommend: 16_000,
    regenerate_recommendations: 16_000,
  },
  safetyMargin: 0.05,
};
