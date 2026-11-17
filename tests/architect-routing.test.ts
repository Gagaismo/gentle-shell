import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// odd/tasks/architect-agent.md S6: in both workflow modes the orchestrator launches
// `gentle-ai-architect` before the first write when a task chooses a runtime or storage
// engine or adds a backend/service, records its ADR verbatim in the feature document
// `## Log` and its mirror, turns its Immutable Boundaries for Writers into spec lines
// that writers and `gentle-ai-verify` read by reference, relays its Sanity Check
// questions, and launches nothing for tasks that make no such choice.

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL_ASSETS_DIR = join(REPO_ROOT, "assets");
const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

const { __testing } = await import("../extensions/gentle-ai.ts");

const MODES = {
	organic: { rendered: () => __testing.renderOrchestratorPrompt(REAL_ASSETS_DIR), firstWrite: "before the first write," },
	"full-delegation": {
		rendered: () => __testing.renderOrchestratorPrompt(REAL_ASSETS_DIR, undefined, undefined, "full-delegation"),
		firstWrite: "before the first writer,",
	},
} as const;

function architectLine(prompt: string): string {
	const lines = prompt.split("\n").filter((line) => line.includes("**Architect**"));
	assert.equal(lines.length, 1, "the prompt carries exactly one Architect mechanism");
	return lines[0];
}

for (const [mode, { rendered, firstWrite }] of Object.entries(MODES)) {
	test(`S6 ${mode}: the always-on prompt launches the architect on stack decisions and only then`, () => {
		const line = architectLine(rendered());
		for (const clause of [
			"chooses a runtime or storage engine or adds a backend/service",
			"`gentle-ai-architect`",
			firstWrite,
			"else never",
			"its ADR verbatim in the feature document `## Log` and mirror",
			"its Immutable Boundaries for Writers into `S#` lines that writers and `gentle-ai-verify` read by reference",
			"relay its Sanity Check questions (at most 2) to the user",
		]) {
			assert.ok(line.includes(clause), `${mode} Architect mechanism is missing: ${clause}`);
		}
	});
}

test("S6: the agent routing docs say when the orchestrator launches the architect", () => {
	assert.ok(
		read("docs/readme-reference.md").includes("The orchestrator launches `gentle-ai-architect` in both workflow modes"),
		"docs/readme-reference.md must say when the orchestrator launches the architect",
	);
});
