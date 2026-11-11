# How-to guides

Each guide assumes the [quick start](../README.md#quick-start) works. Input and output details are in the [reference](reference.md).

- [Build a matrix from changed directories](#build-a-matrix-from-changed-directories)
- [Detect several areas in one step](#detect-several-areas-in-one-step)
- [Compare two specific commits](#compare-two-specific-commits)
- [Limit a pull request to its latest push](#limit-a-pull-request-to-its-latest-push)
- [Fix "is not available in this checkout"](#fix-is-not-available-in-this-checkout)
- [Use file lists safely in shell steps](#use-file-lists-safely-in-shell-steps)

## Build a matrix from changed directories

`matrix: true` outputs unescaped JSON that `fromJSON` accepts. `dir_names_max_depth: 2` turns `packages/core/src/index.ts` into `packages/core`.

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

Keep the `if:` on the `test` job: an empty matrix fails the workflow.

## Detect several areas in one step

Each `files_yaml` group sets its own `<group>_<output>` outputs. `files_ignore` applies to every group.

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

Patterns starting with `!` or `*` have to be quoted, as in any YAML file. The [format reference](reference.md#files_yaml-format) lists what else the parser rejects.

## Compare two specific commits

```yaml
- uses: actions/checkout@v6
  with:
    fetch-depth: 0
- uses: lowlysre/what-changed@<commit-sha>
  with:
    base_sha: ${{ inputs.base }}
    sha: ${{ inputs.head }}
```

Both commits have to exist in the checkout, which is why this uses full history. On a pull request event the diff starts at the merge base of the two commits. On any other event the two commits are compared directly.

## Limit a pull request to its latest push

By default a pull request reports everything it changes. To report only what the most recent push added, check out full history and set `since_last_remote_commit`.

```yaml
- uses: actions/checkout@v6
  with:
    fetch-depth: 0
- uses: lowlysre/what-changed@<commit-sha>
  with:
    since_last_remote_commit: true
```

After a force push the commit that was pushed before is gone from the repository. The action then falls back to the default comparison.

## Fix "is not available in this checkout"

The action never fetches. When a commit it needs is missing, it fails and tells you to raise `fetch-depth` on the checkout step.

| Situation | `fetch-depth` |
|-----------|---------------|
| Push events | `2` |
| Pull requests with the default checkout (the merge commit) | `2` |
| Pull requests with `ref:` set to the head branch | `0` (all history) |
| Merge groups, `base_sha`, `since_last_remote_commit` | `0` (all history) |

## Use file lists safely in shell steps

A file name is attacker-controlled input on a pull request. Pass outputs through `env:` and never write `${{ }}` inside a script. Use JSON when names can contain spaces, since the default output is space-separated.

```yaml
- uses: lowlysre/what-changed@<commit-sha>
  id: changed
  with:
    json: true
    escape_json: false
- env:
    FILES: ${{ steps.changed.outputs.all_changed_files }}
  run: jq --raw-output0 '.[]' <<<"$FILES" | xargs -0 -r npx prettier --check --
```

`--raw-output0` and `xargs -0` split on NUL, the one byte a path can't contain; a newline is a valid character in a git file name. The trailing `--` stops a file named like `--plugin=./payload.js` from being read as an option.

`safe_output` (on by default) backslash-escapes shell metacharacters in the non-JSON lists. It reduces the damage of an inline `${{ }}`, but it doesn't make one safe.
