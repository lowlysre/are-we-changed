/**
 * what-changed: orchestration
 *
 * Reads inputs from an environment map, asks git for the diff and returns the
 * outputs. Nothing here writes to the process; main.ts does that, so tests
 * can call `run` directly.
 */

import { readFileSync } from "node:fs";

import { formatList, parseNameStatus, summarize, toOutputs } from "./changes.ts";
import type { Change, Format } from "./changes.ts";
import { createGit, diffNameStatus, resolveRange } from "./git.ts";
import type { EventPayload } from "./git.ts";
import { createMatcher } from "./glob.ts";
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
 * The top-level outputs are always set and reflect `files` and `files_ignore`.
 * Each `files_yaml` group adds the same outputs under a `<group>_` prefix,
 * filtered by its own patterns plus `files_ignore`.
 *
 * Two names can spell the same output: group `all` makes `all_modified_files`,
 * and groups `src` and `src_all` both make `src_all_modified_files`. The
 * runner also treats output names case-insensitively, so `src` and `SRC`
 * collide. A collision fails the run, because overwriting would publish one
 * list under another's name.
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

  const outputs: Record<string, string> = {};
  const owners = new Map<string, string>();
  const publish = (entries: Record<string, string>, owner: string): void => {
    for (const [name, value] of Object.entries(entries)) {
      const key = name.toLowerCase();
      const taken = owners.get(key);
      if (taken) {
        throw new Error(
          `files_yaml: ${owner} and ${taken} both set the output "${name}". Rename one of the groups.`,
        );
      }
      owners.set(key, owner);
      outputs[name] = value;
    }
  };

  const top = summarize(changes, createMatcher(inputs.files, inputs.filesIgnore), inputs);
  publish(toOutputs(top, inputs.format), "the top-level outputs");

  const changedKeys: string[] = [];
  const modifiedKeys: string[] = [];
  for (const [name, patterns] of inputs.groups) {
    const summary = summarize(changes, createMatcher(patterns, inputs.filesIgnore), inputs);
    publish(toOutputs(summary, inputs.format, `${name}_`), `group "${name}"`);
    if (summary.all_changed_files.length > 0) changedKeys.push(name);
    if (summary.all_modified_files.length > 0) modifiedKeys.push(name);
  }
  publish(
    {
      changed_keys: formatList(changedKeys, inputs.format),
      modified_keys: formatList(modifiedKeys, inputs.format),
    },
    "the top-level outputs",
  );
  return { outputs, messages };
}
