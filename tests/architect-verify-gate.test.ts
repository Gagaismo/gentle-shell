import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// odd/tasks/architect-agent.md T2 (S5): gentle-ai-verify applies the
// architecture-gate Reviewer Rejection Criteria and every architect Immutable
// Boundary only when the task carries an architect ADR; without one it
// behaves exactly as before. Instruction-delivery contracts, not proof of
// model adherence.

const ROOT = join(import.meta.dirname, "..");
const read = (relative: string): string => readFileSync(join(ROOT, relative), "utf8");
const verify = read("assets/agents/gentle-ai-verify.md");
const HEADING = "## Architect ADR gate";

function gateSection(): string {
	const start = verify.indexOf(`\n${HEADING}\n`);
	assert.ok(start !== -1, `verify is missing the ${HEADING} section`);
	const next = verify.indexOf("\n## ", start + HEADING.length + 2);
	assert.ok(next !== -1, "the gate section must be followed by another section");
	return verify.slice(start, next);
}

function containsAll(text: string, clauses: readonly string[], label: string): void {
	for (const clause of clauses) assert.ok(text.includes(clause), `${label} is missing: ${clause}`);
}

test("S5: verify applies the architecture gate only when the task carries an architect ADR", () => {
	const gate = gateSection();
	containsAll(gate, [
		"Only when the task or the feature document carries a `gentle-ai-architect` ADR",
		"`Immutable Boundaries for Writers`",
		"read the `gentle-ai-architecture-gate` skill",
		"`## Skills to load before work`",
		"the packaged `skills/architecture-gate/SKILL.md`",
		"\"Reviewer Rejection Criteria (Hard Fail)\"",
		"every Immutable Boundary",
		"a verdict per boundary",
		"alongside the per-`S#` verdicts",
	], "architect ADR gate");
});

test("S5: without an ADR verify behaves as before; the gate is the only architect text", () => {
	const gate = gateSection();
	assert.ok(gate.includes("Without an architect ADR, skip this section"), "the gate must state the no-ADR path");
	const rest = verify.replace(gate, "");
	for (const term of ["architect", "ADR", "architecture-gate", "Immutable Boundar", "Reviewer Rejection"]) {
		assert.ok(!rest.includes(term), `verify mentions "${term}" outside the gate section`);
	}
	// The per-S# verdict contract stays as it was.
	assert.ok(rest.includes("5. **Every item.** Return a verdict for EVERY spec item: met, unmet, not implemented, or out of scope"));
	assert.ok(rest.includes("return a verdict per `S#` with evidence (item 5 below)"));
});

test("S5: the skill the gate reads carries the criteria it names", () => {
	const skill = read("skills/architecture-gate/SKILL.md");
	assert.match(skill, /^name: gentle-ai-architecture-gate$/m);
	assert.ok(skill.includes("## 3. Reviewer Rejection Criteria (Hard Fail)"));
});

test("S3b/S4: the skill's criterion 3 requires the workload physics to fit, like the agent", () => {
	const skill = read("skills/architecture-gate/SKILL.md");
	const criterion = skill.split("\n").find((line) => line.startsWith("3. It introduces PostgreSQL"));
	assert.ok(criterion);
	assert.match(criterion, /workload physics fit/);
});
