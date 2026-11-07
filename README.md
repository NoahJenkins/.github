# NoahJenkins/.github

Shared GitHub automation for personal repositories.

| Component | Use | Pin |
| --- | --- | --- |
| [`review-gate`](#review-gate) | Risk-tiered review status for agent pull requests | `NoahJenkins/.github@<sha>` |
| [`pr-repair`](pr-repair/README.md) | Bounded repair, independent review, and native merge for dependency updates | `NoahJenkins/.github/pr-repair@<sha>` |

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
- The `sweep` mode (scheduled in the caller) retries a missing, stalled, or
  unavailable gate twice, then labels `needs-human` and mentions the owner. It
  also escalates merge conflicts on pull requests with auto-merge enabled.
- After `max_rounds` (default 3) commits in a row with blocking findings, the
  gate escalates instead of looping.
- Dependabot runs get no Actions secrets, so Dependabot pull requests are
  decided from their own text: patch/minor semver updates pass, and majors,
  unreadable versions, and `.github/` changes need a maintainer.

### Use it

1. Allow the action in the repository (Settings → Actions → allowed actions):
   `NoahJenkins/.github@<sha>`.
2. Add secrets:
   - `AI_GATEWAY_API_KEY`: Vercel AI Gateway key for the backup review.
   - `CODEX_TRIGGER_TOKEN` (optional): fine-grained token of a Codex-linked user,
     with Pull requests and Issues write on the repository. Codex may ignore
     `@codex review` comments posted by `github-actions`.
3. Copy [`examples/review-gate.yml`](examples/review-gate.yml) to
   `.github/workflows/review-gate.yml` and pin the SHA.
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
   `force_review_label`, `max_rounds`. The policy file always protects itself.
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
