/**
 * Orchestration
 *
 * Reads inputs from an environment map, asks git for the diff and returns the
 * outputs. It reads the event file and runs git but writes nothing; main.ts
 * does that, so tests can call `run` directly.
 */

import { readFileSync } from "node:fs";

import { buildOutputs, parseNameStatus } from "./changes.ts";
import type { Change, Format } from "./changes.ts";
import { createGit, diffNameStatus, resolveRange } from "./git.ts";
import type { EventPayload } from "./git.ts";
import { parseGroups } from "./yaml.ts";
import type { Groups } from "./yaml.ts";

/** The runner's environment: `INPUT_*` variables plus `GITHUB_EVENT_PATH`. */
export type Env = Readonly<Record<string, string | undefined>>;

/** What one run produces. */
export interface Result {
  /** Output name → value, including `<group>_`-prefixed outputs. */
  readonly outputs: Record<string, string>;
  /** Informational log lines. Never contain file names. */
  readonly messages: string[];
}

/** The action's inputs after validation, in the shapes the other modules take. */
interface Inputs {
  readonly files: string[];
  readonly filesIgnore: string[];
  readonly groups: Groups;
  readonly dirNames: boolean;
  readonly maxDepth: number | undefined;
  readonly baseSha: string;
  readonly sha: string;
  readonly sinceLastRemoteCommit: boolean;
  readonly skipSameSha: boolean;
  readonly format: Format;
}

/**
 * Reads and validates every input.
 *
 * Validation is strict on purpose: a typo such as `json: ture` fails the step
 * instead of running with the default and producing the wrong output format.
 * `separator` is the one input that is not trimmed, since its default is a space.
 *
 * @throws On a boolean that is not `true`/`false`, a depth that is not a
 *   positive integer, or an invalid `files_yaml`.
 */
function readInputs(env: Env): Inputs {
  const text = (name: string): string => (env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
  const lines = (name: string): string[] =>
    text(name)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  const bool = (name: string, fallback = false): boolean => {
    const value = text(name).toLowerCase();
    if (value === "") return fallback;
    if (value !== "true" && value !== "false") {
      throw new Error(`Input "${name}" must be true or false, got "${value}"`);
    }
    return value === "true";
  };
  const depth = text("dir_names_max_depth");
  if (depth !== "" && !/^[1-9]\d*$/.test(depth)) {
    throw new Error(`Input "dir_names_max_depth" must be a positive integer, got "${depth}"`);
  }
  const matrix = bool("matrix");
  return {
    files: lines("files"),
    filesIgnore: lines("files_ignore"),
    groups: text("files_yaml") ? parseGroups(text("files_yaml")) : new Map(),
    dirNames: bool("dir_names"),
    maxDepth: depth === "" ? undefined : Number(depth),
    baseSha: text("base_sha"),
    sha: text("sha"),
    sinceLastRemoteCommit: bool("since_last_remote_commit"),
    skipSameSha: bool("skip_same_sha"),
    format: {
      json: matrix || bool("json"),
      escapeJson: !matrix && bool("escape_json", true),
      safeOutput: bool("safe_output", true),
      separator: env.INPUT_SEPARATOR || " ",
    },
  };
}

/**
 * Runs the action against the repository at `cwd`.
 *
 * This is the only place the pieces meet: it reads the event file, asks git
 * for the two commits and their diff, and hands the result to `buildOutputs`.
 * Every rule lives in a function it calls.
 *
 * @throws On invalid inputs, missing history, identical commits without
 *   `skip_same_sha`, or colliding output names. Messages are written for the
 *   workflow author and say what to change.
 */
export function run(env: Env = process.env, cwd: string = process.cwd()): Result {
  const inputs = readInputs(env);
  const event: EventPayload = env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
    : {};
  const git = createGit(cwd);
  const { base, head } = resolveRange(git, inputs, event);
  const messages = [`Comparing ${base} with ${head}`];

  let changes: Change[] = [];
  if (base !== head) {
    changes = parseNameStatus(diffNameStatus(git, base, head));
  } else if (inputs.skipSameSha) {
    messages.push(`Base and head are the same commit (${head}); reporting no changes.`);
  } else {
    throw new Error(
      `Base and head are the same commit (${head}). Set \`skip_same_sha: true\` to report no changes instead.`,
    );
  }
  return { outputs: buildOutputs(changes, inputs), messages };
}
