/**
 * what-changed: glob matching
 *
 * Dialect: `*`, `**`, `?`, `[...]`, `{a,b}`, `\` escapes and a leading `!`.
 * Paths are always `/`-separated and matching is case-sensitive.
 *
 * Each glob compiles to one anchored regex. The dialect is hand-rolled so the
 * action has no dependency and behaves the same on every Node version;
 * `test/glob.test.ts` holds the table that defines it.
 */

/** One compiled pattern. */
export interface CompiledGlob {
  /** True when the pattern had a leading `!`, which `regex` does not include. */
  readonly negated: boolean;
  /** Matches a whole path, never a substring. */
  readonly regex: RegExp;
}

/** Decides whether a repository-relative, `/`-separated path is selected. */
export type Matcher = (path: string) => boolean;

/** Escapes `text` for literal use in regex source. */
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Expands `{a,b}` alternatives bash-style, recursing for nested and repeated groups.
 * Braces without a top-level comma stay literal, and `\{` never opens a group.
 *
 * @returns Every brace-free pattern the input stands for, at least one.
 */
export function expandBraces(pattern: string): string[] {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      i++;
      continue;
    }
    if (pattern[i] !== "{") continue;
    const parts: string[] = [];
    let depth = 0;
    let from = i + 1;
    for (let j = from; j < pattern.length; j++) {
      const c = pattern[j];
      if (c === "\\") {
        j++;
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
 * Translates one brace-free glob into unanchored regex source.
 *
 * - `**` spans directories only as a whole path segment; elsewhere it is `*`.
 * - A class never matches `/`, so `a[!b]c` cannot cross a directory boundary.
 * - The closing `]` is searched from the second member on, which lets `]` be
 *   the first member as in `[]a]`. An unclosed `[` is a literal.
 */
function translate(pattern: string): string {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      re += escapeRegex(pattern[++i]);
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const negated = pattern[i + 1] === "!" || pattern[i + 1] === "^";
      const start = i + (negated ? 2 : 1);
      const end = pattern.indexOf("]", start + 1);
      if (end === -1) {
        re += "\\[";
        continue;
      }
      const body = pattern.slice(start, end).replace(/[\\[\]^]/g, "\\$&");
      re += `(?!/)[${negated ? "^" : ""}${body}]`;
      i = end;
    } else if (c === "*") {
      let j = i;
      while (pattern[j + 1] === "*") j++;
      const wholeSegment =
        (i === 0 || pattern[i - 1] === "/") && (j === pattern.length - 1 || pattern[j + 1] === "/");
      if (j === i || !wholeSegment) {
        re += "[^/]*";
      } else if (j === pattern.length - 1) {
        re += ".*";
      } else {
        re += "(?:.*/)?";
        j++;
      }
      i = j;
    } else {
      re += escapeRegex(c);
    }
  }
  return re;
}

/**
 * Compiles one pattern. Surrounding whitespace and a leading `./` are dropped,
 * and a trailing `/` means everything below that directory.
 *
 * The regex uses the `s` flag because git allows newlines in file names and
 * `**` has to span them.
 *
 * @throws When nothing is left of the pattern after normalization.
 */
export function compileGlob(raw: string): CompiledGlob {
  let pattern = raw.trim();
  const negated = pattern.startsWith("!");
  if (negated) pattern = pattern.slice(1);
  if (pattern.startsWith("./")) pattern = pattern.slice(2);
  if (pattern.endsWith("/")) pattern += "**";
  if (pattern === "") throw new Error(`Empty glob pattern: "${raw}"`);
  const regex = new RegExp(`^(?:${expandBraces(pattern).map(translate).join("|")})$`, "s");
  return { negated, regex };
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
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  for (const pattern of patterns) {
    const { negated, regex } = compileGlob(pattern);
    (negated ? exclude : include).push(regex);
  }
  for (const pattern of ignore) {
    const { negated, regex } = compileGlob(pattern);
    if (negated) throw new Error(`Negation is not supported in files_ignore: "${pattern}"`);
    exclude.push(regex);
  }
  return (path) =>
    (include.length === 0 || include.some((re) => re.test(path))) &&
    !exclude.some((re) => re.test(path));
}
