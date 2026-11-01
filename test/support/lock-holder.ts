// A separate process that takes a session's lock, installs the exit handlers, prints "locked"
// and waits, so a test can send it a real signal (IMPL §4.7, §4.11).
// Usage: node --import ./test/support/ts-resolve.mjs test/support/lock-holder.ts <storage dir>
import { openStorage, releaseOnExit } from "../../src/adapters/storage/node-storage.js";

const directory = process.argv[2];
if (directory === undefined) throw new Error("usage: lock-holder <storage directory>");
const result = await openStorage(directory).lock(
  "ses_0001",
  { productVersion: "0.0.0", startedAt: new Date().toISOString() },
  { create: true },
);
if (result.state !== "acquired") throw new Error(`lock not acquired: ${result.state}`);
releaseOnExit(result.session);
process.stdout.write("locked\n");
setInterval(() => {}, 1000);
