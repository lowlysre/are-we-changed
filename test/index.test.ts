/**
 * End-to-end tests against real git repositories created in the temp directory.
 * Each test gets a fresh repository; event payloads are written beside it.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { run } from "../src/index.ts";
import { findGit } from "../src/git.ts";
import type { EventPayload } from "../src/git.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

type Inputs = Record<string, string | boolean | number>;
type Repo = ReturnType<typeof makeRepo>;

function makeRepo(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "are-we-changed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "repo");
  mkdirSync(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  const write = (path: string, content = `${path}\n`) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const commit = (message = "commit") => {
    git("add", "--all");
    git("commit", "--quiet", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  /** Builds the env the runner would provide for the given inputs and event payload. */
  const env = (inputs: Inputs = {}, event?: EventPayload) => {
    const vars: Record<string, string> = Object.fromEntries(
      Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, String(value)]),
    );
    if (event) {
      vars.GITHUB_EVENT_PATH = join(root, "event.json");
      writeFileSync(vars.GITHUB_EVENT_PATH, JSON.stringify(event));
    }
    return vars;
  };
  const outputs = (inputs?: Inputs, event?: EventPayload) => run(env(inputs, event), dir).outputs;
  return { root, dir, git, write, commit, env, outputs };
}

/** A repository whose last commit adds, modifies, deletes and renames files. */
function makeMixedRepo(t: TestContext) {
  const repo = makeRepo(t);
  repo.write("README.md");
  repo.write("packages/core/src/index.js");
  repo.write(
    "packages/core/old-name.js",
    "a file with enough content to be detected as a rename\n",
  );
  repo.write("packages/cli/gone.js");
  repo.commit("base");
  repo.write("root.txt");
  repo.write("packages/core/src/index.js", "changed\n");
  repo.write("packages/core/README.md");
  repo.write("packages/api/v1/handler.js");
  repo.git("mv", "packages/core/old-name.js", "packages/core/new-name.js");
  repo.git("rm", "--quiet", "packages/cli/gone.js");
  repo.commit("mixed");
  return repo;
}

describe("push events", () => {
  it("compares HEAD with its parent and classifies every change", (t) => {
    const out = makeMixedRepo(t).outputs();
    assert.equal(out.added_files, "packages/api/v1/handler.js packages/core/README.md root.txt");
    assert.equal(out.modified_files, "packages/core/src/index.js");
    assert.equal(out.deleted_files, "packages/cli/gone.js");
    assert.equal(out.renamed_files, "packages/core/new-name.js");
    assert.equal(out.all_changed_files_count, "5");
    assert.equal(out.all_modified_files_count, "6");
    assert.equal(out.any_changed, "true");
    assert.equal(out.any_deleted, "true");
    assert.equal(out.changed_keys, "");
  });

  it("reports false and empty lists when nothing matches", (t) => {
    const out = makeMixedRepo(t).outputs({ files: ".github/workflows/x.yml" });
    assert.equal(out.any_changed, "false");
    assert.equal(out.any_modified, "false");
    assert.equal(out.all_changed_files, "");
    assert.equal(out.all_changed_files_count, "0");
  });

  it("treats a root commit as all files added", (t) => {
    const repo = makeRepo(t);
    repo.write("a.txt");
    repo.write("dir/b.txt");
    repo.commit("root");
    assert.equal(repo.outputs().added_files, "a.txt dir/b.txt");
  });

  it("fails with a fetch-depth hint when the parent is missing from a shallow clone", (t) => {
    const repo = makeRepo(t);
    repo.write("a.txt");
    repo.commit("one");
    repo.write("b.txt");
    repo.commit("two");
    const shallow = join(repo.root, "shallow");
    execFileSync("git", [
      "clone",
      "--quiet",
      "--depth",
      "1",
      pathToFileURL(repo.dir).href,
      shallow,
    ]);
    assert.throws(() => run({}, shallow), /shallow checkout.*fetch-depth: 0/);
  });

  it("covers every commit of a push by comparing from event.before", (t) => {
    const repo = makeRepo(t);
    repo.write("a.txt");
    const before = repo.commit("one");
    repo.write("b.txt");
    repo.commit("two");
    repo.write("c.txt");
    repo.commit("three");
    assert.equal(repo.outputs({}, { before }).added_files, "b.txt c.txt");
  });

  it("falls back to the parent for a new branch or a force push", (t) => {
    const repo = makeRepo(t);
    repo.write("a.txt");
    repo.commit("one");
    repo.write("b.txt");
    repo.commit("two");
    assert.equal(repo.outputs({}, { before: "0".repeat(40) }).added_files, "b.txt");
    assert.equal(repo.outputs({}, { before: "f".repeat(40), forced: true }).added_files, "b.txt");
  });

  it("fails with a fetch-depth hint when event.before is missing", (t) => {
    const repo = makeRepo(t);
    repo.write("a.txt");
    repo.commit("one");
    repo.write("b.txt");
    repo.commit("two");
    assert.throws(
      () => repo.outputs({}, { before: "f".repeat(40) }),
      /Previously pushed commit.*fetch-depth: 0/,
    );
  });
});

describe("pull request events", () => {
  /** main and feature diverge; returns the SHAs a pull_request payload would carry. */
  function makeDivergedRepo(t: TestContext) {
    const repo = makeRepo(t);
    repo.write("shared.txt");
    repo.commit("base");
    repo.git("switch", "--quiet", "--create", "feature");
    repo.write("feature.txt");
    const headSha = repo.commit("feature work");
    repo.git("switch", "--quiet", "main");
    repo.write("main-only.txt");
    const baseSha = repo.commit("main moves on");
    const event = { pull_request: { base: { sha: baseSha }, head: { sha: headSha } } };
    return { ...repo, event };
  }

  it("diffs a merge-commit checkout against its first parent", (t) => {
    const repo = makeDivergedRepo(t);
    repo.git("merge", "--quiet", "--no-ff", "-m", "merge", "feature");
    assert.equal(repo.outputs({}, repo.event).all_changed_files, "feature.txt");
  });

  it("diffs a head checkout against the merge base", (t) => {
    const repo = makeDivergedRepo(t);
    repo.git("switch", "--quiet", "feature");
    assert.equal(repo.outputs({}, repo.event).all_changed_files, "feature.txt");
  });

  it("fails when the checkout is the base branch, as on pull_request_target", (t) => {
    const repo = makeDivergedRepo(t);
    assert.throws(
      () => repo.outputs({}, repo.event),
      /does not contain the pull request's head commit.*pull_request_target/,
    );
    const sha = repo.event.pull_request.head.sha;
    assert.equal(repo.outputs({ sha }, repo.event).all_changed_files, "feature.txt");
  });

  it("fails with a fetch-depth hint when the base commit is missing", (t) => {
    const repo = makeDivergedRepo(t);
    const event = {
      pull_request: { base: { sha: "f".repeat(40) }, head: { sha: "e".repeat(40) } },
    };
    assert.throws(() => repo.outputs({}, event), /Pull request base commit.*fetch-depth: 0/);
  });

  it("limits the diff to the last push with since_last_remote_commit", (t) => {
    const repo = makeDivergedRepo(t);
    repo.git("switch", "--quiet", "feature");
    repo.write("second-push.txt");
    const headSha = repo.commit("more feature work");
    const event = {
      before: repo.event.pull_request.head.sha,
      pull_request: { base: repo.event.pull_request.base, head: { sha: headSha } },
    };
    repo.git("switch", "--quiet", "main");
    repo.git("merge", "--quiet", "--no-ff", "-m", "merge", "feature");
    const out = repo.outputs({ since_last_remote_commit: true }, event);
    assert.equal(out.all_changed_files, "second-push.txt");
    const missingHead = {
      ...event,
      pull_request: { ...event.pull_request, head: { sha: "e".repeat(40) } },
    };
    assert.throws(
      () => repo.outputs({ since_last_remote_commit: true }, missingHead),
      /Pull request head commit.*fetch-depth: 0/,
    );
  });
});

describe("merge group events", () => {
  it("diffs against merge_group.base_sha", (t) => {
    const repo = makeRepo(t);
    repo.write("a.txt");
    const baseSha = repo.commit("base");
    repo.write("b.txt");
    repo.commit("queued one");
    repo.write("c.txt");
    repo.commit("queued two");
    const out = repo.outputs({}, { merge_group: { base_sha: baseSha } });
    assert.equal(out.all_changed_files, "b.txt c.txt");
  });
});

describe("explicit base_sha and sha", () => {
  it("compares the given commits", (t) => {
    const repo = makeRepo(t);
    repo.write("packages/a/x.js");
    const base = repo.commit("one");
    repo.write("packages/b/y.js");
    const sha = repo.commit("two");
    repo.write("packages/c/z.js");
    repo.commit("three");
    const out = repo.outputs({
      base_sha: base,
      sha,
      files: "packages/**",
      dir_names: true,
      matrix: true,
    });
    assert.deepEqual(JSON.parse(out.all_changed_files), ["packages/b"]);
  });

  it("fails on identical commits unless skip_same_sha is set", (t) => {
    const repo = makeRepo(t);
    repo.write("a.txt");
    const sha = repo.commit("one");
    assert.throws(() => repo.outputs({ base_sha: sha, sha }), /same commit.*skip_same_sha/);
    const out = repo.outputs({ base_sha: sha, sha, skip_same_sha: true });
    assert.equal(out.any_changed, "false");
    assert.equal(out.all_changed_files, "");
  });

  it("rejects a base_sha that is not a commit in the checkout", (t) => {
    const repo = makeRepo(t);
    repo.write("a.txt");
    repo.commit("one");
    assert.throws(
      () => repo.outputs({ base_sha: "--output=owned" }),
      /base_sha "--output=owned" is not available/,
    );
  });
});

describe("hostile repository state", () => {
  it("fails on a file name that is not valid UTF-8", (t) => {
    const repo = makeRepo(t);
    repo.write("a.txt");
    const base = repo.commit("base");
    const raw = (args: string[], input: Buffer | string) =>
      execFileSync("git", args, { cwd: repo.dir, input }).toString().trim();
    const blob = raw(["hash-object", "-w", "--stdin"], "content\n");
    const entry = Buffer.concat([
      Buffer.from(`100644 blob ${blob}\t`),
      Buffer.from([0xff]),
      Buffer.from(".txt\n"),
    ]);
    const tree = raw(["mktree"], entry);
    const sha = raw(["commit-tree", tree, "-p", base, "-m", "bad name"], "");
    assert.throws(() => repo.outputs({ base_sha: base, sha }), /not valid UTF-8/);
  });

  it("fails in a partial clone instead of fetching missing file contents", (t) => {
    const repo = makeRepo(t);
    repo.git("config", "uploadpack.allowFilter", "true");
    repo.write("old.txt", "enough shared content\nto count as a rename\nwhen the file moves\n");
    repo.commit("base");
    repo.git("mv", "old.txt", "new.txt");
    repo.write(
      "new.txt",
      "enough shared content\nto count as a rename\nwhen the file moves\nplus\n",
    );
    repo.commit("rename and edit");
    const partial = join(repo.root, "partial");
    const source = pathToFileURL(repo.dir).href;
    execFileSync("git", [
      "clone",
      "--quiet",
      "--filter=blob:none",
      "--no-checkout",
      source,
      partial,
    ]);
    assert.throws(() => run({}, partial), /partial clone.*never fetches/);
  });

  it("finds git only in absolute PATH entries", (t) => {
    const repo = makeRepo(t);
    const name = process.platform === "win32" ? "git.exe" : "git";
    writeFileSync(join(repo.root, name), "");
    assert.equal(findGit([".", repo.root].join(delimiter)), join(repo.root, name));
    assert.throws(() => findGit("."), /git was not found on PATH/);
  });
});

describe("reference usages", () => {
  it("packages/** minus markdown as a JSON array of depth-2 directories", (t) => {
    const out = makeMixedRepo(t).outputs({
      files: "packages/**",
      files_ignore: "packages/**/*.md",
      dir_names: true,
      dir_names_max_depth: 2,
      json: true,
      escape_json: false,
    });
    assert.deepEqual(JSON.parse(out.all_changed_files), ["packages/api", "packages/core"]);
  });

  it("files_ignore alone with depth-1 directory names", (t) => {
    const out = makeMixedRepo(t).outputs({
      files_ignore: "**/*.md",
      dir_names: true,
      dir_names_max_depth: 1,
    });
    assert.equal(out.all_changed_files, "packages .");
  });

  it("multiline files with negation", (t) => {
    const out = makeMixedRepo(t).outputs({ files: "packages/core/**\n!**/*.md\nroot.txt" });
    assert.equal(
      out.all_changed_files,
      "packages/core/new-name.js packages/core/src/index.js root.txt",
    );
  });

  it("files_yaml groups with negation, a global files_ignore and key outputs", (t) => {
    const out = makeMixedRepo(t).outputs({
      files_yaml:
        "core:\n  - packages/core/**\n  - '!packages/core/**/*.md'\ncli:\n  - packages/cli/**\ndocs:\n  - docs/**",
      files_ignore: "**/new-name.js",
    });
    assert.equal(out.core_all_changed_files, "packages/core/src/index.js");
    assert.equal(out.core_any_changed, "true");
    assert.equal(out.cli_any_changed, "false");
    assert.equal(out.cli_any_deleted, "true");
    assert.equal(out.docs_any_modified, "false");
    assert.equal(out.changed_keys, "core");
    assert.equal(out.modified_keys, "core cli");
    assert.equal(out.all_changed_files_count, "4");
  });
});

describe("input validation", () => {
  it("rejects non-boolean and non-integer values", (t) => {
    const repo = makeMixedRepo(t);
    assert.throws(() => repo.outputs({ json: "yes" }), /Input "json" must be true or false/);
    assert.throws(
      () => repo.outputs({ matrix: true, escape_json: "ture" }),
      /Input "escape_json" must be true or false/,
    );
    assert.throws(() => repo.outputs({ dir_names_max_depth: "0" }), /must be a positive integer/);
  });

  it("fails outside a git repository", (t) => {
    const repo = makeRepo(t);
    assert.throws(() => run({}, repo.root), /Not a git repository.*actions\/checkout/);
  });
});

describe("command line entry point", () => {
  const invoke = (repo: Repo, inputs: Inputs) => {
    const outputFile = join(repo.root, "output.txt");
    writeFileSync(outputFile, "");
    // Drop the runner's own GITHUB_* and INPUT_* variables so CI does not leak into the child.
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(GITHUB|INPUT)_/.test(name)),
    );
    const env = { ...inherited, ...repo.env(inputs), GITHUB_OUTPUT: outputFile };
    const result = spawnSync(process.execPath, [MAIN], { cwd: repo.dir, env, encoding: "utf8" });
    return { ...result, written: readFileSync(outputFile, "utf8") };
  };

  it("writes delimited outputs to GITHUB_OUTPUT", (t) => {
    const { status, written } = invoke(makeMixedRepo(t), { files: "root.txt" });
    assert.equal(status, 0);
    assert.match(written, /^all_changed_files<<(wc_[0-9a-f-]+)\nroot\.txt\n\1\n/m);
    assert.match(written, /^any_changed<<(wc_[0-9a-f-]+)\ntrue\n\1\n/m);
  });

  it("echoes outputs with workflow commands stopped", (t) => {
    const repo = makeRepo(t);
    repo.write("a.txt");
    repo.commit("base");
    repo.write("##[error]forged.txt");
    repo.commit("hostile file name");
    const { status, stdout } = invoke(repo, {});
    assert.equal(status, 0);
    const lines = stdout.split("\n");
    const stop = lines.findIndex((line) => /^::stop-commands::wc_[0-9a-f-]+$/.test(line));
    const resume = lines.indexOf(`::${lines[stop].slice("::stop-commands::".length)}::`);
    const hostile = lines.findIndex((line) => line.includes("##[error]"));
    assert.ok(stop !== -1 && stop < hostile && hostile < resume);
  });

  it("exits non-zero with an error command on failure", (t) => {
    const { status, stdout, written } = invoke(makeMixedRepo(t), { files_yaml: "a: b" });
    assert.equal(status, 1);
    assert.match(stdout, /^::error::files_yaml line 1: /);
    assert.equal(written, "");
  });
});
