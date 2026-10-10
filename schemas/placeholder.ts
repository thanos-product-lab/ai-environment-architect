// Placeholder until M3. Proves that Zod 4 generates JSON Schema (ADR 0002).
import { z } from "zod";

export const placeholder = z.strictObject({
  id: z.string(),
});
