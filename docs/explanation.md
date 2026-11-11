# Design notes

- [Why this action exists](#why-this-action-exists)
- [Why it never fetches](#why-it-never-fetches)
- [Why the YAML parser is strict](#why-the-yaml-parser-is-strict)
- [Why TypeScript without a build](#why-typescript-without-a-build)

## Why this action exists

In March 2025 [tj-actions/changed-files](https://github.com/tj-actions/changed-files) was compromised ([CVE-2025-30066](https://github.com/advisories/GHSA-mrrh-fwg8-r2c3)). The advisory describes it: "Attackers retroactively modified multiple version tags to reference a malicious commit, exposing CI/CD secrets in workflow logs."

Two properties of the action made that worse than it had to be. Most users referenced a version tag, and a tag can be repointed. The action also ships as a bundled `dist/` built from a tree of third-party packages, so reading the repository doesn't tell you what runs.

are-we-changed is built so that neither applies. It has no runtime dependencies, so there's no package tree to audit. It has no bundle, so the code in `src/` is the whole program. The README tells you to pin a commit SHA, which can't be moved.

The cost is surface area. It supports 14 of upstream's 61 inputs, picked from how about 20 real workflows use the action. If a workflow needs one of the other 47, [the migration guide](migration.md) says so up front.

## Why it never fetches

Upstream deepens a shallow clone until it finds the commits it needs. That's convenient, and it's also where much of its complexity sits: credentials, retries, and a result that depends on what the remote looks like at that moment.

This action reads only what the checkout step left on disk. When a commit is missing it fails with the `fetch-depth` to set. I think a clear failure is better here than quietly comparing against a different commit, since a wrong file list usually shows up later as a skipped test job nobody notices.

The default pull request checkout is the case that had to stay cheap. GitHub checks out a merge commit whose first parent is the base branch, so `fetch-depth: 2` is enough to diff against it and get what the pull request brings to the base branch.

## Why the YAML parser is strict

A complete YAML parser is thousands of lines, which is most of a dependency. Pattern groups need one shape: a top-level key holding a list of strings.

The parser accepts that shape only. Everything it accepts means the same thing to a real YAML parser, so moving a `files_yaml` block from this action to upstream can't change its meaning. Anything else is an error naming the line.

The visible consequence is quoting. `- !docs/**` is a tag in YAML and `- **/*.md` is an alias, so both have to be quoted here, as they would for any YAML parser that reads them.

## Why TypeScript without a build

Node 24, the runtime the action declares, runs TypeScript directly by [stripping the type annotations](https://nodejs.org/api/typescript.html#type-stripping). `action.yml` points at `src/main.ts`, and the code is limited to syntax that can be erased (`erasableSyntaxOnly` in `tsconfig.json`), so what runs is the source with the types blanked out.

That keeps type checking without bringing back a compiled artifact. TypeScript, Prettier, and Node's type definitions are development dependencies; the action never loads them.
