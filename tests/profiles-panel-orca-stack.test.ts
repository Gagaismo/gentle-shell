import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import { bootstrapProfilesFile, type AgentProfilesFile } from "../lib/agent-profiles.ts";
import type { AgentModelConfig } from "../lib/model-routing-authority.ts";
import type { OrcaStackChoice, OrcaStackPanelControl } from "../lib/orca-stack-toggle.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// Personal fork feature (odd/tasks/orca-stack-toggle.md, S2): in an orca-stack
// project the /gentle:profiles panel shows `o orca-stack: on|off` among its key
// hints, and `o` flips the stored per-project choice at once (no draft, no
// save). Outside an orca-stack project the panel has no such hint and `o` does
// nothing.

const AGENTS = ["gentle-ai-explore", "gentle-ai-worker"];

function file(): AgentProfilesFile {
	const profiles = bootstrapProfilesFile({}) as AgentProfilesFile;
	profiles.profiles = { team: { orchestrator: { model: "openai/gpt-5.5", thinking: "high" } } } as AgentProfilesFile["profiles"];
	profiles.active = "team";
	return profiles;
}

function control(initial: OrcaStackChoice, refuse?: string): OrcaStackPanelControl & { writes: OrcaStackChoice[] } {
	let state = initial;
	const writes: OrcaStackChoice[] = [];
	return {
		writes,
		read: () => state,
		write: (choice) => {
			writes.push(choice);
			if (refuse !== undefined) return refuse;
			state = choice;
			return undefined;
		},
	};
}

function render(inputs: string[], orcaStack?: OrcaStackPanelControl, results: Array<{ type: string }> = [], width = 120): string[] {
	const profiles = file();
	const config = JSON.parse(JSON.stringify(profiles.profiles["team"])) as AgentModelConfig;
	return __testing.routingTablePanel(
		config, ["openai/gpt-5.5"], AGENTS, width, undefined, 30, inputs, [],
		results as unknown as Parameters<typeof __testing.routingTablePanel>[8],
		{ file: profiles, profileName: "team", ...(orcaStack ? { orcaStack } : {}) },
	).map(stripAnsi);
}

test("an orca-stack project shows the current state among the key hints", () => {
	assert.match(render([], control("on")).join("\n"), /o orca-stack: on/);
	assert.match(render([], control("off")).join("\n"), /o orca-stack: off/);
	// It stays visible on a narrow terminal: lower-priority hints yield first.
	assert.match(render([], control("on"), [], 60).join("\n"), /o orca-stack: on/);
});

test("o flips the stored choice at once, both ways, and says what happens next", () => {
	const orca = control("on");
	const flipped = render(["o"], orca).join("\n");
	assert.deepEqual(orca.writes, ["off"]);
	assert.match(flipped, /o orca-stack: off/);
	assert.match(flipped, /orca-stack off for this project/);
	render(["o"], orca);
	assert.deepEqual(orca.writes, ["off", "on"]);
	assert.match(render([], orca).join("\n"), /o orca-stack: on/);
});

test("the flip is not an unsaved change: esc still closes on the first press", () => {
	const results: Array<{ type: string }> = [];
	render(["o", "\x1b"], control("on"), results);
	assert.deepEqual(results.map((result) => result.type), ["close"]);
});

test("a refused write is shown and the state is unchanged", () => {
	const orca = control("on", "orca-stack: /x/.orca-stack.local.json is not a JSON object; fix or remove it, then choose again.");
	const lines = render(["o"], orca, [], 160).join("\n");
	assert.match(lines, /is not a JSON object/);
	assert.match(lines, /o orca-stack: on/);
});

test("outside an orca-stack project there is no hint and o does nothing (preserved)", () => {
	const results: Array<{ type: string }> = [];
	const before = render([]);
	const after = render(["o"], undefined, results);
	assert.doesNotMatch(before.join("\n"), /orca-stack/);
	assert.deepEqual(after, before);
	assert.deepEqual(results, []);
});
