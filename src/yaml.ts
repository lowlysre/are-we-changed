/**
 * what-changed-files: `files_yaml` parsing
 *
 * Accepts a strict YAML subset:
 *
 *   group:              # top-level key at column 0
 *     - pattern         # list item, plain or fully quoted
 *     - '!negated/**'
 *
 * The contract is that every accepted document means the same thing to a real
 * YAML parser. Anything outside the subset fails with the offending line, so a
 * pattern is never silently read differently than its author intended.
 * Input starting with `{` is parsed as JSON instead.
 */

/**
 * Group name → glob patterns, in document order.
 *
 * A Map because group names are user input: a plain object would treat
 * `__proto__` as its prototype and drop the group.
 */
export type Groups = Map<string, string[]>;

/** Throws a parse error for the current line. */
type Fail = (why: string) => never;

/** Restricted to characters that are valid in an output name. */
const GROUP_NAME = /^[A-Za-z0-9_-]+$/;

/** Plain scalars that YAML reads as syntax: tags, anchors, aliases, flow, block scalars, maps. */
const INDICATOR = /^[!&*|>{}[\]%@`"'#,]|^[?:-](\s|$)|:\s|:$/;

/**
 * Plain scalars that YAML resolves to a null, boolean, number or timestamp
 * rather than a string. Covers the YAML 1.1 forms (`yes`, `0o17`, `1:30`) as
 * well as 1.2, since parsers in the wild implement either.
 */
const IMPLICIT_TYPE = new RegExp(
  `^(?:${[
    "~|null|true|false|yes|no|on|off|y|n",
    "[-+]?(\\d[\\d_]*(\\.[\\d_]*)?|\\.\\d[\\d_]*)(e[-+]?\\d+)?",
    "[-+]?0(x[\\da-f_]+|o[0-7_]+|b[01_]+)",
    "[-+]?\\d[\\d_]*(:[0-5]?\\d)+(\\.\\d*)?",
    "[-+]?\\.(inf|nan)",
    "\\d{4}-\\d\\d?-\\d\\d?([t ].*)?",
  ].join("|")})$`,
  "i",
);

/**
 * Reads one list item's value.
 *
 * Quoted values are taken literally and have to close on the same line with
 * nothing but a comment after them. Escapes are rejected instead of decoded,
 * because `''` and `\t` mean different things in the two quote styles.
 */
function parseScalar(text: string, fail: Fail): string {
  const quote = text[0];
  if (quote === "'" || quote === '"') {
    const end = text.indexOf(quote, 1);
    if (end === -1) fail("unterminated quote");
    if (!/^(\s+#.*)?$/.test(text.slice(end + 1))) fail("unexpected text after closing quote");
    const value = text.slice(1, end);
    if (quote === '"' && value.includes("\\")) fail("escape sequences are not supported");
    if (value.trim() === "") fail("empty pattern");
    return value;
  }
  const value = text.replace(/\s+#.*$/, "").trim();
  if (value === "") fail("empty pattern");
  if (INDICATOR.test(value) || IMPLICIT_TYPE.test(value)) {
    fail("unsupported plain value, wrap it in quotes");
  }
  return value;
}

/** Parses the JSON form: an object of group name → pattern or list of patterns. */
function parseJson(text: string): Groups {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`files_yaml: invalid JSON: ${(error as Error).message}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("files_yaml: JSON must be an object of group names to pattern lists");
  }
  const groups: Groups = new Map();
  for (const [name, value] of Object.entries(data)) {
    if (!GROUP_NAME.test(name)) throw new Error(`files_yaml: invalid group name "${name}"`);
    const patterns: unknown = typeof value === "string" ? [value] : value;
    const valid =
      Array.isArray(patterns) &&
      patterns.length > 0 &&
      patterns.every((pattern) => typeof pattern === "string" && pattern.trim() !== "");
    if (!valid) {
      throw new Error(`files_yaml: group "${name}" must be a non-empty list of pattern strings`);
    }
    groups.set(name, patterns as string[]);
  }
  return groups;
}

/**
 * Parses the `files_yaml` input.
 *
 * Items of one group have to share an indentation. YAML reads a deeper `- x`
 * line as a continuation of the previous plain scalar, so accepting it as a
 * second pattern would break the same-meaning contract.
 *
 * @throws With the 1-based line number and the line's text for any construct
 *   outside the subset, and for a group or document with no patterns.
 */
export function parseGroups(text: string): Groups {
  if (text.trimStart().startsWith("{")) return parseJson(text);
  const groups: Groups = new Map();
  let current: string[] | undefined;
  let indent: number | undefined;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const fail: Fail = (why) => {
      throw new Error(`files_yaml line ${index + 1}: ${why}: ${raw.trim()}`);
    };
    const line = raw.trimEnd();
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (line.includes("\t")) fail("tabs are not supported");
    // JavaScript's \s is wider than YAML's: a no-break space before `#` would start a comment here only.
    if (/[^\S ]/.test(line)) fail("whitespace other than a space is not supported");
    const item = /^( *)-\s+(.*)$/.exec(line);
    if (item) {
      if (!current) fail("list item before any group");
      indent ??= item[1].length;
      if (item[1].length !== indent) fail("list items in a group must share one indentation");
      current.push(parseScalar(item[2], fail));
      continue;
    }
    const key = /^([^\s:#]+):$/.exec(line.replace(/\s+#.*$/, ""));
    if (!key) fail("expected `group:` at column 0 or `- pattern`");
    if (!GROUP_NAME.test(key[1])) fail("group names may only contain letters, digits, `_` and `-`");
    if (IMPLICIT_TYPE.test(key[1])) {
      fail("YAML reads this group name as a number, boolean or null; use the JSON form for it");
    }
    if (groups.has(key[1])) fail("duplicate group");
    current = [];
    indent = undefined;
    groups.set(key[1], current);
  }
  for (const [name, patterns] of groups) {
    if (patterns.length === 0) throw new Error(`files_yaml: group "${name}" has no patterns`);
  }
  if (groups.size === 0) throw new Error("files_yaml: no groups found");
  return groups;
}
