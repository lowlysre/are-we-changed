# Migrating from tj-actions/changed-files

The [README](../README.md#can-i-migrate-cleanly-from-tj-actionschanged-files) has the quick check. This page is the full comparison, against upstream v47.0.6.

- [Steps](#steps)
- [Behaviour that differs](#behaviour-that-differs)
- [Inputs without an equivalent](#inputs-without-an-equivalent)
- [Outputs without an equivalent](#outputs-without-an-equivalent)

## Steps

1. Run the grep from the README against `.github/workflows` and resolve each hit.
2. Set `fetch-depth` on the checkout step per [the fetch-depth table](how-to.md#fix-is-not-available-in-this-checkout). Upstream deepens a shallow clone on its own; this action doesn't.
3. Quote every `files_yaml` pattern that starts with `!` or `*`.
4. Replace the `uses:` line.
5. Read the differences below for anything your workflow depends on.

## Behaviour that differs

These apply even when every input you set is supported.

| Topic | tj-actions/changed-files | what-changed |
|-------|--------------------------|--------------|
| Missing history | Fetches more, up to `fetch_missing_history_max_retries` times | Fails and names the `fetch-depth` to set |
| Pull request checked out at its head branch | Works on a shallow clone | Needs `fetch-depth: 0` to find the merge base |
| `files_yaml` syntax | Full YAML | A [strict subset](reference.md#files_yaml-format). Unquoted `!` and `*` patterns are errors |
| Pattern order | Matters, see `negation_patterns_first` | Doesn't matter. Exclusions always win |
| Glob syntax | micromatch | The [documented dialect](reference.md#glob-dialect). No POSIX classes or numeric brace ranges |
| Unprefixed outputs with only `files_yaml` set | Not set | Set, and matching every file |
| `safe_output` character set | Non-ASCII and ``: * ? < > \| ; ` $ ( ) & !`` | The same, plus `"`, `'`, and `\` |
| `safe_output` with `json` | Escapes inside the JSON text, which can make it invalid | Leaves JSON output alone |
| Copies, type changes, unmerged files | Separate outputs | Type changes count as modified. Copies aren't detected |
| Working directory | `path` input | Always the step's working directory |

## Inputs without an equivalent

47 of upstream's 61 inputs. GitHub ignores an undeclared input with a warning, so none of these fail the step if left in.

| Area | Inputs | Instead |
|------|--------|---------|
| REST API | `token`, `api_url`, `use_rest_api` | Add a checkout step. The action reads the local repository only |
| Fetching | `fetch_depth`, `skip_initial_fetch`, `fetch_additional_submodule_history`, `fetch_missing_history_max_retries`, `fail_on_initial_diff_error`, `fail_on_submodule_diff_error` | Set `fetch-depth` on the checkout step |
| Pattern files | `files_from_source_file`, `files_ignore_from_source_file`, `files_yaml_from_source_file`, `files_ignore_yaml_from_source_file`, and their `_separator` inputs | Inline the patterns |
| Ignore groups | `files_ignore_yaml` | Quoted `'!pattern'` entries inside the `files_yaml` group |
| Separators | `files_separator`, `files_ignore_separator`, `old_new_separator`, `old_new_files_separator`, `dir_names_include_files_separator`, `recover_files_separator`, `recover_files_ignore_separator` | One pattern per line. `separator` for outputs is supported |
| Pattern order | `negation_patterns_first` | Not needed |
| Directory names | `dir_names_exclude_current_dir`, `dir_names_include_files`, `dir_names_deleted_files_include_only_deleted_dirs` | None |
| Renames | `include_all_old_new_renamed_files`, `output_renamed_files_as_deleted_and_added` | None |
| Deleted files | `recover_deleted_files`, `recover_deleted_files_to_destination`, `recover_files`, `recover_files_ignore` | `git show <base>:<path>` in a following step |
| History selection | `since`, `until`, `tags_pattern`, `tags_ignore_pattern` | Resolve the commit yourself and pass it as `base_sha` |
| Paths | `path`, `diff_relative`, `quotepath`, `use_posix_path_separator` | None. Paths are relative to the repository root, `/`-separated, unquoted |
| Filtering | `exclude_submodules`, `exclude_symlinks` | None. Submodule changes are always ignored |
| Output files | `write_output_files`, `output_dir` | Write the output to a file in a following step |

## Outputs without an equivalent

| Outputs | Instead |
|---------|---------|
| `any_added` | `added_files_count != '0'` |
| `only_changed`, `only_modified`, `only_deleted` | None |
| `other_changed_files`, `other_modified_files`, `other_deleted_files`, and their counts | None |
| `copied_files`, `type_changed_files`, `unmerged_files`, `unknown_files`, and their counts | Type changes are in `modified_files` |
| `all_changed_and_modified_files` and its count | `all_modified_files` |
| `all_old_new_renamed_files` and its count | None. `renamed_files` has the new paths only |
