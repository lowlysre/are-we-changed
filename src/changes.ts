/**
 * what-changed — change classification and output formatting
 *
 * Pure functions with no side effects: they turn `git diff --name-status -z`
 * text into the action's outputs. Git and the Actions runtime live elsewhere.
 */

import type { Matcher } from "./glob.ts";

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface Change {
  readonly status: ChangeStatus;
  /** Path after the change; for renames, the new path. */
  readonly path: string;
}

/** The list outputs, before formatting. */
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

export interface DirNameOptions {
  readonly dirNames?: boolean;
  readonly maxDepth?: number;
}

export interface Format {
  readonly json?: boolean;
  readonly escapeJson?: boolean;
  readonly safeOutput?: boolean;
  readonly separator?: string;
}

const STATUS: Record<string, ChangeStatus> = { A: "added", D: "deleted", R: "renamed" };

/** Parses `git diff --name-status -z` output. Type changes count as modified. */
export function parseNameStatus(output: string): Change[] {
  const tokens = output.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < tokens.length && tokens[i] !== ""; i++) {
    const code = tokens[i][0];
    if (code === "R" || code === "C") i++; // skip the old path
    changes.push({ status: STATUS[code] ?? "modified", path: tokens[++i] });
  }
  return changes;
}

/** Unique parent directories, `.` for root-level files, cut to `maxDepth` segments. */
export function toDirNames(paths: readonly string[], maxDepth?: number): string[] {
  const dirs = paths.map((path) => {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    return maxDepth ? dir.split("/").slice(0, maxDepth).join("/") : dir;
  });
  return [...new Set(dirs)];
}

/** Buckets the changes accepted by `matches` into the output lists, in diff order. */
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

/** Backslash-escapes characters that are dangerous when an output is interpolated into a shell. */
export const escapeUnsafe = (text: string): string =>
  text.replace(/[^\x20-\x7E]|[:*?"'<>|;`$()&!\\]/g, "\\$&");

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

/** Flattens a summary into output name → value, optionally prefixed with `<group>_`. */
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
