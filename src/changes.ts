/**
 * what-changed: change classification and output formatting
 *
 * Pure functions with no side effects: they turn `git diff --name-status -z`
 * text into the action's outputs. Git and the Actions runtime live elsewhere.
 */

import type { Matcher } from "./glob.ts";

/** The four buckets every git status letter is folded into. */
export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

/** One changed path. */
export interface Change {
  readonly status: ChangeStatus;
  /** Path after the change; for renames, the new path. */
  readonly path: string;
}

/**
 * The list outputs, before formatting. Property names are the output names,
 * so adding a property here adds an output and its `_count`.
 */
export interface Summary {
  readonly added_files: string[];
  readonly modified_files: string[];
  readonly deleted_files: string[];
  readonly renamed_files: string[];
  /** Added, modified and renamed. */
  readonly all_changed_files: string[];
  /** Added, modified, renamed and deleted. */
  readonly all_modified_files: string[];
}

/** The `dir_names` and `dir_names_max_depth` inputs. */
export interface DirNameOptions {
  readonly dirNames?: boolean;
  /** Leading path segments to keep. Unset keeps the full directory. */
  readonly maxDepth?: number;
}

/** How a list becomes one output string. */
export interface Format {
  /** Emit a JSON array instead of a separated string. */
  readonly json?: boolean;
  /** Backslash-escape the quotes in JSON, for outputs pasted into another JSON string. */
  readonly escapeJson?: boolean;
  /** Escape shell metacharacters. Applies to separated strings only. */
  readonly safeOutput?: boolean;
  readonly separator?: string;
}

/** Status letters with their own bucket. Every other letter is "modified". */
const STATUS: Record<string, ChangeStatus> = { A: "added", D: "deleted", R: "renamed" };

/**
 * Parses `git diff --name-status -z` output.
 *
 * Records are NUL-separated `status, path`, except renames and copies, which
 * are `status, old path, new path`; the old path is skipped. Type changes and
 * any letter git adds later count as modified.
 */
export function parseNameStatus(output: string): Change[] {
  const tokens = output.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < tokens.length && tokens[i] !== ""; i++) {
    const code = tokens[i][0];
    if (code === "R" || code === "C") i++;
    changes.push({ status: STATUS[code] ?? "modified", path: tokens[++i] });
  }
  return changes;
}

/**
 * Maps paths to their unique parent directories, in first-seen order.
 * Root-level files become `.`, matching what a matrix job can `cd` into.
 *
 * @param maxDepth Leading path segments to keep; `packages/core/src` at depth 2 is `packages/core`.
 */
export function toDirNames(paths: readonly string[], maxDepth?: number): string[] {
  const dirs = paths.map((path) => {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    return maxDepth ? dir.split("/").slice(0, maxDepth).join("/") : dir;
  });
  return [...new Set(dirs)];
}

/**
 * Buckets the changes accepted by `matches` into the output lists, in diff order.
 *
 * Filtering happens on file paths before they collapse to directory names, so
 * a pattern always describes files, with or without `dirNames`.
 */
export function summarize(
  changes: readonly Change[],
  matches: Matcher,
  { dirNames = false, maxDepth }: DirNameOptions = {},
): Summary {
  const pick = (...statuses: ChangeStatus[]): string[] => {
    const paths = changes
      .filter((change) => statuses.includes(change.status) && matches(change.path))
      .map((change) => change.path);
    return dirNames ? toDirNames(paths, maxDepth) : paths;
  };
  return {
    added_files: pick("added"),
    modified_files: pick("modified"),
    deleted_files: pick("deleted"),
    renamed_files: pick("renamed"),
    all_changed_files: pick("added", "modified", "renamed"),
    all_modified_files: pick("added", "modified", "renamed", "deleted"),
  };
}

/**
 * Backslash-escapes characters that are dangerous when an output is
 * interpolated into a shell: everything outside printable ASCII, plus the
 * metacharacters listed in the class.
 *
 * This limits the damage of an inline `${{ }}` in a `run:` step. It does not
 * make one safe; passing the output through `env:` does.
 */
export const escapeUnsafe = (text: string): string =>
  text.replace(/[^\x20-\x7E]|[:*?"'<>|;`$()&!\\]/g, "\\$&");

/**
 * Renders one list as an output value.
 *
 * JSON is never shell-escaped: the escapes would corrupt it, and JSON output
 * is meant for `fromJSON` or a parser, not for word splitting.
 */
export function formatList(
  items: readonly string[],
  { json = false, escapeJson = true, safeOutput = true, separator = " " }: Format = {},
): string {
  if (json) {
    const text = JSON.stringify(items);
    return escapeJson ? text.replace(/"/g, '\\"') : text;
  }
  return (safeOutput ? items.map(escapeUnsafe) : items).join(separator);
}

/**
 * Flattens a summary into output name → value: each list, its `_count`, and
 * the `any_*` booleans. Every value is a string because that is all an action
 * output can hold.
 *
 * @param prefix `<group>_` for a `files_yaml` group, empty for the top-level outputs.
 */
export function toOutputs(summary: Summary, format: Format, prefix = ""): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const [name, items] of Object.entries(summary)) {
    outputs[`${prefix}${name}`] = formatList(items, format);
    outputs[`${prefix}${name}_count`] = String(items.length);
  }
  outputs[`${prefix}any_changed`] = String(summary.all_changed_files.length > 0);
  outputs[`${prefix}any_modified`] = String(summary.all_modified_files.length > 0);
  outputs[`${prefix}any_deleted`] = String(summary.deleted_files.length > 0);
  return outputs;
}
