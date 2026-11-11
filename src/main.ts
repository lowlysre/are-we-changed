/**
 * what-changed-files: action entry point
 *
 * The only module with side effects: writes outputs to GITHUB_OUTPUT, echoes
 * them to the log and reports failures as workflow commands. Runs as shipped;
 * Node strips the types.
 *
 * File names come from the pull request, so they are untrusted on both paths:
 *
 * - Log: the runner executes `##[command]` anywhere in a line and `::command::`
 *   at the start of one, so a file name could forge an annotation or mask a
 *   value. Outputs are echoed between `::stop-commands::` and its resume token.
 * - GITHUB_OUTPUT: each value sits between delimiter lines. A fixed delimiter
 *   could be closed early by a file name containing it.
 *
 * Both tokens are random per run, so a file name cannot contain them.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

import { run } from "./index.ts";

/** Encodes a message as workflow command data, so a newline in it cannot start another command. */
const escapeCommand = (text: string): string =>
  text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

try {
  const { outputs, messages } = run();
  for (const message of messages) console.log(message);

  const resume = `wc_${randomUUID()}`;
  console.log(`::stop-commands::${resume}`);
  for (const [name, value] of Object.entries(outputs)) console.log(`${name}: ${value}`);
  console.log(`::${resume}::`);

  if (process.env.GITHUB_OUTPUT) {
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
