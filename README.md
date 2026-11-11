# what-changed <!-- omit in toc -->

[![CI](https://github.com/lowlysre/what-changed/actions/workflows/ci.yml/badge.svg)](https://github.com/lowlysre/what-changed/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Reports the files changed by a push, pull request or merge group, filtered by glob patterns.
A small, reviewable alternative to `tj-actions/changed-files`.

* 🔒 zero runtime dependencies: Node built-ins and `git` only
* 👀 no bundle and no build step: the TypeScript in `src/` is what runs
* 🚫 no token, no API calls, no network access

## Table of Contents <!-- omit in toc -->

- [Tutorial](#tutorial)
- [How-to Guides](#how-to-guides)
- [Reference](#reference)
- [Explanation](#explanation)

## Tutorial

This quick start runs a job only when files under `src/` change.

1. Check out with `fetch-depth: 2` so the previous commit is available.
2. Add `what-changed` with a `files` pattern.
3. Gate later steps on the `any_changed` output.

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 2

      - uses: lowlysre/what-changed@<commit-sha>
        id: changed
        with:
          files: src/**

      - if: steps.changed.outputs.any_changed == 'true'
        run: npm test
```

Expected result:
- `any_changed` is `'true'` when the push or pull request touches `src/`, otherwise `'false'`.
- `all_changed_files` holds the matching paths, separated by spaces.

## How-to Guides

### Build a matrix from changed directories

`matrix: true` outputs unescaped JSON for `fromJSON`. `dir_names_max_depth: 2` turns
`packages/core/src/index.ts` into `packages/core`.

```yaml
jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      packages: ${{ steps.changed.outputs.all_changed_files }}
      any: ${{ steps.changed.outputs.any_changed }}
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 2
      - uses: lowlysre/what-changed@<commit-sha>
        id: changed
        with:
          files: packages/**
          files_ignore: packages/**/*.md
          dir_names: true
          dir_names_max_depth: 2
          matrix: true

  test:
    needs: changes
    if: needs.changes.outputs.any == 'true'
    strategy:
      matrix:
        package: ${{ fromJSON(needs.changes.outputs.packages) }}
    runs-on: ubuntu-latest
    steps:
      - env:
          PACKAGE: ${{ matrix.package }}
        run: echo "testing $PACKAGE"
```

### Detect several areas in one step

Each `files_yaml` group sets its own `<group>_<output>` outputs.

```yaml
- uses: lowlysre/what-changed@<commit-sha>
  id: changed
  with:
    files_yaml: |
      src:
        - src/main/**
        - '!src/main/**/*.md'
      pom:
        - pom.xml
    files_ignore: "**/generated/**"

- if: steps.changed.outputs.src_any_changed == 'true'
  run: mvn test
- if: contains(steps.changed.outputs.changed_keys, 'pom')
  run: mvn dependency:tree
```

Patterns starting with `!` or `*` must be quoted, as in any YAML file.

### Compare two specific commits

```yaml
- uses: actions/checkout@v6
  with:
    fetch-depth: 0
- uses: lowlysre/what-changed@<commit-sha>
  with:
    base_sha: ${{ inputs.base }}
    sha: ${{ inputs.head }}
```

### Limit a pull request to its latest push

By default a pull request reports everything it changes. To report only the commits added by the
most recent push, check out full history and set `since_last_remote_commit`.

```yaml
- uses: actions/checkout@v6
  with:
    fetch-depth: 0
- uses: lowlysre/what-changed@<commit-sha>
  with:
    since_last_remote_commit: true
```

After a force push the previous commit no longer exists, and the action falls back to the default
comparison.

### Fix "is not available in this checkout"

The action never fetches. Give it the history it needs:

| Situation                                           | `fetch-depth` |
|-----------------------------------------------------|---------------|
| Push events                                         | `2`           |
| Pull requests, default checkout (the merge commit)  | `2`           |
| Pull requests with `ref:` set to the head branch    | `0`           |
| Merge groups, `base_sha`, `since_last_remote_commit`| `0`           |

### Use file lists safely in shell steps

Pass outputs through `env`, never inline `${{ }}` in a script. Prefer JSON when file names may
contain spaces.

```yaml
- uses: lowlysre/what-changed@<commit-sha>
  id: changed
  with:
    json: true
    escape_json: false
- env:
    FILES: ${{ steps.changed.outputs.all_changed_files }}
  run: jq -r '.[]' <<<"$FILES" | xargs -d '\n' -r npx prettier --check
```

## Reference

### Inputs

| Input                      | Default | Description |
|----------------------------|---------|-------------|
| files                      | ""      | Newline-separated globs to include. A leading `!` excludes. Empty matches every file. |
| files_ignore               | ""      | Newline-separated globs to exclude. Also applies to every `files_yaml` group. |
| files_yaml                 | ""      | Named pattern groups in the [YAML subset](#files_yaml-format), or JSON. |
| dir_names                  | "false" | Output unique directory names instead of file names. Root-level files become `.`. |
| dir_names_max_depth        | ""      | Keep only this many leading path segments of each directory name. |
| json                       | "false" | Output lists as JSON arrays. |
| escape_json                | "true"  | Escape double quotes in JSON output. |
| matrix                     | "false" | Shorthand for `json: true` plus `escape_json: false`. |
| separator                  | " "     | Separator for list outputs when `json` is false. |
| safe_output                | "true"  | Backslash-escape shell metacharacters in non-JSON list outputs. |
| base_sha                   | ""      | Commit to compare from. See [Compared commits](#compared-commits). |
| sha                        | ""      | Commit to compare to. Defaults to `HEAD`. |
| since_last_remote_commit   | "false" | Compare from `github.event.before` when that commit is available. |
| skip_same_sha              | "false" | Report no changes instead of failing when both commits are the same. |

### Outputs

Every list output has a matching `<name>_count`. With `dir_names`, lists and counts are of directories.

| Output              | Value |
|---------------------|-------|
| all_changed_files   | Added, modified and renamed files. |
| any_changed         | "true" when `all_changed_files` is not empty. |
| all_modified_files  | Added, modified, renamed and deleted files. |
| any_modified        | "true" when `all_modified_files` is not empty. |
| added_files         | Added files. |
| modified_files      | Modified files, including type changes. |
| deleted_files       | Deleted files. |
| any_deleted         | "true" when `deleted_files` is not empty. |
| renamed_files       | Renamed files, by their new path. |
| changed_keys        | `files_yaml` groups with a non-empty `all_changed_files`. |
| modified_keys       | `files_yaml` groups with a non-empty `all_modified_files`. |

Each `files_yaml` group repeats the file outputs with a prefix: group `src` sets `src_any_changed`,
`src_all_changed_files`, `src_deleted_files_count`, and so on. The unprefixed outputs are always set
and reflect `files` and `files_ignore` only.

### Compared commits

| Event                                   | Base commit                                    |
|-----------------------------------------|------------------------------------------------|
| `base_sha` set                          | `base_sha`; on pull requests, its merge base with head |
| Pull request, merge-commit checkout     | First parent of the merge commit               |
| Pull request, any other checkout        | Merge base of the pull request base and head   |
| Merge group                             | `merge_group.base_sha`                         |
| Push and everything else                | Parent of head; the empty tree for a root commit |

`since_last_remote_commit` replaces the base with `github.event.before` when that commit exists
locally. The head is `sha`, or `HEAD`.

### Glob dialect

Patterns match the whole path, which always uses `/`. Matching is case-sensitive.

| Syntax    | Matches |
|-----------|---------|
| `*`       | Any characters except `/`, including a leading dot. |
| `**`      | As a whole segment, any number of directories: `**/*.md`, `src/**`, `a/**/b`. Elsewhere, same as `*`. |
| `?`       | One character except `/`. |
| `[abc]`   | One listed character or range (`[a-z]`); `[!abc]` or `[^abc]` negates. Never matches `/`. |
| `{a,b}`   | Either alternative; may nest. Braces without a comma are literal. |
| `\x`      | The literal character `x`. |
| `!pattern`| Excludes paths matching `pattern`. Exclusions always win, whatever the order. |
| `dir/`    | Same as `dir/**`. |

A list with only `!` patterns matches everything else. Not supported: extglobs such as `+(a|b)`,
numeric ranges such as `{1..3}`, and POSIX classes such as `[[:alpha:]]`.

### `files_yaml` format

```yaml
group_name:            # letters, digits, `_` and `-`, at column 0
  - plain/pattern/**   # comment
  - '!quoted/**'
  - "also quoted"
```

Rejected with an error naming the line: anchors, aliases, tags, flow style (`[a, b]`), block scalars
(`|`, `>`), nested maps, `key: value` pairs, escape sequences inside quotes, tabs, duplicate or empty
groups. Plain values starting with a YAML indicator such as `!` or `*` must be quoted.

Input starting with `{` is parsed as JSON: `{"src": ["src/**", "!src/**/*.md"]}`.

### Not supported

Inputs from `tj-actions/changed-files` that are deliberately absent:

| Area                | Inputs |
|---------------------|--------|
| REST API            | `token`, `api_url`, `use_rest_api` |
| Fetching            | `fetch_depth`, `fetch_additional_submodule_history`, `skip_initial_fetch`, `fetch_missing_history_max_retries` |
| Pattern sources     | `files_from_source_file`, `files_ignore_from_source_file`, `files_yaml_from_source_file`, `files_ignore_yaml*` |
| Separators          | `files_separator`, `files_ignore_separator`, `old_new_separator`, `old_new_files_separator`, `dir_names_*_separator` |
| Deleted and renamed | `recover_deleted_files*`, `include_all_old_new_renamed_files`, `dir_names_exclude_current_dir`, `dir_names_deleted_files_include_only_deleted_dirs` |
| History selection   | `since`, `until`, `tags_pattern`, `tags_ignore_pattern` |
| Paths and output    | `path`, `diff_relative`, `quotepath`, `use_posix_path_separator`, `exclude_symlinks`, `negation_patterns_first`, `write_output_files`, `output_dir`, `output_renamed_files_as_deleted_files` |

Outputs that are absent: the `other_*` and `only_*` families, `copied_files`, `type_changed_files`,
`unmerged_files`, `unknown_files`, `all_changed_and_modified_files`, `all_old_new_renamed_files`.

Replace `files_ignore_yaml` with `!` patterns inside the group.

## Explanation

### Why this action exists

`tj-actions/changed-files` was compromised in March 2025 ([CVE-2025-30066](https://nvd.nist.gov/vuln/detail/CVE-2025-30066)):
its version tags were repointed to a malicious commit that dumped runner secrets into build logs. The
action ships a large minified bundle of third-party packages, so a change like that is not something
a reviewer can spot.

what-changed takes the opposite approach. It covers the inputs real workflows use, in roughly 600 lines
with no runtime dependencies, and what you review is exactly what executes: Node 24 runs the
TypeScript in `src/` directly by stripping the type annotations. TypeScript, Prettier and Node's type
definitions are development-only and are never loaded by the action.

Pin the action to a full commit SHA. A SHA cannot be moved; a tag can.

### Why it never fetches

Fetching needs credentials, a network path and retry logic, and it makes results depend on the state
of the remote at that moment. This action reads only what `actions/checkout` left on disk. When a
commit it needs is missing, it fails and names the `fetch-depth` to set, rather than guessing a
different comparison.

### Why the YAML parser is so strict

A complete YAML parser is thousands of lines. The subset here is the part pattern lists need, and
every document it accepts means the same thing to a real YAML parser. Anything outside the subset is
an error, so a pattern is never silently misread.

### Differences in behaviour from `tj-actions/changed-files`

* Pattern order is irrelevant: `!` exclusions always apply after inclusions.
* Unprefixed outputs are always set, including when only `files_yaml` is given.
* `safe_output` also escapes `'` and `\`.
* A pull request checked out at its head branch needs `fetch-depth: 0`; history is not deepened on demand.
* Globs are a documented subset rather than the full micromatch syntax.
