import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { ExtensionRunner, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { createOrcaStackExtension } from "../extensions/orca-stack.ts";
import { appendMainCycle, keepMainCycleLast, mainCycleText } from "../lib/orca-main-cycle.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "gentle-pi-orca-main-cycle-"));
const gentleAiHome = join(scratch, "gentle-ai-home");
const gentleAiEnv: NodeJS.ProcessEnv = {
	HOME: gentleAiHome, USERPROFILE: gentleAiHome,
	GENTLE_PI_CONFIG_HOME: join(gentleAiHome, "config"),
	GENTLE_PI_AGENT_HOME: join(gentleAiHome, "agents"),
	PI_CODING_AGENT_DIR: join(gentleAiHome, "pi"),
	XDG_CONFIG_HOME: join(gentleAiHome, "xdg"),
};
const previousEnvironment = new Map<string, string | undefined>();
before(() => {
	mkdirSync(gentleAiHome, { recursive: true });
	for (const [key, value] of Object.entries(gentleAiEnv)) {
		previousEnvironment.set(key, process.env[key]);
		process.env[key] = value;
	}
});
after(() => {
	for (const [key, value] of previousEnvironment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(scratch, { recursive: true, force: true });
});
let fixtureCount = 0;

const CYCLE = "### Ciclo de `main`";
const BODY = "1. Read the board.\n2. Dispatch.\n\n#### Detail\n\n3. Merge.";
const NEXT = "### Despacho\n\nNot part of the cycle.";

function mainMd(body = BODY): string {
	return `# MAIN\r\n\r\n## Intro\r\n\r\nPreamble.\r\n\r\n${CYCLE}\r\n\r\n${body.replace(/\n/g, "\r\n")}\r\n\r\n${NEXT}\r\n`;
}

function fixture(options: { doc?: string; orca?: boolean; local?: string; linked?: boolean; separate?: boolean } = {}): { home: string; cwd: string; mainPath: string } {
	const base = join(scratch, `f${fixtureCount++}`);
	const home = join(base, "home");
	const mainPath = join(home, "orca", "stack", "MAIN.md");
	mkdirSync(dirname(mainPath), { recursive: true });
	if (options.doc !== undefined) writeFileSync(mainPath, options.doc);
	const root = join(base, "repo");
	const cwd = join(root, "packages", "app");
	mkdirSync(cwd, { recursive: true });
	if (options.linked) {
		const common = join(base, "main", ".git");
		const gitDir = join(common, "worktrees", "repo");
		mkdirSync(gitDir, { recursive: true });
		writeFileSync(join(gitDir, "commondir"), "../..\n");
		writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\n`);
	} else if (options.separate) {
		const gitDir = join(base, "separate.git");
		mkdirSync(gitDir, { recursive: true });
		writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\n`);
	} else {
		mkdirSync(join(root, ".git"));
	}
	if (options.orca !== false) writeFileSync(join(root, ".orca-stack.json"), "{}\n");
	if (options.local !== undefined) writeFileSync(join(root, ".orca-stack.local.json"), options.local);
	return { home, cwd, mainPath };
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function handlerFor(home: string, env: NodeJS.ProcessEnv = {}): Handler {
	const handlers = new Map<string, Handler>();
	const pi = { on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI;
	createOrcaStackExtension(env, { homedir: () => home })(pi);
	return handlers.get("before_agent_start")!;
}

async function appended(handler: Handler, cwd: string, initial = "", event: Record<string, unknown> = {}): Promise<string> {
	const options = { contextFiles: [], appendSystemPrompt: initial };
	const result = await handler({ ...event, systemPromptOptions: options }, { cwd });
	assert.equal(result, undefined, "never returns a replacement prompt");
	return options.appendSystemPrompt;
}

const SECTION = `${CYCLE}\n\n${BODY}`;
const blocks = (text: string): number => text.split("\n").filter((line) => line === CYCLE).length;

test("R1: with the toggle on in the main checkout, the cycle section is appended under a line naming MAIN.md", async () => {
	for (const local of [undefined, '{"gentleShell":"on"}']) {
		const { home, cwd, mainPath } = fixture({ doc: mainMd(), local });
		const text = await appended(handlerFor(home), cwd);
		const [header, ...rest] = text.split("\n");
		assert.ok(header!.includes(mainPath), `header names ${mainPath}: ${header}`);
		assert.equal(rest.join("\n").replace(/^\n+/, ""), SECTION, String(local));
		assert.ok(!text.includes("Despacho") && !text.includes("Preamble"), "stops before the next ### and starts at the heading");
		assert.ok(!text.includes("\r"), "CRLF normalized");
	}
});

test("R1: a section over 10,000 characters is appended whole, in one block", async () => {
	const long = Array.from({ length: 400 }, (_, i) => `${i}. ${"step ".repeat(8)}done`).join("\n");
	assert.ok(long.length > 10_000);
	const { home, cwd } = fixture({ doc: mainMd(long) });
	const text = await appended(handlerFor(home), cwd);
	assert.ok(text.endsWith(`${CYCLE}\n\n${long}`), "the whole section, uncut");
	assert.equal(blocks(text), 1, "one block");
	assert.ok(!/parte|part \d/.test(text), "never chunked");
});

test("R1: a # or ## heading also ends the section", async () => {
	const { home, cwd } = fixture({ doc: `${CYCLE}\n\nA.\n\n## Next\n\nB.\n` });
	const text = await appended(handlerFor(home), cwd);
	assert.ok(text.endsWith(`${CYCLE}\n\nA.`), text);
});

test("R2: ORCA_STACK_POLICY_PATH moves MAIN.md beside the policy; empty or blank falls back to <home>/orca/stack", async () => {
	const { home, cwd, mainPath } = fixture({ doc: mainMd("home cycle") });
	const policyDir = join(scratch, `policy${fixtureCount++}`);
	mkdirSync(policyDir, { recursive: true });
	writeFileSync(join(policyDir, "MAIN.md"), mainMd("policy cycle"));
	const moved = await appended(handlerFor(home, { ORCA_STACK_POLICY_PATH: join(policyDir, "ORCA-STACK.md") }), cwd);
	assert.ok(moved.includes(join(policyDir, "MAIN.md")), moved);
	assert.ok(moved.endsWith("policy cycle"), moved);
	for (const blank of ["", "   "]) {
		const text = await appended(handlerFor(home, { ORCA_STACK_POLICY_PATH: blank }), cwd);
		assert.ok(text.includes(mainPath) && text.endsWith("home cycle"), JSON.stringify(blank));
	}
});

test("R3: off, a linked worktree, no .orca-stack.json, a child session or a named agent leave the prompt unchanged", async () => {
	const off = fixture({ doc: mainMd(), local: '{"gentleShell":"off"}' });
	assert.equal(await appended(handlerFor(off.home), off.cwd, "ORCH"), "ORCH", "toggle off");
	const linked = fixture({ doc: mainMd(), linked: true });
	assert.equal(await appended(handlerFor(linked.home), linked.cwd, "ORCH"), "ORCH", "linked worktree");
	const plain = fixture({ doc: mainMd(), orca: false });
	assert.equal(await appended(handlerFor(plain.home), plain.cwd, "ORCH"), "ORCH", "no .orca-stack.json");
	const on = fixture({ doc: mainMd() });
	assert.equal(await appended(handlerFor(on.home, { GENTLE_PI_AGENTS_CHILD: "1" }), on.cwd, "ORCH"), "ORCH", "child session");
	for (const event of [{ agentName: "worker" }, { agent: "worker" }, { name: "worker" }, { agent: { name: "worker" } }, { subagent: { name: "worker" } }]) {
		assert.equal(await appended(handlerFor(on.home), on.cwd, "ORCH", event), "ORCH", JSON.stringify(event));
	}
	assert.notEqual(await appended(handlerFor(on.home), on.cwd, "ORCH", { agentName: "  " }), "ORCH", "a blank name is the primary session");
	const separate = fixture({ doc: mainMd(), separate: true });
	assert.ok((await appended(handlerFor(separate.home), separate.cwd, "ORCH")).includes(SECTION), "a --separate-git-dir checkout (no commondir) is the main checkout");
});

test("R4: a missing MAIN.md or a missing section appends one short line and the turn goes on", async () => {
	const missing = fixture();
	let text = "";
	await assert.doesNotReject(async () => { text = await appended(handlerFor(missing.home), missing.cwd); });
	assert.equal(text.split("\n").length, 1, text);
	assert.ok(text.includes(missing.mainPath) && /missing|could not read/i.test(text), text);
	const noSection = fixture({ doc: "# MAIN\n\n### Despacho\n\nx\n" });
	await assert.doesNotReject(async () => { text = await appended(handlerFor(noSection.home), noSection.cwd); });
	assert.equal(text.split("\n").length, 1, text);
	assert.ok(text.includes(noSection.mainPath) && /not found/i.test(text), text);
});

test("R5: two calls on the same options append the block once", async () => {
	const { home, cwd } = fixture({ doc: mainMd() });
	const handler = handlerFor(home);
	const options = { contextFiles: [], appendSystemPrompt: "" };
	await handler({ systemPromptOptions: options }, { cwd });
	await handler({ systemPromptOptions: options }, { cwd });
	assert.equal(blocks(options.appendSystemPrompt), 1);
});

const ORCH = "el Gentleman Identity and Harness";
const ON_RUNNER_ORDERS = ["orca-stack first", "gentle-ai first"] as const;

function gentleAiStub(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		const opts = event.systemPromptOptions as { appendSystemPrompt: string };
		opts.appendSystemPrompt = opts.appendSystemPrompt ? `${opts.appendSystemPrompt}\n\nORCHESTRATOR PROMPT` : "ORCHESTRATOR PROMPT";
		keepMainCycleLast(opts);
	});
}

async function runnerPrompt(order: (typeof ON_RUNNER_ORDERS)[number], gentleAi: (pi: ExtensionAPI) => void, home: string, cwd: string): Promise<string> {
	const runtime = createExtensionRuntime();
	const eventBus = createEventBus();
	const orca = await loadExtensionFromFactory(createOrcaStackExtension({}, { homedir: () => home }), cwd, eventBus, runtime, "extensions/orca-stack.ts");
	const ai = await loadExtensionFromFactory(gentleAi, cwd, eventBus, runtime, "extensions/gentle-ai.ts");
	const sessionManager = { getSessionId: () => `orca-main-cycle-${order}`, getBranch: () => [], getCwd: () => cwd };
	const runner = new ExtensionRunner(order === "orca-stack first" ? [orca, ai] : [ai, orca], runtime, cwd, sessionManager as never, {} as never);
	const errors: string[] = [];
	runner.onError((error) => errors.push(`${error.extensionPath}: ${error.error}`));
	const { systemPromptOptions } = await runner.emitBeforeAgentStart({} as never, { cwd, contextFiles: [], appendSystemPrompt: "" } as never);
	assert.deepEqual(errors, [], "no handler failed");
	return systemPromptOptions.appendSystemPrompt ?? "";
}

test("A13 (#13 ordering): Pi does not sort ./extensions, and the MAIN.md block lands after the orchestrator prompt in either load order", async () => {
	const pkgMgr = readFileSync(join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js"), "utf8");
	const collect = /function collectAutoExtensionEntries\(dir\)[\s\S]*?^}/m.exec(pkgMgr)?.[0] ?? "";
	assert.ok(collect.includes("readdirSync"), "found collectAutoExtensionEntries");
	assert.equal(collect.includes(".sort("), false, "load order is raw readdirSync order, so it is not guaranteed");
	const { home, cwd } = fixture({ doc: mainMd() });
	const prompts = [];
	for (const order of ON_RUNNER_ORDERS) {
		const text = await runnerPrompt(order, gentleAiStub, home, cwd);
		assert.ok(text.startsWith("ORCHESTRATOR PROMPT\n\n"), `${order}: ${text}`);
		assert.ok(text.endsWith(SECTION), `${order}: the cycle is last`);
		assert.equal(blocks(text), 1, order);
		prompts.push(text);
	}
	assert.equal(prompts[0], prompts[1], "the same prompt in both orders");
});

test("A13 (#13 ordering): the real gentle-ai.ts moves the MAIN.md block after its orchestrator prompt in either load order", async () => {
	const { home, cwd } = fixture({ doc: mainMd() });
	const prompts = [];
	for (const order of ON_RUNNER_ORDERS) {
		const gentleAi = createGentleAiExtension({
			nativeReviewCli: null,
			processEnv: { ...gentleAiEnv, GENTLE_PI_AGENTS_CHILD: "0", GENTLE_AI_TELEMETRY: "0" },
			resolveTelemetryTriggerBinary: () => join(scratch, "never-executed"),
			telemetryTriggerSpawn: () => assert.fail("prompt fixtures must not spawn telemetry"),
		});
		const text = await runnerPrompt(order, gentleAi, home, cwd);
		assert.ok(text.includes(ORCH), `${order}: orchestrator prompt present`);
		assert.ok(text.indexOf(CYCLE) > text.indexOf(ORCH), `${order}: the cycle comes after the orchestrator prompt`);
		assert.ok(text.endsWith(SECTION), `${order}: the cycle is the last block`);
		assert.equal(blocks(text), 1, order);
		prompts.push(text);
	}
	assert.equal(prompts[0], prompts[1], "the same prompt in both orders");
});

test("A13: keepMainCycleLast moves the recorded block (or the R4 line) to the end once, and is a no-op when absent", () => {
	const absent = { appendSystemPrompt: "A\n\nB" };
	keepMainCycleLast(absent);
	assert.equal(absent.appendSystemPrompt, "A\n\nB", "no recorded block");
	assert.doesNotThrow(() => { keepMainCycleLast(undefined); keepMainCycleLast(null); });
	const block = mainCycleText(mainMd(), "/home/u/orca/stack/MAIN.md");
	const errorLine = mainCycleText(undefined, "/home/u/orca/stack/MAIN.md");
	assert.equal(errorLine.split("\n").length, 1);
	for (const text of [block, errorLine]) {
		for (const initial of ["", "BASE"]) {
			const options = { appendSystemPrompt: initial };
			appendMainCycle(options, text);
			appendMainCycle(options, text);
			options.appendSystemPrompt += "\n\nORCH\n\nYOLO";
			keepMainCycleLast(options);
			keepMainCycleLast(options);
			const expected = [initial, "ORCH", "YOLO", text].filter(Boolean).join("\n\n");
			assert.equal(options.appendSystemPrompt, expected, JSON.stringify(initial));
			assert.deepEqual(Object.keys(options), ["appendSystemPrompt"], "the record is not enumerable");
		}
	}
	const removed = { appendSystemPrompt: "" };
	appendMainCycle(removed, block);
	removed.appendSystemPrompt = "ORCH";
	keepMainCycleLast(removed);
	assert.equal(removed.appendSystemPrompt, "ORCH", "a block no longer present is not re-added");
});

test("PRESERVE: with the toggle off the contract blocks are still filtered and nothing is appended", async () => {
	const { home, cwd } = fixture({ doc: mainMd(), local: '{"gentleShell":"off"}' });
	const content = "# R\n<!-- orca-stack:begin -->\nX\n<!-- orca-stack:end -->\nY";
	const options = { contextFiles: [{ path: "/repo/AGENTS.md", content }], appendSystemPrompt: "" };
	await handlerFor(home)({ systemPromptOptions: options }, { cwd });
	assert.equal(options.contextFiles[0]!.content, "# R\nY");
	assert.equal(options.appendSystemPrompt, "");
});
