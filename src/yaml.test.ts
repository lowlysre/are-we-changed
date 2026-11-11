import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseGroups } from "./yaml.ts";

describe("parseGroups: accepted subset", () => {
  it("parses groups, quotes and comments", () => {
    const text = [
      "# leading comment",
      "src:   # trailing comment",
      "  - src/main/**",
      "  - '!src/main/**/*.md'   # negation must be quoted",
      "",
      "pom:",
      '- "pom.xml"',
      "  - path with spaces/file.txt",
      "  - 'has # hash'",
      "  - a#b",
    ].join("\r\n");
    assert.deepEqual(parseGroups(text), {
      src: ["src/main/**", "!src/main/**/*.md"],
      pom: ["pom.xml", "path with spaces/file.txt", "has # hash", "a#b"],
    });
  });

  it("parses JSON when the input starts with {", () => {
    assert.deepEqual(parseGroups(' {"a": ["x/**", "!x/*.md"], "b-2": "y"}'), {
      a: ["x/**", "!x/*.md"],
      "b-2": ["y"],
    });
  });
});

describe("parseGroups: rejections", () => {
  // [description, input, expected error]
  const table: [description: string, input: string, expected: RegExp][] = [
    ["unquoted negation (YAML tag)", "a:\n  - !x/**", /line 2: unsupported plain value.*!x/],
    ["unquoted leading * (YAML alias)", "a:\n  - **/*.md", /line 2: unsupported plain value/],
    ["anchor", "a:\n  - &anchor x", /line 2: unsupported plain value/],
    ["flow sequence item", "a:\n  - [x, y]", /line 2: unsupported plain value/],
    ["flow sequence value", "a: [x, y]", /line 1: expected `group:`/],
    ["scalar value", "a: x", /line 1: expected `group:`/],
    ["block scalar", "a:\n  - |", /line 2: unsupported plain value/],
    ["nested map", "a:\n  b:\n    - x", /line 2: expected `group:`/],
    ["map inside a list", "a:\n  - b: c", /line 2: unsupported plain value/],
    ["nested list", "a:\n  - - x", /line 2: unsupported plain value/],
    ["item before any group", "- x", /line 1: list item before any group/],
    ["duplicate group", "a:\n  - x\na:\n  - y", /line 3: duplicate group/],
    ["invalid group name", "a.b:\n  - x", /line 1: group names may only contain/],
    ["unterminated quote", "a:\n  - 'x", /line 2: unterminated quote/],
    ["escaped single quote", "a:\n  - 'it''s'", /line 2: unexpected text after closing quote/],
    ["double-quote escape", 'a:\n  - "x\\ty"', /line 2: escape sequences are not supported/],
    ["empty quoted pattern", "a:\n  - ''", /line 2: empty pattern/],
    ["tab indentation", "a:\n\t- x", /line 2: tabs are not supported/],
    ["document marker", "---\na:\n  - x", /line 1: expected `group:`/],
    ["group without patterns", "a:\nb:\n  - x", /group "a" has no patterns/],
    ["comments only", "# nothing", /no groups found/],
    ["invalid JSON", '{"a": [', /invalid JSON/],
    ["JSON with non-string pattern", '{"a": [1]}', /group "a" must be a non-empty list/],
    ["JSON with empty list", '{"a": []}', /group "a" must be a non-empty list/],
    ["JSON with invalid group name", '{"a b": ["x"]}', /invalid group name "a b"/],
  ];

  for (const [description, input, expected] of table) {
    it(`rejects ${description}`, () => {
      assert.throws(() => parseGroups(input), expected);
    });
  }
});
