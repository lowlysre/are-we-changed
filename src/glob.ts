/**
 * what-changed: glob matching
 *
 * Dialect: `*`, `**`, `?`, `[...]`, `{a,b}`, `\` escapes and a leading `!`.
 * Paths are always `/`-separated and matching is case-sensitive.
 *
 * Each glob compiles to a list of tokens that is matched by tracking every
 * position the pattern could be at, one path character at a time. That costs
 * at most path length × pattern length, whatever the file name looks like. A
 * backtracking regex does not have that bound: file names come from the pull
 * request, and a name built to nearly match `*.*.*.*` could stall the action.
 *
 * The dialect is hand-rolled so the action has no dependency and behaves the
 * same on every Node version; `test/glob.test.ts` holds the table that defines it.
 */

/** One compiled pattern. */
export interface CompiledGlob {
  /** True when the pattern had a leading `!`, which `matches` does not apply. */
  readonly negated: boolean;
  /** Tests a whole path, never a substring. */
  readonly matches: Matcher;
}

/** Decides whether a repository-relative, `/`-separated path is selected. */
export type Matcher = (path: string) => boolean;

/** One step of a pattern. */
interface Token {
  /** Whether this token can consume `char`. */
  readonly accepts: (char: string) => boolean;
  /** A wildcard: consumes any number of accepted characters, including none. */
  readonly loop?: boolean;
  /** Set on a `**` that is followed by `/`: that `/` token may be skipped along with this one. */
  readonly skipNext?: boolean;
}

const notSlash = (char: string): boolean => char !== "/";
const literal = (expected: string): Token => ({ accepts: (char) => char === expected });

/**
 * Finds the `]` that closes the class opening at `open`.
 *
 * A `]` directly after the opening (or after the negation mark) is a member,
 * as in `[]a]`, and `\x` is always a member.
 *
 * @returns The index of the closing `]`, or -1 when the class is unclosed.
 */
function classEnd(pattern: string, open: number): number {
  let i = open + 1;
  if (pattern[i] === "!" || pattern[i] === "^") i++;
  if (pattern[i] === "]") i++;
  for (; i < pattern.length; i++) {
    if (pattern[i] === "\\") i++;
    else if (pattern[i] === "]") return i;
  }
  return -1;
}

/**
 * Expands `{a,b}` alternatives bash-style, recursing for nested and repeated groups.
 * Braces without a top-level comma stay literal, and `\{` never opens a group.
 * Class contents are skipped, so `[{,}]` keeps `{` and `,` as members.
 *
 * @returns Every brace-free pattern the input stands for, at least one.
 */
export function expandBraces(pattern: string): string[] {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      i++;
      continue;
    }
    if (pattern[i] === "[") i = Math.max(i, classEnd(pattern, i));
    if (pattern[i] !== "{") continue;
    const parts: string[] = [];
    let depth = 0;
    let from = i + 1;
    for (let j = from; j < pattern.length; j++) {
      const c = pattern[j];
      if (c === "\\") {
        j++;
      } else if (c === "[") {
        j = Math.max(j, classEnd(pattern, j));
      } else if (c === "{") {
        depth++;
      } else if (c === "," && depth === 0) {
        parts.push(pattern.slice(from, j));
        from = j + 1;
      } else if (c === "}" && depth-- === 0) {
        if (parts.length === 0) break;
        parts.push(pattern.slice(from, j));
        const [before, after] = [pattern.slice(0, i), pattern.slice(j + 1)];
        return parts.flatMap((part) => expandBraces(before + part + after));
      }
    }
  }
  return [pattern];
}

/**
 * Turns one brace-free glob into tokens.
 *
 * - `**` spans directories only as a whole path segment; elsewhere it is `*`.
 * - A class never matches `/`, so `a[!b]c` cannot cross a directory boundary.
 * - Inside a class, `\x` is the literal member `x`, so `[a\-c]` holds `a`, `-`
 *   and `c` while `[a-c]` is a range. An unclosed `[` is a literal.
 *
 * A class is tested with a one-character regex, which cannot backtrack.
 *
 * @throws On a class the regex engine rejects, such as the reversed range `[z-a]`.
 */
function tokenize(pattern: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      tokens.push(literal(pattern[++i]));
    } else if (c === "?") {
      tokens.push({ accepts: notSlash });
    } else if (c === "[") {
      const end = classEnd(pattern, i);
      if (end === -1) {
        tokens.push(literal("["));
        continue;
      }
      const negated = pattern[i + 1] === "!" || pattern[i + 1] === "^";
      let body = "";
      for (let k = i + (negated ? 2 : 1); k < end; k++) {
        const escaped = pattern[k] === "\\";
        if (escaped) k++;
        const member = pattern[k];
        const plain = escaped || "[]^".includes(member);
        body += plain && /\W/.test(member) ? `\\${member}` : member;
      }
      let members: RegExp;
      try {
        members = new RegExp(`^[${negated ? "^" : ""}${body}]$`, "s");
      } catch {
        throw new Error(`Invalid character class "${pattern.slice(i, end + 1)}" in glob pattern`);
      }
      tokens.push({ accepts: (char) => char !== "/" && members.test(char) });
      i = end;
    } else if (c === "*") {
      let j = i;
      while (pattern[j + 1] === "*") j++;
      const wholeSegment =
        (i === 0 || pattern[i - 1] === "/") && (j === pattern.length - 1 || pattern[j + 1] === "/");
      if (j === i || !wholeSegment) {
        tokens.push({ accepts: notSlash, loop: true });
      } else if (j === pattern.length - 1) {
        tokens.push({ accepts: () => true, loop: true });
      } else {
        tokens.push({ accepts: () => true, loop: true, skipNext: true }, literal("/"));
        j++;
      }
      i = j;
    } else {
      tokens.push(literal(c));
    }
  }
  return tokens;
}

/**
 * Tests `path` against `tokens` by advancing the set of reachable token
 * positions one character at a time. Position `tokens.length` means the whole
 * pattern is consumed.
 */
function matchTokens(tokens: readonly Token[], path: string): boolean {
  const reach = (positions: Uint8Array, at: number): void => {
    if (positions[at]) return;
    positions[at] = 1;
    const token = tokens[at];
    if (token?.loop) reach(positions, at + 1);
    if (token?.skipNext) reach(positions, at + 2);
  };
  let current = new Uint8Array(tokens.length + 1);
  reach(current, 0);
  for (const char of path) {
    const next = new Uint8Array(tokens.length + 1);
    for (let at = 0; at < tokens.length; at++) {
      if (current[at] && tokens[at].accepts(char)) reach(next, tokens[at].loop ? at : at + 1);
    }
    current = next;
  }
  return current[tokens.length] === 1;
}

/**
 * Compiles one pattern. Surrounding whitespace and a leading `./` are dropped,
 * and a trailing `/` means everything below that directory.
 *
 * @throws When nothing is left of the pattern after normalization, or a class is invalid.
 */
export function compileGlob(raw: string): CompiledGlob {
  let pattern = raw.trim();
  const negated = pattern.startsWith("!");
  if (negated) pattern = pattern.slice(1);
  if (pattern.startsWith("./")) pattern = pattern.slice(2);
  if (pattern.endsWith("/")) pattern += "**";
  if (pattern === "") throw new Error(`Empty glob pattern: "${raw}"`);
  const alternatives = expandBraces(pattern).map(tokenize);
  return { negated, matches: (path) => alternatives.some((tokens) => matchTokens(tokens, path)) };
}

/**
 * Builds a predicate over paths. A path matches when it hits any positive
 * pattern (or there are none) and no `!` pattern or ignore pattern.
 *
 * Exclusions are collected separately and applied last, so the order of
 * patterns never changes the result.
 *
 * @param patterns Globs from `files` or one `files_yaml` group; `!` excludes.
 * @param ignore Globs from `files_ignore`. Always exclusions.
 * @throws On an empty pattern, or a `!` pattern in `ignore`, which would be a double negative.
 */
export function createMatcher(
  patterns: readonly string[] = [],
  ignore: readonly string[] = [],
): Matcher {
  const include: Matcher[] = [];
  const exclude: Matcher[] = [];
  for (const pattern of patterns) {
    const { negated, matches } = compileGlob(pattern);
    (negated ? exclude : include).push(matches);
  }
  for (const pattern of ignore) {
    const { negated, matches } = compileGlob(pattern);
    if (negated) throw new Error(`Negation is not supported in files_ignore: "${pattern}"`);
    exclude.push(matches);
  }
  return (path) =>
    (include.length === 0 || include.some((matches) => matches(path))) &&
    !exclude.some((matches) => matches(path));
}
