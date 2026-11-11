/**
 * what-changed: git access
 *
 * Chooses the two commits to compare and diffs them. Never fetches: missing
 * history is an error that says how to fix the checkout. A silent fallback to
 * a different base would produce a wrong file list that looks valid.
 */

import { execFileSync } from "node:child_process";

/** The two ways this module runs git, bound to one repository. */
export interface Git {
  /** Runs git and returns stdout; throws on a non-zero exit. */
  git(...args: string[]): string;
  /** Runs git and returns trimmed stdout, or null on a non-zero exit. */
  tryGit(...args: string[]): string | null;
}

/** The inputs that steer commit selection. Empty strings mean "not set". */
export interface RangeOptions {
  /** The `base_sha` input: any revision git can resolve to a commit. */
  readonly baseSha?: string;
  /** The `sha` input. Defaults to `HEAD`. */
  readonly sha?: string;
  /** The `since_last_remote_commit` input. */
  readonly sinceLastRemoteCommit?: boolean;
}

/** The parts of a webhook payload this action reads. */
export interface EventPayload {
  readonly before?: string;
  readonly pull_request?: {
    readonly base?: { readonly sha?: string };
    readonly head?: { readonly sha?: string };
  };
  readonly merge_group?: { readonly base_sha?: string };
}

/** Resolved object IDs. `base` is a commit, or the empty tree for a root commit. */
export interface Range {
  readonly base: string;
  readonly head: string;
}

/** Appended to every missing-history error so the failure carries its fix. */
const HISTORY_HINT =
  "Set `fetch-depth: 0` on actions/checkout (`fetch-depth: 2` is enough for push events and pull request merge commits).";

/**
 * Binds git to the repository at `cwd`.
 *
 * `safe.directory` is set per call because container jobs run as a different
 * user than the one that owns the checkout, which git otherwise refuses.
 * `core.quotepath=false` keeps non-ASCII paths as UTF-8 instead of octal escapes.
 */
export function createGit(cwd: string): Git {
  const prefix = [
    "-c",
    `safe.directory=${cwd.replaceAll("\\", "/")}`,
    "-c",
    "core.quotepath=false",
  ];
  const git = (...args: string[]): string =>
    execFileSync("git", [...prefix, ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 ** 3,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const tryGit = (...args: string[]): string | null => {
    try {
      return git(...args).trim();
    } catch {
      return null;
    }
  };
  return { git, tryGit };
}

/**
 * Resolves the commits to compare from the inputs and the event payload.
 *
 * | Event                         | Base                                          |
 * |-------------------------------|-----------------------------------------------|
 * | any, `base_sha` set           | `base_sha` (merge base with head on PRs)      |
 * | pull request, merge checkout  | first parent of the merge commit              |
 * | pull request, other checkout  | merge base of the PR base and head            |
 * | merge group                   | `merge_group.base_sha`                        |
 * | everything else               | parent of head (empty tree for a root commit) |
 *
 * `sinceLastRemoteCommit` swaps in `event.before` when that commit exists locally.
 * A force push or a new branch leaves `before` unknown or all zeros, and the
 * table above applies instead.
 *
 * Revisions come from workflow inputs and event payloads, so each is resolved
 * with `--end-of-options` and can never be read as a git flag. A root commit
 * is compared against the empty tree, which reports every file as added.
 *
 * @throws When `cwd` is not a repository, or a commit the comparison needs is
 *   not in the checkout. The message names the `fetch-depth` to set.
 */
export function resolveRange(
  { tryGit }: Git,
  { baseSha, sha, sinceLastRemoteCommit }: RangeOptions,
  event: EventPayload = {},
): Range {
  if (tryGit("rev-parse", "--git-dir") === null) {
    throw new Error("Not a git repository. Run actions/checkout before this action.");
  }
  const commit = (rev: string | undefined): string | null =>
    rev && !/^0+$/.test(rev)
      ? tryGit("rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`)
      : null;
  const need = (rev: string | undefined, what: string): string => {
    const found = commit(rev);
    if (!found) {
      throw new Error(`${what} "${rev}" is not available in this checkout. ${HISTORY_HINT}`);
    }
    return found;
  };
  const mergeBase = (base: string, head: string): string => {
    const found = tryGit("merge-base", base, head);
    if (!found) throw new Error(`No merge base found between ${base} and ${head}. ${HISTORY_HINT}`);
    return found;
  };

  const head = need(sha || "HEAD", "Head commit");
  const pr = event.pull_request;
  const pushedBefore = sinceLastRemoteCommit ? commit(event.before) : null;

  if (baseSha) {
    const base = need(baseSha, "base_sha");
    return { base: pr ? mergeBase(base, head) : base, head };
  }
  if (pr) {
    if (pushedBefore) {
      return { base: pushedBefore, head: sha ? head : (commit(pr.head?.sha) ?? head) };
    }
    const [, ...parents] = (tryGit("rev-list", "--parents", "-n", "1", head) ?? "").split(" ");
    if (parents.length === 2 && parents[1] === pr.head?.sha) return { base: parents[0], head };
    return { base: mergeBase(need(pr.base?.sha, "Pull request base commit"), head), head };
  }
  if (event.merge_group) {
    return { base: need(event.merge_group.base_sha, "Merge group base commit"), head };
  }
  if (pushedBefore) return { base: pushedBefore, head };

  const parent = commit(`${head}^`);
  if (parent) return { base: parent, head };
  if (tryGit("rev-parse", "--is-shallow-repository") === "true") {
    throw new Error(
      `The parent of ${head} is not available in this shallow checkout. ${HISTORY_HINT}`,
    );
  }
  const emptyTree = tryGit("hash-object", "-t", "tree", "--stdin");
  if (!emptyTree) throw new Error("Could not compute the empty tree for a root commit.");
  return { base: emptyTree, head };
}

/**
 * Diffs two trees and returns raw `--name-status -z` output for `parseNameStatus`.
 *
 * `-z` is what makes paths with spaces, quotes or newlines unambiguous. `-M`
 * and `--no-ext-diff` are passed explicitly so the result does not depend on
 * the runner's git config.
 */
export function diffNameStatus({ git }: Git, base: string, head: string): string {
  return git(
    "diff",
    "--name-status",
    "-z",
    "-M",
    "--no-ext-diff",
    "--ignore-submodules=all",
    base,
    head,
    "--",
  );
}
