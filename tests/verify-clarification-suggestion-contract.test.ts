import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Gagaismo/orca-stack#436 (R1-R6): gentle-ai-verify adds a `Sugerencia: /sharpen` or
// `Sugerencia: /reframe` line when a spec line is ambiguous or a task premise proved
// false; the parent relays it and never runs either skill; verify runs no more often.
// Instruction-delivery contracts, not proof of model adherence.

const ROOT = join(import.meta.dirname, "..");
const read = (relative: string): string => readFileSync(join(ROOT, relative), "utf8");
const verify = read("assets/agents/gentle-ai-verify.md");
const verification = read("assets/orchestrator-verification.md");
const core = read("assets/orchestrator.md");
const HEADING = "## Clarification suggestions";

function suggestionSection(): string {
	const start = verify.indexOf(`\n${HEADING}\n`);
	assert.ok(start !== -1, `verify is missing the ${HEADING} section`);
	const next = verify.indexOf("\n## ", start + HEADING.length + 2);
	assert.ok(next !== -1, "the suggestion section must be followed by another section");
	return verify.slice(start, next);
}

function relayItem(): string {
	return verification.split("\n").find((line) => line.startsWith("6. **Suggestions**")) ?? "";
}

function containsAll(text: string, clauses: readonly string[], label: string): void {
	for (const clause of clauses) assert.ok(text.includes(clause), `${label} is missing: ${clause}`);
}

test("R1: verify suggests /sharpen when an S# admits two readings or has no checkable outcome", () => {
	containsAll(suggestionSection(), [
		"`Sugerencia: /sharpen",
		"admits two readings that lead to different code",
		"states no checkable outcome",
		"\"the report should be readable\" with no exact line",
	], "sharpen trigger");
});

test("R2: verify suggests /reframe when a premise the task relied on proved false", () => {
	containsAll(suggestionSection(), [
		"`Sugerencia: /reframe",
		"a premise the task relied on turned out false during verification",
		"the spec assumes a flag the tool does not have",
	], "reframe trigger");
});

test("R3: a clear S# that failed its test and a green unit never carry a suggestion", () => {
	const section = suggestionSection();
	containsAll(section, [
		"Never add a suggestion for a clear `S#` that simply failed its test: that is a defect, report it as unmet.",
		"A unit you verified green never carries a suggestion.",
	], "negative cases");
	// The triggers are the only admitted cases: the section opens with an exclusive scope.
	assert.ok(section.includes("Add a suggestion line only in these two cases"), "the triggers must be exclusive");
	// No suggestion text leaks into the rest of the verifier body as another trigger.
	const rest = verify.replace(section, "");
	for (const term of ["/sharpen", "/reframe"]) assert.ok(!rest.includes(term), `verify names ${term} outside ${HEADING}`);
});

test("R4: one line per suggestion in the exact format, at most one per S#", () => {
	const section = suggestionSection();
	containsAll(section, [
		"`Sugerencia: /sharpen (S<n>: <one-line reason>)`",
		"`Sugerencia: /reframe (<premise>: <one-line reason>)`",
		"One line per suggestion, at most one per `S#`.",
	], "format");
	// The handoff names the suggestion lines so they are not trimmed out of the compact report.
	const handoff = verify.split("\n").find((line) => line.startsWith("Return a compact evidence handoff")) ?? "";
	assert.ok(handoff.includes("any `Sugerencia:` lines"), "the compact handoff must carry the suggestion lines");
});

test("R5: the parent relays the suggestion to the human and never runs the skill", () => {
	containsAll(suggestionSection(), [
		"You never run either skill; the parent relays the line to the human.",
	], "verify relay boundary");
	containsAll(relayItem(), [
		"relay every `Sugerencia:` line of a verify handoff to the human verbatim in your report",
		"never invoke `/sharpen` or `/reframe` yourself: both are human-triggered",
	], "orchestrator relay");
});

test("R6: a suggestion adds no verify run; verify still runs only per high-risk unit", () => {
	containsAll(relayItem(), ["it adds no verify run, correction, or blocker"], "relay scope");
	containsAll(suggestionSection(), [
		"A suggestion never replaces the `S#` verdict and is never a blocker.",
	], "verify scope");
	const perUnit = verification.split("\n").find((line) => line.startsWith("2. **Independent verify per unit**")) ?? "";
	containsAll(perUnit, ["once, after its final self-review", "only when that unit is high risk"], "per-unit verify");
	assert.ok(
		verification.includes("The independent verifier runs only when the change touches a named Task Size high-risk item"),
		"the named-risk verifier rule stays as it was",
	);
	assert.ok(!core.includes("Sugerencia"), "the always-on core gains no suggestion trigger");
});
