/**
 * Git access
 *
 * Chooses the two commits to compare and diffs them. Never fetches: missing
 * history is an error that says how to fix the checkout. A silent fallback to
 * a different base would produce a wrong file list that looks valid.
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

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
  /** The `since_last_remote_commit` input. Only changes pull request events. */
  readonly sinceLastRemoteCommit?: boolean;
}

/** The parts of a webhook payload this action reads. */
export interface EventPayload {
  readonly before?: string;
  /** True on a force push, where `before` is not an ancestor of the head. */
  readonly forced?: boolean;
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
  "Set `fetch-depth: 0` on actions/checkout (`fetch-depth: 2` is enough for a push of one commit and for pull request merge commits).";

/**
 * Finds the git executable on `PATH` and returns its absolute path.
 *
 * Spawning the bare name `git` on Windows searches the working directory
 * before `PATH`, and the working directory is the checkout: a pull request
 * could add a `git.exe` there and have it run. Only absolute `PATH` entries
 * are considered, so `.` on the path cannot bring the checkout back in.
 *
 * @throws When no git executable is on `PATH`.
 */
export function findGit(pathVariable: string = process.env.PATH ?? ""): string {
  const name = process.platform === "win32" ? "git.exe" : "git";
  for (const directory of pathVariable.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  }
  throw new Error("git was not found on PATH.");
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Binds git to the repository at `cwd`.
 *
 * - `safe.directory` is set per call because container jobs run as a different
 *   user than the one that owns the checkout, which git otherwise refuses.
 * - `core.quotepath=false` keeps non-ASCII paths as UTF-8 instead of octal escapes.
 * - `GIT_NO_LAZY_FETCH` stops git from fetching missing objects in a partial
 *   clone on its own, which would break the never-fetches guarantee.
 *
 * Output is decoded strictly. A file name that is not valid UTF-8 would
 * otherwise be published with replacement characters, naming a path that does
 * not exist and merging distinct names.
 *
 * @throws From `git`, when the command fails or its output is not valid UTF-8.
 */
export function createGit(cwd: string): Git {
  const executable = findGit();
  const prefix = [
    "-c",
    `safe.directory=${cwd.replaceAll("\\", "/")}`,
    "-c",
    "core.quotepath=false",
  ];
  const env = { ...process.env, GIT_NO_LAZY_FETCH: "1" };
  const git = (...args: string[]): string => {
    const output = execFileSync(executable, [...prefix, ...args], {
      cwd,
      env,
      maxBuffer: 1024 ** 3,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      return utf8.decode(output);
    } catch {
      throw new Error(
        "A changed file name is not valid UTF-8, so it cannot be reported accurately. Rename the file.",
      );
    }
  };
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
 * | push                          | `event.before`, so every pushed commit counts |
 * | everything else               | parent of head (empty tree for a root commit) |
 *
 * A new branch has an all-zero `before` and a force push an unreachable one;
 * both fall through to the parent of head. Any other push whose `before` is
 * missing fails, since the parent alone would drop the earlier commits.
 *
 * On pull requests, `sinceLastRemoteCommit` swaps in `event.before` when that
 * commit exists locally, and the head becomes the pull request's head commit.
 *
 * A pull request event whose checkout is not the pull request fails, unless
 * `sha` says which commit to use. `pull_request_target` checks out the base
 * branch by default, and diffing that would report the base branch's own
 * changes as the pull request's.
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

  if (baseSha) {
    const base = need(baseSha, "base_sha");
    return { base: pr ? mergeBase(base, head) : base, head };
  }
  if (pr) {
    const pushedBefore = sinceLastRemoteCommit ? commit(event.before) : null;
    if (pushedBefore) {
      return {
        base: pushedBefore,
        head: sha ? head : need(pr.head?.sha, "Pull request head commit"),
      };
    }
    const [, ...parents] = (tryGit("rev-list", "--parents", "-n", "1", head) ?? "").split(" ");
    if (parents.length === 2 && parents[1] === pr.head?.sha) return { base: parents[0], head };
    const base = need(pr.base?.sha, "Pull request base commit");
    if (!sha) {
      const prHead = commit(pr.head?.sha);
      if (!prHead || tryGit("merge-base", "--is-ancestor", prHead, head) === null) {
        throw new Error(
          `The checkout does not contain the pull request's head commit "${pr.head?.sha}", so HEAD is not the pull request. On pull_request_target the default checkout is the base branch. Check out the pull request's head or merge ref, or set \`sha\`.`,
        );
      }
    }
    return { base: mergeBase(base, head), head };
  }
  if (event.merge_group) {
    return { base: need(event.merge_group.base_sha, "Merge group base commit"), head };
  }
  if (event.before && !/^0+$/.test(event.before) && !event.forced) {
    return { base: need(event.before, "Previously pushed commit"), head };
  }

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
 *
 * @throws When git fails. In a partial clone, rename detection can need file
 *   contents that were never downloaded; that case gets its own message.
 */
export function diffNameStatus({ git }: Git, base: string, head: string): string {
  try {
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
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (!/promisor|lazy fetch/i.test(stderr)) throw error;
    throw new Error(
      "git diff needs file contents this partial clone does not have, and this action never fetches. Remove `filter` from actions/checkout.",
    );
  }
}
