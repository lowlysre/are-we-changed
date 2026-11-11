# Security

What the action can reach, how it handles untrusted input, and what stays your job.

- [What the action can reach](#what-the-action-can-reach)
- [Untrusted input](#untrusted-input)
- [What stays your job](#what-stays-your-job)
- [Supply chain](#supply-chain)
- [Reporting a vulnerability](#reporting-a-vulnerability)

## What the action can reach

| | |
|---|---|
| Reads | The git repository in the working directory, the event payload file, and its own inputs |
| Writes | The step's outputs and its log |
| Runs | `git`, without a shell, for five read-only commands: `rev-parse`, `rev-list`, `merge-base`, `hash-object`, `diff`. The executable is taken from an absolute `PATH` entry, never from the checkout |
| Network | None. There is no fetch, no API call, and no token input. Git's own on-demand fetching in partial clones is switched off |

All of the git access is in `src/git.ts`, and the only writes are in `src/main.ts`.

The job needs `contents: read` for the checkout step and nothing for this action. It works with `persist-credentials: false` on the checkout, since it never talks to the remote.

It never executes a file from the checkout. `git diff` runs with `--no-ext-diff`, so a diff driver configured in the repository isn't invoked. On Windows a bare `git` would be looked up in the working directory first, where a pull request could place a `git.exe`, so the action resolves git from `PATH` itself.

## Untrusted input

On a pull request, file names are chosen by the author of the pull request. Git allows almost any byte in one, including newlines, quotes, and `$(...)`. The action treats them as hostile everywhere they land.

| Where a file name lands | Risk | What the action does |
|---|---|---|
| The step log | A name such as `##[error]x` or one with an embedded `::add-mask::` line runs as a workflow command | Echoes outputs between `::stop-commands::` and a resume token that is random per run |
| The outputs file | A name containing the delimiter ends the value early and sets other outputs | Uses a delimiter that is random per run |
| A list output | A name with spaces or shell metacharacters changes meaning downstream | `safe_output` backslash-escapes them in separated lists. JSON output is left exact for a parser |
| A glob pattern | A name built to nearly match a pattern such as `*.*.*.*` makes a backtracking matcher take minutes | Matches in time bounded by path length × pattern length |
| Any output | A name that isn't valid UTF-8 can't be written faithfully, and two such names can collapse into one | Fails the step and says to rename the file |
| An error message | A newline starts a second workflow command | Encodes the message as command data |

The other inputs come from the workflow, but a workflow can pass on something it didn't write, such as a `workflow_dispatch` input:

| Input | Risk | What the action does |
|---|---|---|
| `base_sha`, `sha` | A value such as `--output=file` is read as a git option | Resolves each with `--end-of-options` and requires it to name a commit |
| `files_yaml` | A group name becomes part of an output name | Allows letters, digits, `_` and `-` only, and fails when two names spell the same output |
| Booleans, `dir_names_max_depth` | A typo silently selects the default | Fails the step on anything but a valid value |

## What stays your job

- Pin the action to a full commit SHA. A tag can be moved to a different commit; a SHA can't.
- Pass outputs to scripts through `env:`, never as `${{ }}` inside `run:`. `safe_output` reduces the damage of an inline expression and doesn't make one safe. [The how-to guide](how-to.md#use-file-lists-safely-in-shell-steps) has a full example, including `--` and NUL separators for file names that start with a dash or contain a newline.
- Don't print outputs to the log yourself. The runner executes `##[command]` anywhere in a line, so `echo "$FILES"` lets a file or directory name forge an annotation, and `env:` doesn't prevent that. The action already logs every output with workflow commands stopped.
- Treat the list as a claim about names only. The action reports which paths changed, and says nothing about whether their content is safe to build or run.
- On `pull_request_target`, the usual warning applies: checking out and then running a pull request's code with the base repository's secrets is dangerous whatever this action reports.

## Supply chain

- No runtime dependencies. The action imports Node built-ins and nothing else, so there's no package tree to compromise.
- No bundle. `action.yml` runs `src/main.ts` as committed, so the reviewed source is the executed source.
- Development dependencies are TypeScript, Prettier, and Node's type definitions. The action never loads them.
- CI pins every third-party action to a commit SHA, starts from `permissions: {}`, and runs [zizmor](https://docs.zizmor.sh/) on the workflows and `action.yml`.
- Dependabot updates wait seven days after a release before proposing it.

[Design notes](explanation.md#why-this-action-exists) covers why the action is built this way.

## Reporting a vulnerability

Report it privately through the repository's Security tab ("Report a vulnerability"), not in a public issue. Include the workflow snippet and, if a file name is involved, the exact name.
