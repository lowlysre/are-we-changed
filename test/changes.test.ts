import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildOutputs,
  escapeUnsafe,
  formatList,
  parseNameStatus,
  summarize,
  toDirNames,
  toOutputs,
} from "../src/changes.ts";
import type { Change } from "../src/changes.ts";

const everything = () => true;

describe("parseNameStatus", () => {
  it("classifies statuses and reports renames by their new path", () => {
    const output = [
      "A",
      "new.txt",
      "M",
      "mod.txt",
      "D",
      "gone.txt",
      "R087",
      "old.txt",
      "moved.txt",
      "T",
      "link",
      "",
    ].join("\0");
    assert.deepEqual(parseNameStatus(output), [
      { status: "added", path: "new.txt" },
      { status: "modified", path: "mod.txt" },
      { status: "deleted", path: "gone.txt" },
      { status: "renamed", path: "moved.txt" },
      { status: "modified", path: "link" },
    ]);
  });

  it("returns nothing for an empty diff", () => {
    assert.deepEqual(parseNameStatus(""), []);
  });
});

describe("toDirNames", () => {
  const paths = ["a.txt", "packages/core/src/x.js", "packages/core/src/y.js", "packages/cli/z.js"];

  it("returns unique directories with . for root-level files", () => {
    assert.deepEqual(toDirNames(paths), [".", "packages/core/src", "packages/cli"]);
  });

  it("truncates to the maximum depth", () => {
    assert.deepEqual(toDirNames(paths, 2), [".", "packages/core", "packages/cli"]);
    assert.deepEqual(toDirNames(paths, 1), [".", "packages"]);
  });
});

describe("summarize", () => {
  const changes: Change[] = [
    { status: "added", path: "src/new.js" },
    { status: "modified", path: "src/mod.js" },
    { status: "deleted", path: "src/gone.js" },
    { status: "renamed", path: "docs/moved.md" },
  ];

  it("keeps diff order, with deleted files only in all_modified_files", () => {
    assert.deepEqual(summarize(changes, everything), {
      added_files: ["src/new.js"],
      modified_files: ["src/mod.js"],
      deleted_files: ["src/gone.js"],
      renamed_files: ["docs/moved.md"],
      all_changed_files: ["src/new.js", "src/mod.js", "docs/moved.md"],
      all_modified_files: ["src/new.js", "src/mod.js", "src/gone.js", "docs/moved.md"],
    });
  });

  it("filters before collapsing to directory names", () => {
    const summary = summarize(changes, (path) => path.startsWith("src/"), { dirNames: true });
    assert.deepEqual(summary.all_changed_files, ["src"]);
    assert.deepEqual(summary.renamed_files, []);
  });
});

describe("formatList", () => {
  const items = ["a.txt", "b c.txt"];

  it("joins with a space by default", () => {
    assert.equal(formatList(items), "a.txt b c.txt");
  });

  it("honours a custom separator", () => {
    assert.equal(formatList(items, { separator: "," }), "a.txt,b c.txt");
  });

  it("escapes quotes in JSON unless told otherwise", () => {
    assert.equal(formatList(items, { json: true }), '[\\"a.txt\\",\\"b c.txt\\"]');
    assert.equal(formatList(items, { json: true, escapeJson: false }), '["a.txt","b c.txt"]');
  });

  it("round-trips escaped JSON through an enclosing JSON string", () => {
    const awkward = ['quo"te.txt', "back\\slash.txt", "new\nline.txt"];
    const embedded = `{"files": "${formatList(awkward, { json: true })}"}`;
    assert.deepEqual(JSON.parse(JSON.parse(embedded).files), awkward);
  });

  it("escapes shell metacharacters only when safe_output is on", () => {
    const hostile = ["$(curl evil.sh).txt", "it's;rm -rf.txt"];
    assert.equal(formatList(hostile), "\\$\\(curl evil.sh\\).txt it\\'s\\;rm -rf.txt");
    assert.equal(formatList(hostile, { safeOutput: false }), hostile.join(" "));
  });

  it("escapes non-ASCII and backslashes", () => {
    assert.equal(escapeUnsafe("a\nb\\c`d"), "a\\\nb\\\\c\\`d");
  });

  it("escapes a character outside the BMP as one unit", () => {
    assert.equal(escapeUnsafe("😀.txt"), "\\😀.txt");
  });
});

describe("toOutputs", () => {
  it("emits lists, counts and booleans under the group prefix", () => {
    const summary = summarize([{ status: "deleted", path: "a.txt" }], everything);
    const outputs = toOutputs(summary, {}, "docs_");
    assert.equal(outputs.docs_deleted_files, "a.txt");
    assert.equal(outputs.docs_deleted_files_count, "1");
    assert.equal(outputs.docs_all_changed_files, "");
    assert.equal(outputs.docs_all_changed_files_count, "0");
    assert.equal(outputs.docs_any_changed, "false");
    assert.equal(outputs.docs_any_modified, "true");
    assert.equal(outputs.docs_any_deleted, "true");
  });
});

describe("buildOutputs", () => {
  const changes: Change[] = [
    { status: "added", path: "src/new.js" },
    { status: "deleted", path: "docs/gone.md" },
  ];
  const build = (groups: Record<string, string[]>, files: string[] = []) =>
    buildOutputs(changes, {
      files,
      filesIgnore: [],
      groups: new Map(Object.entries(groups)),
      format: {},
    });

  it("sets top-level outputs, group outputs and the key lists", () => {
    const outputs = build({ src: ["src/**"], docs: ["docs/**"], ci: [".github/**"] }, ["src/**"]);
    assert.equal(outputs.all_changed_files, "src/new.js");
    assert.equal(outputs.src_any_changed, "true");
    assert.equal(outputs.docs_any_changed, "false");
    assert.equal(outputs.docs_any_deleted, "true");
    assert.equal(outputs.changed_keys, "src");
    assert.equal(outputs.modified_keys, "src docs");
  });

  it("rejects groups whose outputs would overwrite another output", () => {
    assert.throws(
      () => build({ all: ["a"] }),
      /group "all" and the top-level outputs both set the output "all_modified_files"/,
    );
    assert.throws(
      () => build({ src: ["a"], src_all: ["b"] }),
      /group "src_all" and group "src" both set the output "src_all_modified_files"/,
    );
    assert.throws(
      () => build({ src: ["a"], SRC: ["b"] }),
      /group "SRC" and group "src" both set the output "SRC_added_files"/,
    );
  });
});
