# Issue tracker: GitHub

English | [中文](issue-tracker.zh.md)

Issues and specs for this workspace live in the GitHub repository `LeonDing1005/skillhub-dsh`.

Use the `gh` CLI for all operations and always pass `--repo LeonDing1005/skillhub-dsh`; do not infer the repository from this workspace's `origin`.

## Prerequisites

- Install `gh`.
- Authenticate with `gh auth login`.
- Ensure the account can create and label issues in the target repository.

## Conventions

- Create: `gh issue create --repo LeonDing1005/skillhub-dsh ...`
- Read: `gh issue view --repo LeonDing1005/skillhub-dsh <number> --comments`
- List: `gh issue list --repo LeonDing1005/skillhub-dsh ...`
- Comment, label, edit, and close with the corresponding `gh issue` command and the same explicit `--repo`.
- When a skill says "publish to the issue tracker", create a GitHub issue.
- When a skill says "fetch the relevant ticket", read that GitHub issue and its comments and labels.

## Pull requests as a triage surface

PRs as a request surface: no.
