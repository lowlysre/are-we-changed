/**
 * what-changed — `files_yaml` parsing
 *
 * Accepts a strict YAML subset:
 *
 *   group:              # top-level key at column 0
 *     - pattern         # list item, plain or fully quoted
 *     - '!negated/**'
 *
 * Anything else fails with the offending line; nothing is guessed. Every
 * accepted document means the same thing to a real YAML parser.
 * Input starting with `{` is parsed as JSON instead.
 */

/** Group name → glob patterns. */
export type Groups = Record<string, string[]>;

type Fail = (why: string) => never;

const GROUP_NAME = /^[A-Za-z0-9_-]+$/;

/** Plain scalars that real YAML would read as something other than a string. */
const NEEDS_QUOTES = /^[!&*|>{}[\]%@`"'#,]|^[?:-](\s|$)|:\s|:$/;

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
  if (NEEDS_QUOTES.test(value)) fail("unsupported plain value, wrap it in quotes");
  return value;
}

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
  const groups: Groups = {};
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
    groups[name] = patterns as string[];
  }
  return groups;
}

/** Parses the `files_yaml` input. */
export function parseGroups(text: string): Groups {
  if (text.trimStart().startsWith("{")) return parseJson(text);
  const groups: Groups = {};
  let current: string[] | undefined;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const fail: Fail = (why) => {
      throw new Error(`files_yaml line ${index + 1}: ${why}: ${raw.trim()}`);
    };
    const line = raw.trimEnd();
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (line.includes("\t")) fail("tabs are not supported");
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item) {
      if (!current) fail("list item before any group");
      current.push(parseScalar(item[1], fail));
      continue;
    }
    const key = /^([^\s:#]+):$/.exec(line.replace(/\s+#.*$/, ""));
    if (!key) fail("expected `group:` at column 0 or `- pattern`");
    if (!GROUP_NAME.test(key[1])) fail("group names may only contain letters, digits, `_` and `-`");
    if (Object.hasOwn(groups, key[1])) fail("duplicate group");
    current = groups[key[1]] = [];
  }
  for (const [name, patterns] of Object.entries(groups)) {
    if (patterns.length === 0) throw new Error(`files_yaml: group "${name}" has no patterns`);
  }
  if (Object.keys(groups).length === 0) throw new Error("files_yaml: no groups found");
  return groups;
}
