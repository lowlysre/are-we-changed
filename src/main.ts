/**
 * what-changed — action entry point
 *
 * The only module with side effects: writes outputs to GITHUB_OUTPUT and
 * reports failures as workflow commands. Runs as shipped; Node strips the types.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

import { run } from "./index.ts";

const escapeCommand = (text: string): string =>
  text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

try {
  const { outputs, messages } = run();
  for (const message of messages) console.log(message);
  for (const [name, value] of Object.entries(outputs)) console.log(`${name}: ${value}`);
  if (process.env.GITHUB_OUTPUT) {
    // A random delimiter keeps file names from terminating the value early.
    const delimiter = `wc_${randomUUID()}`;
    const blocks = Object.entries(outputs).map(
      ([name, value]) => `${name}<<${delimiter}\n${value}\n${delimiter}\n`,
    );
    appendFileSync(process.env.GITHUB_OUTPUT, blocks.join(""));
  }
} catch (error) {
  console.log(`::error::${escapeCommand(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
}
