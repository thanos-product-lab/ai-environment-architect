// Lets a plain `node` child process run this repository's TypeScript sources, whose imports end
// in `.js` (ADR 0002): Node strips the types, and this hook maps a missing relative `.js` import
// to its `.ts` file. Used only by tests that need a real separate process.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && specifier.endsWith(".js"))
        return next(`${specifier.slice(0, -3)}.ts`, context);
      throw error;
    }
  },
});
