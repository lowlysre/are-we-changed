# Reference

- [Inputs](#inputs)
- [Outputs](#outputs)
- [Compared commits](#compared-commits)
- [Glob dialect](#glob-dialect)
- [`files_yaml` format](#files_yaml-format)

## Inputs

All inputs are optional. Booleans accept `true` or `false` in any case; anything else fails the step.

| Input | Default | Description |
|-------|---------|-------------|
| `files` | `""` | Globs to include, one per line. A leading `!` excludes. Empty matches every file. |
| `files_ignore` | `""` | Globs to exclude, one per line. Also applies to every `files_yaml` group. A leading `!` is an error. |
| `files_yaml` | `""` | Named pattern groups in the [YAML subset](#files_yaml-format), or JSON. |
| `dir_names` | `false` | Output unique directory names instead of file names. Root-level files become `.`. |
| `dir_names_max_depth` | `""` | Keep this many leading path segments of each directory name. Positive integer. |
| `json` | `false` | Output lists as JSON arrays. |
| `escape_json` | `true` | Escape JSON output as the content of a JSON string: quotes and backslashes. |
| `matrix` | `false` | Same as `json: true` with `escape_json: false`. |
| `separator` | `" "` | Separator for list outputs when `json` is off. |
| `safe_output` | `true` | Backslash-escape shell metacharacters in list outputs when `json` is off. |
| `base_sha` | `""` | Commit to compare from. See [Compared commits](#compared-commits). |
| `sha` | `""` | Commit to compare to. Defaults to `HEAD`. |
| `since_last_remote_commit` | `false` | On pull requests, compare from `github.event.before` when that commit is in the checkout. Push events always do. |
| `skip_same_sha` | `false` | Report no changes instead of failing when both commits are the same. |

`safe_output` escapes everything outside printable ASCII, plus these characters:

```text
: * ? " ' < > | ; ` $ ( ) & ! \
```

## Outputs

Every list has a matching `<name>_count`. With `dir_names`, lists and counts are of directories. Lists keep the order `git diff` reports, which is by path.

| Output | Value |
|--------|-------|
| `all_changed_files` | Added, modified, and renamed files. |
| `any_changed` | `true` when `all_changed_files` isn't empty. |
| `all_modified_files` | Added, modified, renamed, and deleted files. |
| `any_modified` | `true` when `all_modified_files` isn't empty. |
| `added_files` | Added files. |
| `modified_files` | Modified files, including type changes such as file to symlink. |
| `deleted_files` | Deleted files. |
| `any_deleted` | `true` when `deleted_files` isn't empty. |
| `renamed_files` | Renamed files, by their new path. The old path isn't reported. |
| `changed_keys` | `files_yaml` groups whose `all_changed_files` isn't empty. |
| `modified_keys` | `files_yaml` groups whose `all_modified_files` isn't empty. |

Each `files_yaml` group repeats the file outputs with its name as a prefix. A group named `src` sets `src_any_changed`, `src_all_changed_files`, `src_deleted_files_count`, and the rest.

The unprefixed outputs are always set. They reflect `files` and `files_ignore` only.

Two groups, or a group and an unprefixed output, can spell the same output name: a group named `all` would set `all_modified_files`. The step fails on any such collision and names the output.

## Compared commits

The head is `sha`, or `HEAD` when `sha` is empty. The base depends on the event:

| Event | Base commit |
|-------|-------------|
| `base_sha` is set | `base_sha`. On pull requests, its merge base with the head |
| Pull request, merge-commit checkout | First parent of the merge commit |
| Pull request, any other checkout | Merge base of the pull request's base and the head |
| Merge group | `merge_group.base_sha` |
| Push | `github.event.before`, the commit the branch pointed at before the push, so every pushed commit counts |
| New branch, force push, and everything else | Parent of the head. The empty tree for a root commit |

A push whose `github.event.before` isn't in the checkout fails, unless it's a new branch or a force push. Falling back to the parent would drop the earlier commits of that push.

On pull requests, `since_last_remote_commit` replaces the base with `github.event.before` when that commit is in the checkout. It also moves the head to the pull request's head commit, so base-branch changes pulled in by the merge commit stay out of the result.

Renames are detected with git's default similarity threshold. Submodule changes are ignored.

The action fails when:

- The working directory isn't a git repository
- A commit it needs isn't in the checkout (see [the fetch-depth table](how-to.md#fix-is-not-available-in-this-checkout))
- Base and head are the same commit and `skip_same_sha` is off

## Glob dialect

A pattern has to match the whole path. Paths use `/` on every platform. Matching is case-sensitive.

| Syntax | Matches |
|--------|---------|
| `*` | Any run of characters except `/`. Matches a leading dot. |
| `**` | As a whole path segment, any number of directories: `**/*.md`, `src/**`, `a/**/b`. Anywhere else it behaves like `*`. |
| `?` | One character except `/`. |
| `[abc]` | One of the listed characters or ranges (`[a-z]`). `[!abc]` and `[^abc]` negate. `\x` inside is the literal `x`, and `{`, `,` are plain members. Never matches `/`. |
| `{a,b}` | Either alternative. Nests. Braces without a comma are literal. |
| `\x` | The literal character `x`. |
| `!pattern` | Excludes paths matching `pattern`. Exclusions win over inclusions whatever the order. |
| `dir/` | Same as `dir/**`. |

A leading `./` is dropped. A list holding only `!` patterns matches everything else.

Not supported: extglobs such as `+(a|b)`, numeric ranges such as `{1..3}`, POSIX classes such as `[[:alpha:]]`.

Some cases that surprise people:

| Pattern | Path | Match |
|---------|------|-------|
| `*.md` | `docs/README.md` | no, `*` stops at `/` |
| `**/*.md` | `README.md` | yes, `**/` can match zero directories |
| `packages/**` | `packages` | no, something has to follow the `/` |
| `*` | `.gitignore` | yes |
| `{a}.txt` | `a.txt` | no, the braces are literal |

## `files_yaml` format

```yaml
group_name:            # letters, digits, `_` and `-`, starting at column 0
  - plain/pattern/**   # trailing comment
  - '!quoted/**'
  - "also quoted"
```

The parser accepts that shape and nothing else. Each of these fails with an error naming the line:

- Anchors, aliases, and tags, which is what an unquoted leading `&`, `*`, or `!` means in YAML
- Unquoted values YAML reads as something other than a string: `true`, `null`, `123`, `2024-01-31`
- List items in one group at different indentation
- Flow style: `[a, b]`, `{a: b}`
- Block scalars: `|`, `>`
- Nested maps and `key: value` pairs
- Escape sequences inside double quotes, and `''` inside single quotes
- Tabs
- Duplicate groups, and groups with no patterns

Input starting with `{` is parsed as JSON instead:

```yaml
files_yaml: '{"src": ["src/**", "!src/**/*.md"], "pom": "pom.xml"}'
```
