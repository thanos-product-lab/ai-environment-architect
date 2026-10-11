import fc from "fast-check";

// CI sets FAST_CHECK_SEED so a failing property test reproduces with the same inputs. Without
// it, each run explores new inputs; fast-check prints the seed of any failure.
const seed = process.env["FAST_CHECK_SEED"];
if (seed !== undefined && seed !== "") {
  if (!/^-?[0-9]+$/.test(seed)) throw new Error(`FAST_CHECK_SEED must be an integer: ${seed}`);
  fc.configureGlobal({ seed: Number(seed) });
}
