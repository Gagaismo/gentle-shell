# Viability study: the code comment reviewer as an on-demand roster agent

Status: assessment only, no code change (Gagaismo/orca-stack#436, R7).
Source request (A9): "considerar que tan viable seria incorporarlo a roster de los agentes de gentle ai, gentle shell. No hace falta que se dispare directamente en el ciclo ODD pero si que sea invocable".

The subject is the code comment reviewer that orca-stack adapts from pstack `no-comments` in Gagaismo/orca-stack#426. It is a different tool from the `comment-writer` skill in this repository, which writes PR and issue replies.

## Answer in one paragraph

Yes, it is viable, and it costs little. Gentle Shell already ships agents that ODD never launches: the Judgment Day judges and the RDD lens reviewers run only when a skill or the review controller asks for them. A comment reviewer fits the same shape. It is a read-only agent definition that the human, or the orchestrator when the human asks, launches by name with `subagent_run`. Nothing in the always-on prompt or in the ODD steps names it. The recommendation is to build it after #426 lands, as a project agent first and as a packaged agent once it has proved useful.

## 1. Can a roster agent be invoked on demand only, outside ODD?

Yes. The runtime supports it today, and the roster has precedents.

- **Discovery is by file, not by workflow.** `discoverAgents` in `lib/agents-config.ts` loads every `*.md` agent definition from the agent home (`agents/`, `subagents/`) and from the project's `.pi/agents/` and `.pi/subagents/`. Every discovered agent shows up in `subagent_list_agents` and can be launched with `subagent_run`. No orchestrator text has to name it.
- **Agents that ODD never launches already ship.** `jd-judge-a`, `jd-judge-b` and `jd-fix-agent` (`assets/agents/`, owner `review` in `lib/agent-assets.ts`) run only when the human triggers the `judgment-day` skill ("judgment day", "juzgar"). The `review-*` lens agents run only inside native review. The always-on orchestrator prompt names neither group.
- **On demand means two entry points, both explicit.** The human asks for a comment review of a diff or a path, and the parent launches the agent. Or the human invokes a thin skill whose trigger words are "comment review" or "revisar comentarios", and the skill launches it, as `judgment-day` launches its judges. Neither entry point adds an ODD step, a verify run, or an RDD lens.

One constraint: the agent must never become a silent ODD gate. That rules out adding it to the Close step, to the writer handoff, or to the verification tiers. It also rules out the orchestrator launching it on its own initiative. If a later ticket wants the orchestrator to offer it, the offer is a relayed suggestion, like the `Sugerencia:` line that this same issue adds to verify, and the human decides.

## 2. Brief and evidence rules

The brief follows #426 (R4 and R5) and cites `CODING_STANDARDS.md` from orca-stack by line. Line numbers below are from orca-stack commit `bc84fa278fbbfda74e772d1629ed61f61c9b5b02`.

**Role.** Read-only reviewer of code comments in an assigned diff or path list. Tools: `read`, `grep`, `find`, and `bash` only to run the target repository's comment lint when it has one (`orca-stack lint` in an orca-stack repository). It never edits, commits, or delegates.

**Classification.** Every comment it reports gets exactly one of the four types and its action from the table at `CODING_STANDARDS.md:9-14`:

| Type | Action |
|---|---|
| Tautology | Delete it. |
| Excuse | Delete it and open an issue to fix the implementation. |
| Stale | Delete it. |
| Decision Record | Move it to an ADR. |

**Evidence rules.**

1. A finding is reported as blocking only with one of two kinds of evidence. A `regla escrita` finding cites `CODING_STANDARDS.md:<line>`: the type table (`:9-14`), the single permitted comment (`:18`), or a judgment rule by its heading (`:30-32`, then `:34` Tautología no obvia, `:38` Comentario vencido, `:42` Excusa sin palabra clave, `:46` Decision Record que pide un ADR). A `comando` finding is a failing lint run, with the exact command and its output.
2. A Decision Record that cites an ADR or an issue `#n` is never a finding (`CODING_STANDARDS.md:18`).
3. A comment the reviewer merely dislikes goes under suggestions, never under findings.
4. Each finding states type, `path:line`, and action, and nothing else. The persona is sober: no insults, jokes, or exaggerated tone (#426 R5).
5. When the target repository has no `CODING_STANDARDS.md` or no comment rule, the reviewer reports that and returns suggestions only. It never imports orca-stack's rule into a repository that has not adopted it.

**Output.** A compact handoff in the format of the other read-only agents: findings, suggestions, the commands it ran with their exit codes, and anything it could not check.

**What it does not do.** It does not judge naming, structure, or behavior (the `review-readability` lens and verify own those), and it does not fix comments. Fixing is the writer's job, through the author self-check that #426 R3 adds to the worker brief.

## 3. Cost

| Item | Project agent (`.pi/agents/`) | Packaged agent (`assets/agents/`) |
|---|---|---|
| New files | one agent definition, about 3 KB, the size of `jd-judge-a.md` (3,184 B) | the same file |
| Package wiring | none | an `ASSET_OWNER_BY_KEY` entry in `lib/agent-assets.ts`, a required path in `scripts/verify-package-files.mjs`, a hash in `assets/migrations/agent-body-history.json`, and a contract test on the brief |
| Always-on prompt bytes | 0 | 0, as long as no orchestrator text names it |
| Optional trigger skill | none | one small skill, about 1 KB, only if the human wants a trigger phrase |
| Runtime cost per use | one read-only subagent run over the diff and `CODING_STANDARDS.md` | the same |
| Maintenance | the brief cites line numbers, so a change to `CODING_STANDARDS.md` can make them stale; a contract test that checks the cited headings exist catches it | the same, plus version upgrades through the managed-assets manifest |

The main risk is duplicated authority. If the brief copies the rule text instead of citing it, the agent and `CODING_STANDARDS.md` drift apart. Citing by line and heading, and testing the citations, keeps one source.

A second risk is overlap with the RDD `readability` lens, which may also flag comments during native review. They do not conflict, because the lens runs inside native review and the comment reviewer runs only when asked. If both run on the same candidate, the human sees the same comment twice; that costs little and needs no rule.

## 4. Dependencies

- Gagaismo/orca-stack#426 is still open. The `no-comments` skill, its sober persona, and the review-brief comment axis do not exist yet, so the agent has no adapted source to wrap today.
- `CODING_STANDARDS.md` lives in orca-stack, not in Gentle Shell. A repository wired by orca-stack has its own copy; any other repository gets evidence rule 5 (suggestions only).

## 5. Recommendation

Build it, in two steps, after #426 lands:

1. **Project agent first.** Put `code-comment-reviewer.md` under `.pi/agents/` in the repositories that adopt the comment rule. This needs no Gentle Shell change and no package release, and it tests the brief on real diffs.
2. **Package it when it has proved useful.** Move it into `assets/agents/` with owner `review`, its package wiring, and a contract test on the brief. Keep it out of the always-on prompt and the ODD steps. Add a trigger skill only if the human wants one.

Use the name `code-comment-reviewer`, not "comment reviewer", so it is not confused with the `comment-writer` skill.

Out of scope for this issue: any code, agent file, or skill. The follow-up ticket, opened once #426 lands, carries step 1.
