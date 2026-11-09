# pr-repair

Shared repair, review, and merge controller for automated dependency pull
requests. Consumers keep a thin caller workflow and an explicit policy file; the
engine lives here once.

```text
CI fails on a Dependabot PR (or review finds a blocker)
  │
  ├─ trusted runtime-contract sync (free, no model)       ─┐
  └─ bounded model repair (reserved in the ledger first)  ─┤
                                                            ▼
     admission (scope, image identity, requested targets, contract)
                                                            ▼
     isolated candidate checks (credential-free containers)
                                                            ▼
     authenticated publication: App commit on pr-repair/<n>, replacement PR
                                                            ▼
     fresh required CI ─▶ independent review (exact head + base) ─▶ optional Codex
                                                            ▼
     obsolete agent threads resolved ─▶ production interlock ─▶ approval per policy
                                                            ▼
     native auto-merge (or a direct merge once mergeable), bound to the head ─▶ existing release workflow
                                                            ▼
     original closed only if its head still matches the replacement's root
```

Failed checks or blocking findings on the replacement re-enter repair within
the same budget. An independent review stays current while the default branch
only changes files the replacement does not change and not the policy file;
otherwise, or when that cannot be shown completely, it is redone. Every update
pull request always shows one named state: on its `pr-repair` check run
(neutral when out of scope, so it never blocks another workflow's merge), on
the `pr-repair status` issue, and in the run summary.

Where protection requires an up-to-date branch and pr-repair merges originals,
a behind original is rebased by asking the update bot (with the approver token)
or, without one, by the App updating the branch from the default branch once
per head. Dependabot stops rebasing a branch someone else pushed to, so a
refreshed original that later conflicts goes to a maintainer (`@dependabot
recreate`).

| State | Meaning |
| --- | --- |
| `waiting-ci` / `waiting-review` | Evidence for the current head is not in yet. |
| `repairing` / `reviewing` | An attempt is reserved and in flight. |
| `missing-configuration` | Paid work is paused; the detail names what is missing. Nothing was reserved. |
| `unsupported-scope` | Outside this repository's policy (ecosystem, update type, file count, contract drift). |
| `conflict` | A merge conflict; the update bot is asked to rebase once per head. |
| `exhausted` | The bounded budget is used. A maintainer decides. |
| `production-paused` | Production evidence is unhealthy or unreadable; queued merges are disabled. |
| `needs-human` | Foreign commits, human or current-head threads, repeated interruptions, review findings only in files repair may not edit, or a repair of this head that proposed no change. |
| `waiting-merge-path` | Green original; the repository's existing workflow merges it. |
| `queued-merge` | Native auto-merge is queued for the validated head. |
| `resolved` | The replacement merged and the original closed. |

## Eligibility

- Originals: open, same-repository pull requests from a bot listed in
  `eligibility.authors` (default `dependabot[bot]`), targeting the default branch,
  in an ecosystem the policy lists, with every commit a verified commit by that
  bot. The one exception is the controller App's update-branch merge, and only
  when it is provably harmless: committed by GitHub (`web-flow`), its second
  parent already on the default branch, and every changed file exactly as the
  bot's last commit has it. `non-major` ecosystems reject majors unless `securityMajors` is set and
  the body says it is a security fix.
- Replacements: the controller App's own pull request on `pr-repair/<n>` whose
  body carries its provenance and whose commits are all verified App or bot
  commits. Anyone else pushing removes its eligibility.
- Human-authored pull requests are never repaired, approved, resolved, or merged.
  The policy refuses non-bot authors.

## Isolation

| Job | Credential | Untrusted input | Executes candidate code |
| --- | --- | --- | --- |
| plan | controller App token (+ optional approver token) | PR metadata only | no |
| prepare | read-only `GITHUB_TOKEN` | files, sanitized logs | no |
| infer | provider credential only | curated bundle (read-only tool) | no |
| validate | read-only `GITHUB_TOKEN` (never passed to containers) | candidate tree | yes, in containers: `--cap-drop=ALL`, `no-new-privileges`, the runner's own non-root uid, no Docker socket, no host mounts except a copy, checks on `--network=none` |
| publish | controller App token | sealed artifacts | no |

- The caller runs only on `workflow_run`, `schedule`, and `workflow_dispatch` for
  the default branch. `pull_request` runs only the credential-free `contract`
  job. Nothing uses `pull_request_target`.
- Model output is data. It never runs and is never trusted: admission rejects
  protected paths (workflows, instructions, tests, migrations, lockfiles,
  `.npmrc`, the policy itself), changes to Docker `FROM` lines, added or removed
  dependencies, non-registry versions, and any candidate that drops a requested
  version, image, action pin, or lockfile-only resolution.
- The lockfile is regenerated by the policy's command with scripts disabled,
  snapshotted, and must be unchanged after the candidate's checks.
- The publisher re-admits the validated files against the authenticated head
  before writing, and re-checks head and base immediately before the commit.

## Runtime contract

`runtimes[]` declares where each runtime version lives. When an update moves a
digest-pinned image (`FROM image:tag@sha256:…`), trusted code rewrites every
declared field and the candidate must have no field left on the old value.

```json
{
  "name": "bun",
  "image": "oven/bun",
  "versionPattern": "^(?<version>\\d+\\.\\d+\\.\\d+)",
  "fields": [
    { "files": ["scripts/ops/smoke-api-docker.sh"], "template": "'{version}'" },
    { "files": ["scripts/safety/*.sh"], "template": "{imageRef}" },
    { "files": ["AGENTS.md", "docs/*.md"], "template": "Bun {version}", "optional": true }
  ]
}
```

Set `"majors": "maintainer"` on a runtime whose major versions also live
outside the repository (for example preinstalled on a CI runner image): its
major moves are reported as `unsupported-scope` for a maintainer, while minor
and patch moves still sync.

Placeholders: `{major}`, `{minor}` (major.minor), `{version}`, `{tag}`,
`{imageRef}` (`image:tag@sha256:digest`). When a tag carries only a major
(`node:25-bookworm-slim`) but the repository asserts an exact version, set
`"versionFromImageEnv": "NODE_VERSION"`: the exact version is read from the
digest-pinned image's own config through the registry (Docker Hub), verified
against the digest byte for byte, and must agree with the tag's major. Nothing
is pulled or run. Matches are whole tokens: `Node 24`
never rewrites `Node 24.19.0`. A required field that holds neither value, or a
field that needs more precision than the tag provides, stops the work as
`unsupported-scope`. The `contract` job checks the contract holds at rest on
every policy change.

The sync never weakens an assertion: an exact `== '1.4.0'` check becomes an
exact `== '1.4.4'` check. Lines the contract does not name (for example a
`corepack enable` that a new Node major removed) are left to bounded model
repair within `repair.editable`, and the result must still pass the checks.

## Ledger and budgets

The controller App keeps one comment on the `pr-repair status` issue it opens.
Each reservation records the pull request, exact head and base, kind,
transport, and model before any spend. Attempts are never refunded: a failed,
expired, or interrupted attempt stays consumed, including after a provider or
model change. `legacy.attemptChecks` imports attempts a previous controller
recorded as check runs. An attempt stuck in `publishing` is published only if
the branch head carries its `PR-Repair-Nonce`; otherwise it fails. Ambiguous
writes are never replayed.

Default limits (`repair.limits`): 2 repairs and 4 reviews per original, 1
trusted sync per head, 6 model tasks per UTC day.

## Inference

Provider and model are explicit policy values. Nothing defaults.

The one transport, `openai-compatible`, calls chat completions at
`inference.endpoint` (for example Vercel AI Gateway,
`https://ai-gateway.vercel.sh/v1`) with one read-only tool over the curated
data. On Vercel AI Gateway it asks for automatic prefix caching, because each
tool round re-sends the growing conversation; cached reads are recorded in the
usage. The model never runs anything; its final answer is parsed as data.

`inference.model` is one model id, or `{"repair": "...", "review": "..."}` so a
different model family reviews each repair. Each ledger reservation records the
model it used.

`inference.budget` caps model calls per task and output tokens. If the
transport, model, budget, endpoint, or credential is missing, the plan reports
`missing-configuration` and reserves nothing. The credential's presence comes
from the credential-only `preflight` job.

## Use it

1. Install a controller GitHub App on the repository with Actions, Checks,
   Contents, Issues, Pull requests, and Workflows write. Store its id as a
   variable and its private key in the controller environment.
2. Put the provider credential in a separate inference environment.
3. Add `.github/pr-repair.json` (keys below) and copy
   [`examples/pr-repair.yml`](../examples/pr-repair.yml), pinning the full SHA.
4. Merge the caller. It reports status only until `PR_REPAIR_ENABLED` (or the
   caller's equivalent variable) is `true`.
5. Disable any other controller for the same pull requests first. The caller
   passes `exclusive-active: true` while one is enabled, and pr-repair holds off.
   List its workflow files in `exclusive-workflows` as well: pr-repair then also
   waits until none of them has a queued or running run, whatever concurrency
   group they use, so a handoff or rollback never overlaps an in-flight run.

### Policy keys

| Key | Purpose |
| --- | --- |
| `ci.requiredChecks`, `ci.checkAppId` | Required check names and their publishing app (GitHub Actions `15368`). |
| `eligibility.updates` | `{ecosystem: "all" \| "non-major"}`. Unlisted ecosystems are out of scope. |
| `eligibility.authors`, `securityMajors`, `maxChangedFiles` | Bot authors, security-major exception, file cap. |
| `repair.editable`, `repair.protected`, `repair.context` | Model-editable globs; extra protected globs; extra context for the model. |
| `repair.maxFiles`, `maxBytes`, `limits` | Proposal size and attempt budgets. |
| `runtimes[]` | Runtime contract (above). |
| `validation.image` | Digest-pinned image, or `runtime:<name>` to validate on the requested runtime. |
| `validation.setup`, `lockfile`, `install`, `commands`, `dockerBuilds`, `env` | Trusted setup (image build), lockfile regeneration, install, checks (`--network=none`), image builds, plain env. |
| `inference.*` | Transport (`openai-compatible`), model (one id or `{repair, review}`), endpoint, budget. |
| `review.requireCodex`, `agentLogins`, `originals` | Codex signoff, agent logins whose obsolete threads may be resolved, review for originals. |
| `merge.originals` | Let pr-repair merge green originals (otherwise the existing workflow does). |
| `merge.approve` | `none`, `app`, or `approver-token` (the caller passes the approver token to plan only). |
| `merge.production` | `none`, `deployments` (`environment`, `creatorId`), or `workflow-run` (`workflow`, `requiredJobs`, `requiredSteps`, `promotedRef`). |
| `merge.pauseBranches` | Extra same-repository branches whose queued auto-merge pauses with production. |
| `legacy.attemptChecks` | Previous controller attempt check runs to count. |

## Develop

```sh
npm test                                   # unit and end-to-end tests over a fake GitHub
RUNNER_TEMP=$PWD/.test-tmp PR_REPAIR_DOCKER_TESTS=1 node --test pr-repair/test/docker.test.mjs
```

Dry-run a live repository (reads only; every write is logged):

```sh
PR_REPAIR_MODE=plan PR_REPAIR_DRY_RUN=1 PR_REPAIR_ENABLED=true GITHUB_REPOSITORY=<owner/repo> \
  PR_REPAIR_TOKEN="$(gh auth token)" PR_REPAIR_APP_ID=<id> PR_REPAIR_APP_SLUG=<slug> \
  node pr-repair/src/main.mjs
```
