# Hardening the `code-review` skill and its invocation path

**Date:** 2026-07-30
**Trigger incident:** Three `code-review` skill forks, spawned by `the-usual` recipe step-runners
working in `.worktrees/rust-resolve-parity` and `.worktrees/codex-managed-launch-s5`, ran `git diff`
in the **main checkout** (`/home/dan/code/freshell`), reviewed unrelated freshly-merged code there,
and **applied 21 `edit_file` "fixes" to the main working tree** (~19:55, ~02:05, ~06:34 local).

---

## 1. Problem statement

A review-and-fix skill with **write access** selected its review target by heuristic
(`git diff` in whatever cwd it woke up in) instead of by explicit contract. Combined with a fork
context that inherits *nothing* from its spawner, the skill had no way to know it was in the wrong
repo checkout — and no rule telling it to check. It then exercised its "fix issues" mandate against
a tree it did not own.

## 2. Evidence (verified in this investigation)

All root-cause hypotheses from the forensics were **confirmed**, with one significant refinement (E1).

**E1 — The recipe never asked for this skill.** `the-usual.yaml` references exactly two skills by
name: `using-git-worktrees` (Step 0, line 333) and `requesting-code-review` (Step 4 final
whole-branch review, line 2129 — a *template-only* skill, reviewer is read-only). The string
`code-review` appears nowhere else as an invocation. Yet the step-runner session
`0000000000000000-2c2d3fdcff954fa0_the-usual-step-runner` shows **6 `load_skill` events with
`{"skill_name": "code-review"}`** (events.jsonl, e.g. 13:25:53Z, `toolu_01JMfcRJFAtkymrPiYTtYraq`)
vs 3 for `requesting-code-review`. This is a **name-collision misload**: the step-runner, told to
"request a code review," reached for the similarly-named destructive fork skill. The invocation was
`load_skill(skill_name="code-review")` with **no `arguments`** — so `$ARGUMENTS` was empty.

**E2 — The fork saw nothing but the skill body.** Fork session
`2c2d3fdcff954fa0-3b504f48b07944ad_self` (metadata: parent = the step-runner above): its first user
message is the SKILL.md body verbatim, with the `$ARGUMENTS` slot rendered as
`special attention to: `` ` (empty). No repo path, no branch, no task description reached it —
exactly the fork-isolation behavior the `load_skill` tool description warns about.

**E3 — Target selection was pure cwd heuristic.** The skill's Phase 1
(`~/.amplifier/cache/skills/amplifier-bundle-skills-5105b7c75992a85a/skills/code-review/SKILL.md:16`):

> Run `git diff` (or `git diff HEAD` if there are staged changes) to see what changed. If there are
> no git changes, review the most recently modified files that the user mentioned or that you edited
> earlier in this conversation.

The fork inherited the recipe controller's process cwd (`/home/dan/code/freshell`, the main
checkout — **not** the worktree), ran `git diff --stat` there as its first act (transcript turn 2:
14 files, ~213 insertions of freshly-merged #582 code), and proceeded. Note the fallback clause is
*incoherent for a fork*: a fork has no "earlier in this conversation" — it will always fall through
to "whatever is dirty here."

**E4 — Auto-apply with no gate.** Phase 3 (`SKILL.md:52-54`): "Aggregate their findings and fix each
issue directly." No target verification, no branch check, no ownership/attribution check, no
report-only fallback.

**E5 — `disable-model-invocation: true` did not prevent the load.** The skill's frontmatter sets
`disable-model-invocation: true` (SKILL.md:5), yet an agent's explicit
`load_skill(skill_name="code-review")` succeeded. The flag apparently governs only auto-invocation
visibility, not explicit loads. (Upstream finding.)

**E6 — Prior art: this bug class already bit this recipe once.** the-usual v3.0.1 changelog
(the-usual.yaml:63-84) fixed the *identical* failure for the fresheyes reviewer: a context-less
delegate whose "working directory could be the main repo," fixed by forcing
`git -C {{workspace.worktree_path}}` into the verbatim prompt. That fix was applied to one dispatch
site instead of stated as a policy, so the next context-less dispatch (skill fork) recreated the bug.

**Root cause chain:** name-collision misload of a destructive skill (E1) → fork isolation + empty
`$ARGUMENTS` (E2) → cwd-heuristic target selection in a dirty main checkout (E3) → unconditional
auto-fix (E4). Every link had to fail; every link gets a defense below.

---

## 3. Recommendations (ranked)

### R1 — the-usual: never load `code-review`; whitelist skill loads *(ship now — we own it)*

**File:** `/home/dan/code/bundle-the-usual/recipes/the-usual.yaml`

**(a)** In the Step 4 "Final whole-branch review" paragraph (line ~2126-2133), immediately after
`load_skill("requesting-code-review") and use its code-reviewer template;` add:

```
Load exactly that name. Do NOT load the `code-review` skill — despite the
similar name it is a different, destructive skill: a context-forked
review-AND-EDIT pass that diffs whatever checkout it wakes up in and
applies fixes there. It has previously corrupted the main checkout when
loaded from this workflow. `requesting-code-review` is template-only.
```

**(b)** In each step's cross-cutting rules block (execute-plan's is at line ~2171-2175; Steps 1-3/5
have equivalents), add one rule:

```
- Skill loads are whitelisted: this workflow may load ONLY
  using-git-worktrees (Step 0) and requesting-code-review (final review
  template). Never load any other skill; in particular never load
  `code-review`. Reviews in this workflow are performed by delegated
  reviewer subagents whose prompts this recipe supplies verbatim.
```

**(c)** Promote the v3.0.1 fix to policy. In the same cross-cutting blocks:

```
- Any subagent, reviewer, or skill you dispatch runs with an UNKNOWN working
  directory. Every dispatch prompt that touches the repo MUST state the repo
  root explicitly ({{workspace.worktree_path}}) and require `git -C` /
  path-prefixed access. Never rely on cwd.
```

**File:** `/home/dan/code/bundle-the-usual/agents/step-runner.md` — add rule 6:

```
6. **No unlisted skills.** Load a skill only when the step prompt names it
   explicitly, with the exact name given. If a name does not match exactly,
   stop and re-read the step prompt rather than loading a near-match.
```

Bump recipe to v3.2.1 with a changelog entry citing this incident.

### R2 — Skill-side guardrails: Phase 0 target verification + refusal rules *(ship now via workspace override; also upstream)*

The cached copy under `~/.amplifier/cache/skills/amplifier-bundle-skills-*/` is regenerated from the
upstream bundle — don't edit it in place. Instead ship a **workspace override** at
`/home/dan/code/freshell/.amplifier/skills/code-review/SKILL.md` (workspace skills take first-match
priority over cached bundle skills), and submit the same text upstream. Note the incident forks ran
with cwd = the freshell checkout, so a workspace override here **would have applied** to all three.

Changes to SKILL.md:

**(a) Frontmatter:** add `argument-hint: "<repo-path> [expected-branch] [focus notes]"`.

**(b) New Phase 0 — Verify Target (before anything else):**

```markdown
## Phase 0: Verify the Target (do this before reading any code)

You may be running as a forked sub-session: you inherit NO conversation
history, and your working directory is NOT guaranteed to be the repository
you were meant to review.

1. Parse `$ARGUMENTS` for a target repo path and (optionally) an expected
   branch. If a path is given: cd there, and prefix every git command with
   `git -C <path>`.
2. Echo your target before proceeding — print the output of:
   `git rev-parse --show-toplevel`, `git branch --show-current`,
   `git status --porcelain=v1 | head -20`.
3. REFUSE to continue (report the mismatch as your final message; make no
   edits, launch no review agents) when ANY of these hold:
   - An expected branch was given and does not match the current branch.
   - No explicit target path was given AND the checkout is on main/master
     AND `git status` shows uncommitted changes. You cannot attribute those
     changes (you have no conversation history); they belong to someone
     else. Reviewing-and-fixing them is corruption, not cleanup.
   - No explicit target path was given and there is nothing this session
     itself changed. (As a fork, "files you edited earlier in this
     conversation" is always empty — do not substitute "whatever is dirty
     in cwd" for it.)
4. When refusing, state: the toplevel and branch you found, the dirty files
   you declined to touch, and what invocation would make the review valid
   (e.g. "re-invoke with the worktree path as $ARGUMENTS").
```

**(c) Phase 1:** replace the fallback sentence. Old: *"If there are no git changes, review the most
recently modified files that the user mentioned or that you edited earlier in this conversation."*
New: *"If there are no git changes and `$ARGUMENTS` names specific files, review those; otherwise
report 'nothing to review' and stop."*

**(d) Phase 3 — apply-fixes gate (blast radius):**

```markdown
Fix issues directly ONLY when Phase 0 established a verified target: an
explicit path was provided (or the tree's only changes are attributable to
this session) AND any expected branch matched. Otherwise run in
REPORT-ONLY mode: write the aggregated findings to
<repo>/.discovery/code-review-findings-<timestamp>.md (or return them
inline), and make ZERO edits. Never write into a dirty tree whose changes
you cannot attribute.
```

### R3 — Any deliberate future invocation must pass the target in `arguments` *(ship now)*

If the-usual (or any workflow) ever *intends* to use `code-review`-style fix passes, the invocation
contract is:

```
load_skill(skill_name="code-review",
           arguments="{{workspace.worktree_path}} {{workspace.branch}} — review only the diff vs {{workspace.base_ref}}")
```

Encode this as a note next to R1(a)'s prohibition so the rule is "never load it bare," not "never
useful." R2's Phase 0 makes the bare load fail safe anyway — R1 and R2 are independent layers.

### R4 — Upstream platform findings *(file issues; not ours to ship)*

- **`disable-model-invocation: true` is not enforced for explicit `load_skill` calls** (E5). Either
  enforce (reject non-user-initiated loads) or rename the flag; today it is a false safety signal.
- **Fork skills should receive an auto-injected preamble**: spawner cwd, a "you have no parent
  context" warning, and the raw `arguments` string — so skill authors can write Phase-0-style checks
  against trustworthy facts instead of inferring.
- **Bundle hygiene:** `code-review` (fork, auto-edits) and `requesting-code-review` (template-only,
  read-only) differ by one word and by everything that matters. Rename the destructive one (e.g.
  `code-cleanup-fix`) or make its description scream WRITES.

### R5 — Optional belt-and-suspenders for this repo

A pre-edit hook (or repo convention) that flags writes to tracked files on `main` while
uncommitted changes exist that the session didn't author. Heavier machinery; only worth it if
R1+R2 prove insufficient. Not recommended for immediate build.

---

## 4. Ship now vs upstream

| # | Change | Where | When |
|---|--------|-------|------|
| R1 | Skill whitelist + `code-review` prohibition + cwd policy | `bundle-the-usual` (recipes/the-usual.yaml, agents/step-runner.md) | **Now** (local, we own it) |
| R2 | Phase 0 verify/refuse + fork-safe Phase 1 + gated Phase 3 | Workspace override `.amplifier/skills/code-review/SKILL.md` | **Now** (override); upstream PR to amplifier-bundle-skills after |
| R3 | Invocation contract (`arguments` carries path+branch) | Documented beside R1(a) | **Now** |
| R4 | `disable-model-invocation` enforcement; fork preamble; skill rename | Amplifier core / amplifier-bundle-skills | Upstream issues |
| R5 | Main-checkout write tripwire hook | freshell repo hooks | Deferred |

**Verification after shipping R1+R2:** re-run a the-usual recipe against a scratch task; confirm the
step-runner loads only whitelisted skills, and separately invoke `/code-review` bare from a dirty
main checkout and confirm it refuses with the Phase 0 report instead of editing.
