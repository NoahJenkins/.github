# NoahJenkins/.github

Shared GitHub automation for personal repositories.

| Component | Use | Pin |
| --- | --- | --- |
| [`review-gate`](#review-gate) | Risk-tiered review status for agent pull requests | `NoahJenkins/.github@<sha> # vX.Y.Z` |
| [`pr-repair`](pr-repair/README.md) | Bounded repair, independent review, and native merge for dependency updates | `NoahJenkins/.github/pr-repair@<sha> # vX.Y.Z` |

## Versions and pins

Every merge to `main` that changes action code is released automatically as a
plain `vX.Y.Z` tag ([`release.yml`](.github/workflows/release.yml), after `test`
passes). The bump is a patch by default; label the pull request `semver:minor`
or `semver:major` to bump that part instead. Docs, tests and workflow-only
changes do not release. Dependabot pin bumps here merge themselves (minor and
patch in every ecosystem, and github-actions semver-majors too; any other major
is labelled `dependency-major`), and because merges by
auto-merge start no push workflows, a weekly sweep (Tuesdays) tests `main` and
releases them.

Pin callers as `@<full sha> # vX.Y.Z`. Add the `github-actions` ecosystem to the
caller's `dependabot.yml`, and Dependabot bumps the SHA and the comment
together, so nobody re-pins by hand:

```yaml
- package-ecosystem: github-actions
  directory: /
  schedule: { interval: weekly }
  groups:
    shared-automation: { patterns: ["NoahJenkins/*"] }
  cooldown:
    default-days: 7
    exclude: ["NoahJenkins/*"]
```

A single repo-wide version stream means a pr-repair-only release also produces
a (harmless) bump for review-gate callers.

## review-gate

A composite action that posts the required `review-gate` commit status, so
GitHub native auto-merge can merge agent pull requests without a person.

```text
PR push ──▶ classify (policy from the base branch)
             ├─ skip    docs/assets, or ≤ small_change_lines of code ──▶ success
             ├─ review  larger code change
             └─ always  risky paths (workflows, agent rules, policy, repo extras)
                   │
                   ▼
             @codex review ──▶ result on the head SHA ──▶ success / failure
                   │ no 👀 in 5 min: ask once more
                   │ error reply, no answer, or no result in 20 min
                   ▼
             backup review: pinned Claude Code CLI, --restricted, read-only
             tools, via Vercel AI Gateway (default anthropic/claude-sonnet-5.5)
                   │ fails twice ──▶ failure "Review unavailable" + needs-human
                   ▼
             success / failure with inline findings
```

Rules that keep it safe and stall-free:

- The caller uses `pull_request_target`, so the workflow and policy come from the
  default branch. A pull request cannot change its own tier or reviewer.
- Pull request code is never executed. The backup reviewer only reads a shallow
  checkout with `.claude/`, `CLAUDE.md`, and `.mcp.json` removed, and its process
  gets no GitHub token.
- Labels can only add a review (`needs-review`); nothing can skip one.
- Every path ends in a final status. Errors set `failure: Review unavailable…`,
  and a 34-minute internal deadline sits inside the job's 40-minute timeout.
  Codex gets 20 minutes (polled every minute, reading only comments since the
  request), and the backup review gets whatever is left of the deadline and is
  retried only when 8 minutes remain.
- The `sweep` mode (scheduled in the caller) retries a missing, stalled, or
  unavailable gate twice, then labels `needs-human` and mentions the owner. It
  also escalates merge conflicts on pull requests with auto-merge enabled.
- After `max_rounds` (default 3) commits in a row with blocking findings, the
  gate escalates instead of looping.
- Dependabot runs get no Actions secrets, so Dependabot pull requests are
  decided from their own text: patch/minor semver updates pass (including
  container digest-only bumps on Docker branches and PEP 440 `.postN`/`.devN`
  bumps). A major needs a maintainer, except on a `dependabot/github_actions/*`
  branch whose every changed line is an in-place
  `uses: owner/repo@<40-hex sha> # vX.Y.Z` pin bump (same line apart from the
  SHA and the version comment, so no pin is unreadable). Those Actions majors
  pass when `allow_actions_major` is true, which is the default. Set it to
  false to hold them. Unreadable pins, any other `.github/` change, a major in
  any other ecosystem, and the force-review label still need a maintainer. The trust
  trade-off: the new SHA is not verified to belong to the tag in the comment, so
  a compromised upstream release would merge once required CI is green. Pin
  bumps are the point of Dependabot, and its `cooldown` is the mitigation.

### Use it

1. Allow the action in the repository (Settings → Actions → allowed actions):
   `NoahJenkins/.github@*` (a pattern, so Dependabot bumps are not blocked;
   keep "Require actions to be pinned to a full-length commit SHA" on).
2. Add secrets:
   - `AI_GATEWAY_API_KEY`: Vercel AI Gateway key for the backup review.
   - `CODEX_TRIGGER_TOKEN` (optional): fine-grained token of a Codex-linked user,
     with Pull requests and Issues write on the repository. Codex may ignore
     `@codex review` comments posted by `github-actions`. Add each new
     repository to the token's repository access. Until you do, the token gets
     HTTP 403 and the gate uses the backup review.
3. Copy [`examples/review-gate.yml`](examples/review-gate.yml) to
   `.github/workflows/review-gate.yml` and pin `@<sha> # vX.Y.Z`.
4. Optional: add `.github/review-policy.json`:

   ```json
   {
     "extra_always_review_paths": ["config/tailscale/**"],
     "small_change_lines": 15,
     "max_rounds": 3
   }
   ```

   Keys: `skip_paths`, `always_review_paths` (replace defaults),
   `extra_always_review_paths` (add), `small_change_lines`,
   `force_review_label`, `max_rounds`, `allow_actions_major` (default `true`;
   `false` holds GitHub Actions semver-major pin bumps for a maintainer).
   The policy file always protects itself.
5. Turn off Codex automatic review for the repository, so Codex reviews only
   what the gate sends it.
6. Make `review-gate` a required status check, with GitHub Actions as the
   expected source, and let agents queue `gh pr merge --auto --squash`.

### Develop

```sh
npm test
```

Dry run against a live pull request (reads only; logs every write):

```sh
RG_DRY_RUN=1 RG_MODE=gate RG_PR=<n> GITHUB_REPOSITORY=<owner/repo> \
  RG_GITHUB_TOKEN="$(gh auth token)" node review-gate/src/main.mjs
```
