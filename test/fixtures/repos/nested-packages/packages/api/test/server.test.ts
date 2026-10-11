import { greet } from "../src/server";

if (greet("apple") !== "hello apple") throw new Error("greet");
