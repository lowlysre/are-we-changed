import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compileGlob, createMatcher, expandBraces } from "../src/glob.ts";

describe("glob dialect", () => {
  // [pattern, path, expected]
  const table: [pattern: string, path: string, expected: boolean][] = [
    // literals
    ["README.md", "README.md", true],
    ["README.md", "docs/README.md", false],
    ["a.b", "axb", false],
    ["a+(b).txt", "a+(b).txt", true],
    // *
    ["*.md", "README.md", true],
    ["*.md", "docs/README.md", false],
    ["*", ".gitignore", true],
    ["src/*", "src/a.js", true],
    ["src/*", "src/lib/a.js", false],
    ["src/*.test.js", "src/glob.test.js", true],
    ["a*c", "abc", true],
    ["a*c", "a/c", false],
    // **
    ["**", "a/b/c.txt", true],
    ["**", "a.txt", true],
    ["**/*.md", "README.md", true],
    ["**/*.md", "a/b/README.md", true],
    ["**/*.md", "a/b/README.mdx", false],
    ["packages/**", "packages/core/src/index.js", true],
    ["packages/**", "packages", false],
    ["packages/**", "other/packages/a.js", false],
    ["packages/**/*.md", "packages/README.md", true],
    ["packages/**/*.md", "packages/core/docs/README.md", true],
    ["src/**/test/*.js", "src/test/a.js", true],
    ["src/**/test/*.js", "src/a/b/test/a.js", true],
    ["src/**/test/*.js", "src/a/b/tests/a.js", false],
    ["a**b", "axxb", true],
    ["a**b", "a/b", false],
    ["**/.github/**", ".github/workflows/ci.yml", true],
    // ?
    ["file?.txt", "file1.txt", true],
    ["file?.txt", "file12.txt", false],
    ["a?b", "a/b", false],
    // [...]
    ["[abc].txt", "b.txt", true],
    ["[abc].txt", "d.txt", false],
    ["[a-c]x", "bx", true],
    ["[!a-c]x", "bx", false],
    ["[!a-c]x", "dx", true],
    ["[^a-c]x", "dx", true],
    ["a[!b]c", "a/c", false],
    ["[]a]", "]", true],
    ["[abc", "[abc", true],
    ["[0\\-9]", "-", true],
    ["[0\\-9]", "5", false],
    ["[a\\-c]", "b", false],
    ["[\\]a]", "]", true],
    ["[\\]a]", "\\", false],
    ["file[{a,b}].txt", "file{.txt", true],
    ["file[{a,b}].txt", "file,.txt", true],
    ["{x,[,]}.txt", ",.txt", true],
    // {a,b}
    ["*.{js,ts}", "a.ts", true],
    ["*.{js,ts}", "a.jsx", false],
    ["{src,test}/**", "test/a/b.js", true],
    ["{src,test}/**", "lib/a.js", false],
    ["a{,.bak}", "a", true],
    ["a{,.bak}", "a.bak", true],
    ["{a,b{c,d}}.txt", "bd.txt", true],
    ["{a,b{c,d}}.txt", "b.txt", false],
    ["{a}.txt", "{a}.txt", true],
    ["{a}.txt", "a.txt", false],
    // escapes
    ["\\*.md", "*.md", true],
    ["\\*.md", "a.md", false],
    ["\\{a,b\\}", "{a,b}", true],
    // normalization
    ["./src/*.js", "src/a.js", true],
    ["docs/", "docs/a/b.md", true],
    [" src/*.js ", "src/a.js", true],
    // case sensitivity
    ["*.MD", "readme.md", false],
    // newlines, which git allows in file names
    ["src/**", "src/a\nb.ts", true],
    ["**/*.ts", "a\nb/c.ts", true],
    ["*.ts", "a.ts\n", false],
  ];

  for (const [pattern, path, expected] of table) {
    it(`${pattern} ${expected ? "matches" : "rejects"} ${JSON.stringify(path)}`, () => {
      assert.equal(compileGlob(pattern).matches(path), expected);
    });
  }

  it("flags a leading ! as negation", () => {
    const { negated, matches } = compileGlob("!docs/**");
    assert.equal(negated, true);
    assert.equal(matches("docs/a.md"), true);
  });

  it("stays fast on a file name built to nearly match", () => {
    const { matches } = compileGlob("**/*.*.*.*.*.*.*.json");
    const started = performance.now();
    assert.equal(matches(`src/${".".repeat(4000)}.jsonx`), false);
    assert.ok(performance.now() - started < 1000);
  });

  it("rejects an invalid character class", () => {
    assert.throws(() => compileGlob("[z-a].txt"), /Invalid character class "\[z-a\]"/);
  });

  it("rejects an empty pattern", () => {
    assert.throws(() => compileGlob("!"), /Empty glob pattern/);
  });

  it("expands nested braces", () => {
    assert.deepEqual(expandBraces("{a,b{c,d}}/x"), ["a/x", "bc/x", "bd/x"]);
  });
});

describe("createMatcher", () => {
  it("matches everything without patterns", () => {
    assert.equal(createMatcher()("any/file.txt"), true);
  });

  it("applies negation after inclusion regardless of order", () => {
    const matches = createMatcher(["!src/**/*.md", "src/**"]);
    assert.equal(matches("src/a.js"), true);
    assert.equal(matches("src/docs/a.md"), false);
    assert.equal(matches("lib/a.js"), false);
  });

  it("treats negation-only patterns as everything except", () => {
    const matches = createMatcher(["!**/*.md"]);
    assert.equal(matches("src/a.js"), true);
    assert.equal(matches("README.md"), false);
  });

  it("applies ignore patterns on top of includes", () => {
    const matches = createMatcher(["packages/**"], ["packages/**/*.md"]);
    assert.equal(matches("packages/core/index.js"), true);
    assert.equal(matches("packages/core/README.md"), false);
  });

  it("rejects negation inside files_ignore", () => {
    assert.throws(() => createMatcher([], ["!a"]), /Negation is not supported in files_ignore/);
  });
});
