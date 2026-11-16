import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	filterOrcaStackBlocks,
	filterOrcaStackContextFiles,
	orcaStackPanelControl,
	readOrcaStackChoice,
	shouldAskOrcaStackChoice,
	writeOrcaStackChoice,
} from "../lib/orca-stack-toggle.ts";
import orcaStackExtension, { createOrcaStackExtension, ORCA_STACK_QUESTION, ORCA_STACK_OPTIONS } from "../extensions/orca-stack.ts";

// Personal fork feature (odd/tasks/orca-stack-toggle.md): per project, a Gentle
// Shell session either sees the orca-stack contract (the blocks between
// `<!-- orca-stack:begin -->` and `<!-- orca-stack:end -->` in its context
// files) or does not. The choice lives in `.orca-stack.local.json` at the git
// worktree root, only in projects that carry `.orca-stack.json`.

const BEGIN = "<!-- orca-stack:begin -->";
const END = "<!-- orca-stack:end -->";

// --- T1 / S3: the pure filter ----------------------------------------------

test("S3 example: the orca-stack block goes and the project rules after it stay", () => {
	const input = `# Rules\n${BEGIN}\nX\n${END}\n## Project rules\nY`;
	const result = filterOrcaStackBlocks(input);
	assert.equal(result.content, "# Rules\n## Project rules\nY");
	assert.equal(result.removedBlocks, 1);
	assert.equal(result.failSafe, false);
});

test("S3 negative: a begin marker without its end leaves the file unchanged", () => {
	const input = `# Rules\n${BEGIN}\nX\n## Project rules\nY\n`;
	assert.deepEqual(filterOrcaStackBlocks(input), { content: input, removedBlocks: 0, failSafe: true });
});

test("S3 negative: markers inside fenced code are plain text", () => {
	for (const fence of ["```", "~~~", "````md"]) {
		const close = fence.replace(/[a-z]+$/, "");
		const input = `# Docs\n${fence}\n${BEGIN}\nexample\n${END}\n${close}\nafter\n`;
		assert.deepEqual(filterOrcaStackBlocks(input), { content: input, removedBlocks: 0, failSafe: false }, fence);
	}
});

test("markers count only alone on their line; inline mentions are plain text", () => {
	const input = `Wrap the contract in \`${BEGIN}\` and ${END} markers.\n`;
	assert.deepEqual(filterOrcaStackBlocks(input), { content: input, removedBlocks: 0, failSafe: false });
	const indented = `a\n  ${BEGIN}  \nX\n\t${END}\nb\n`;
	assert.equal(filterOrcaStackBlocks(indented).content, "a\nb\n");
});

test("an end without begin, or a begin reopened inside a block, leaves the file unchanged", () => {
	for (const input of [`a\n${END}\nb\n`, `${BEGIN}\n${BEGIN}\nX\n${END}\n${END}\n`, `${BEGIN}\nX\n${END}\n${END}\n`]) {
		assert.deepEqual(filterOrcaStackBlocks(input), { content: input, removedBlocks: 0, failSafe: true }, input);
	}
});

test("several blocks go, blank seams collapse to one, and a whole-file block leaves nothing", () => {
	const input = `# Top\n\n${BEGIN}\nA\n${END}\n\n\nmiddle\n\n${BEGIN}\nB\n${END}\n\n`;
	const result = filterOrcaStackBlocks(input);
	assert.equal(result.content, "# Top\n\nmiddle\n");
	assert.equal(result.removedBlocks, 2);
	assert.equal(filterOrcaStackBlocks(`${BEGIN}\n## Orca stack\nrules\n${END}\n`).content, "");
});

test("CRLF input keeps CRLF endings and gentle-ai managed blocks are untouched", () => {
	assert.equal(filterOrcaStackBlocks(`a\r\n${BEGIN}\r\nX\r\n${END}\r\nb\r\n`).content, "a\r\nb\r\n");
	const managed = "<!-- gentle-ai:engram-protocol -->\nkeep\n<!-- /gentle-ai:engram-protocol -->\n";
	assert.equal(filterOrcaStackBlocks(`${managed}${BEGIN}\nX\n${END}\n`).content, managed);
});

test("a file without orca-stack markers is returned identical", () => {
	const input = "# Plain\n\nNothing here.\n";
	assert.deepEqual(filterOrcaStackBlocks(input), { content: input, removedBlocks: 0, failSafe: false });
});

test("filterOrcaStackContextFiles replaces contextFiles on the same options object, never mutates entries, never throws", () => {
	const original = [
		{ path: "/home/AGENTS.md", content: `${BEGIN}\nX\n${END}\n` },
		{ path: "/repo/CLAUDE.md", content: "# Plain\n" },
	];
	const options: { contextFiles?: Array<{ path: string; content: string }> } = { contextFiles: original };
	assert.equal(filterOrcaStackContextFiles(options), 1);
	assert.notEqual(options.contextFiles, original);
	assert.deepEqual(options.contextFiles?.map((file) => file.content), ["", "# Plain\n"]);
	assert.equal(original[0].content, `${BEGIN}\nX\n${END}\n`);
	const filtered = options.contextFiles;
	assert.equal(filterOrcaStackContextFiles(options), 0, "idempotent");
	assert.equal(options.contextFiles, filtered);

	assert.equal(filterOrcaStackContextFiles(undefined), 0);
	assert.equal(filterOrcaStackContextFiles(null), 0);
	const malformed = { contextFiles: [{ path: "/x", content: 42 }] as unknown as Array<{ path: string; content: string }> };
	const before = malformed.contextFiles;
	assert.doesNotThrow(() => filterOrcaStackContextFiles(malformed));
	assert.equal(malformed.contextFiles, before);
});

// --- T2 / S4, S5: per-project state ----------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "gentle-pi-orca-stack-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let fixtureCount = 0;

/** A fresh git worktree root (a `.git` directory) with an optional `.orca-stack.json`, and a nested cwd. */
function project(options: { orca?: boolean; local?: string; gitFile?: boolean } = {}): { root: string; cwd: string; local: string } {
	const root = join(scratch, `p${fixtureCount++}`);
	const cwd = join(root, "packages", "app");
	mkdirSync(cwd, { recursive: true });
	if (options.gitFile) writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
	else mkdirSync(join(root, ".git"));
	if (options.orca !== false) writeFileSync(join(root, ".orca-stack.json"), "{}\n");
	const local = join(root, ".orca-stack.local.json");
	if (options.local !== undefined) writeFileSync(local, options.local);
	return { root, cwd, local };
}

test("S5: on and off are read from the worktree root, from any nested cwd", () => {
	assert.equal(readOrcaStackChoice(project({ local: '{"gentleShell":"on"}' }).cwd), "on");
	assert.equal(readOrcaStackChoice(project({ local: '{"gentleShell":"off"}' }).root), "off");
	assert.equal(readOrcaStackChoice(project({ local: '{"gentleShell":"off"}', gitFile: true }).cwd), "off", "a linked worktree's .git file marks the root");
});

test("S5: a missing file or key, a bad value, or bad JSON reads as not chosen and never throws", () => {
	assert.equal(readOrcaStackChoice(project().cwd), undefined);
	assert.equal(readOrcaStackChoice(project({ local: '{"other":1}' }).cwd), undefined);
	for (const bad of ['{"gentleShell":"OFF"}', '{"gentleShell":false}', '{"gentleShell":null}', "[]", '"off"', "{not json", ""]) {
		assert.equal(readOrcaStackChoice(project({ local: bad }).cwd), undefined, bad);
	}
});

test("S4: without .orca-stack.json at the root there is no choice and nothing is written", () => {
	const plain = project({ orca: false, local: '{"gentleShell":"off"}' });
	assert.equal(readOrcaStackChoice(plain.cwd), undefined);
	const fresh = project({ orca: false });
	assert.match(writeOrcaStackChoice(fresh.cwd, "off") ?? "", /not an orca-stack project/);
	assert.throws(() => readFileSync(fresh.local), /ENOENT/);
	assert.equal(orcaStackPanelControl(fresh.cwd), undefined, "the panel shows nothing new");
	assert.equal(readOrcaStackChoice(join(scratch, "no-git-here")), undefined);
});

test("S5: writing creates the file when missing", () => {
	const { cwd, local } = project();
	assert.equal(writeOrcaStackChoice(cwd, "off"), undefined);
	assert.deepEqual(JSON.parse(readFileSync(local, "utf8")), { gentleShell: "off" });
	assert.equal(readOrcaStackChoice(cwd), "off");
});

test("S5: writing merges the key and preserves every other key", () => {
	const { cwd, local } = project({ local: JSON.stringify({ provider: "codex", nested: { a: [1, 2] }, gentleShell: "off" }) });
	assert.equal(writeOrcaStackChoice(cwd, "on"), undefined);
	assert.deepEqual(JSON.parse(readFileSync(local, "utf8")), { provider: "codex", nested: { a: [1, 2] }, gentleShell: "on" });
});

test("S5: writing over bad JSON or a non-object refuses, keeps the file, and never throws", () => {
	for (const bad of ["{not json", "[1,2]", '"text"']) {
		const { cwd, local } = project({ local: bad });
		assert.match(writeOrcaStackChoice(cwd, "off") ?? "", /not a JSON object/, bad);
		assert.equal(readFileSync(local, "utf8"), bad);
	}
});

test("orcaStackPanelControl reads the effective state and flips it on disk", () => {
	const { cwd, local } = project({ local: '{"keep":true}' });
	const control = orcaStackPanelControl(cwd);
	assert.ok(control);
	assert.equal(control.read(), "on", "no stored choice is today's behavior: on");
	assert.equal(control.write("off"), undefined);
	assert.equal(control.read(), "off");
	assert.deepEqual(JSON.parse(readFileSync(local, "utf8")), { keep: true, gentleShell: "off" });
});

// --- T3 / S6: who is asked --------------------------------------------------

test("S6: only an interactive primary session is asked", () => {
	assert.equal(shouldAskOrcaStackChoice({ hasUI: true }, {}), true);
	assert.equal(shouldAskOrcaStackChoice({ hasUI: false }, {}), false);
	assert.equal(shouldAskOrcaStackChoice({ hasUI: true }, { GENTLE_PI_AUTONOMOUS_MODE: "1" }), false);
	assert.equal(shouldAskOrcaStackChoice({ hasUI: true }, { GENTLE_PI_AGENTS_CHILD: "1" }), false);
});

// --- T3 / S3, S6, S7: the extension hooks ----------------------------------

type Handler = (event: unknown, ctx: unknown) => unknown;

function hooks(env: NodeJS.ProcessEnv = {}): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	const pi = { on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI;
	createOrcaStackExtension(env)(pi);
	return handlers;
}

const CONTRACT_AGENTS_MD = `# Rules\n${BEGIN}\nX\n${END}\n## Project rules\nY`;

async function turn(handlers: Map<string, Handler>, ctx: unknown): Promise<string[]> {
	const options = { contextFiles: [{ path: "/repo/AGENTS.md", content: CONTRACT_AGENTS_MD }] };
	const result = await handlers.get("before_agent_start")!({ systemPromptOptions: options }, ctx);
	assert.equal(result, undefined, "never returns a replacement prompt");
	return options.contextFiles.map((file) => file.content);
}

function uiContext(cwd: string, answers: Array<string | undefined>, hasUI = true) {
	const asked: Array<{ title: string; options: string[] }> = [];
	const notes: string[] = [];
	return {
		asked,
		notes,
		ctx: {
			cwd,
			hasUI,
			ui: {
				select: async (title: string, options: string[]) => {
					asked.push({ title, options });
					return answers.shift();
				},
				notify: (message: string) => notes.push(message),
			},
		},
	};
}

test("the extension registers session_start and before_agent_start and exports a default", () => {
	assert.deepEqual([...hooks().keys()].sort(), ["before_agent_start", "session_start"]);
	assert.equal(typeof orcaStackExtension, "function");
});

test("S3/S7: a stored off drops the contract from the next turn; on keeps it; flipping applies without restart", async () => {
	const { cwd } = project({ local: '{"gentleShell":"off"}' });
	const handlers = hooks();
	const { ctx } = uiContext(cwd, []);
	assert.deepEqual(await turn(handlers, ctx), ["# Rules\n## Project rules\nY"]);
	writeOrcaStackChoice(cwd, "on");
	assert.deepEqual(await turn(handlers, ctx), [CONTRACT_AGENTS_MD]);
	writeOrcaStackChoice(cwd, "off");
	assert.deepEqual(await turn(handlers, ctx), ["# Rules\n## Project rules\nY"]);
});

test("S4: outside an orca-stack project nothing is asked and nothing is filtered", async () => {
	const { cwd } = project({ orca: false, local: '{"gentleShell":"off"}' });
	const handlers = hooks();
	const { ctx, asked } = uiContext(cwd, ["off"]);
	await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
	assert.deepEqual(await turn(handlers, ctx), [CONTRACT_AGENTS_MD]);
	assert.equal(asked.length, 0);
});

test("S6: the first interactive session asks once, stores the answer, and applies it from the same session", async () => {
	const { cwd, local } = project({ local: '{"provider":"claude"}' });
	const handlers = hooks();
	const { ctx, asked } = uiContext(cwd, [ORCA_STACK_OPTIONS.off]);
	await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
	assert.deepEqual(await turn(handlers, ctx), ["# Rules\n## Project rules\nY"]);
	assert.deepEqual(asked, [{ title: ORCA_STACK_QUESTION, options: [ORCA_STACK_OPTIONS.on, ORCA_STACK_OPTIONS.off] }]);
	assert.deepEqual(JSON.parse(readFileSync(local, "utf8")), { provider: "claude", gentleShell: "off" });
	// A stored choice is never asked again, in this or a later session.
	await handlers.get("session_start")!({ type: "session_start", reason: "new" }, ctx);
	await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, uiContext(cwd, []).ctx);
	await hooks().get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
	assert.equal(asked.length, 1);
});

test("S6: choosing on stores on; dismissing stores nothing, keeps the contract, and is not asked again this session", async () => {
	const onProject = project();
	const handlers = hooks();
	const onCtx = uiContext(onProject.cwd, [ORCA_STACK_OPTIONS.on]).ctx;
	await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, onCtx);
	assert.deepEqual(await turn(handlers, onCtx), [CONTRACT_AGENTS_MD], "the first turn waits for the answer");
	assert.equal(readOrcaStackChoice(onProject.cwd), "on");

	const dismissed = project();
	const again = hooks();
	const { ctx, asked } = uiContext(dismissed.cwd, [undefined]);
	await again.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
	assert.deepEqual(await turn(again, ctx), [CONTRACT_AGENTS_MD]);
	await again.get("session_start")!({ type: "session_start", reason: "new" }, ctx);
	assert.equal(asked.length, 1);
	assert.throws(() => readFileSync(dismissed.local), /ENOENT/);
});

test("S6: headless, autonomous and child sessions are never asked; a stored value applies, none keeps the contract", async () => {
	for (const [env, hasUI] of [[{}, false], [{ GENTLE_PI_AUTONOMOUS_MODE: "1" }, true], [{ GENTLE_PI_AGENTS_CHILD: "1" }, true]] as const) {
		const unset = project();
		const handlers = hooks(env);
		const { ctx, asked } = uiContext(unset.cwd, [ORCA_STACK_OPTIONS.off], hasUI);
		await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
		assert.deepEqual(await turn(handlers, ctx), [CONTRACT_AGENTS_MD], JSON.stringify(env));
		assert.equal(asked.length, 0, JSON.stringify(env));

		const stored = project({ local: '{"gentleShell":"off"}' });
		assert.deepEqual(await turn(handlers, uiContext(stored.cwd, [], hasUI).ctx), ["# Rules\n## Project rules\nY"], JSON.stringify(env));
	}
});

test("S6: a write failure is reported, not thrown, and the contract stays", async () => {
	const { cwd } = project({ local: "{broken" });
	const handlers = hooks();
	const { ctx, notes } = uiContext(cwd, [ORCA_STACK_OPTIONS.off]);
	await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
	assert.deepEqual(await turn(handlers, ctx), [CONTRACT_AGENTS_MD]);
	assert.equal(notes.length, 1);
	assert.match(notes[0]!, /orca-stack/);
});

test("the hooks never throw on missing context or options", async () => {
	const handlers = hooks();
	await assert.doesNotReject(async () => handlers.get("session_start")!({}, {}));
	await assert.doesNotReject(async () => handlers.get("before_agent_start")!({}, {}));
	await assert.doesNotReject(async () => handlers.get("before_agent_start")!({ systemPromptOptions: null }, { cwd: project({ local: '{"gentleShell":"off"}' }).cwd }));
});

// --- odd/tasks/orca-main-autonomo.md G3: a linked worktree reads the main checkout's choice

function linkedWorktree(options: { main?: string; linked?: string } = {}): { main: string; linked: string; cwd: string } {
	const base = join(scratch, `w${fixtureCount++}`);
	const main = join(base, "main"), linked = join(base, "linked");
	mkdirSync(main, { recursive: true });
	const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });
	git(main, "init", "-q");
	writeFileSync(join(main, ".orca-stack.json"), "{}\n");
	git(main, "add", ".orca-stack.json"); git(main, "commit", "-qm", "base");
	git(main, "worktree", "add", "-q", "-b", `worker${fixtureCount}`, linked);
	if (options.main !== undefined) writeFileSync(join(main, ".orca-stack.local.json"), options.main);
	if (options.linked !== undefined) writeFileSync(join(linked, ".orca-stack.local.json"), options.linked);
	const cwd = join(linked, "packages", "app");
	mkdirSync(cwd, { recursive: true });
	return { main, linked, cwd };
}

test("G3 example: a linked worktree without the file uses the main checkout's choice, and the picker stays closed", async () => {
	const { cwd, linked } = linkedWorktree({ main: '{"gentleShell":"on"}' });
	assert.equal(readOrcaStackChoice(cwd), "on");
	assert.equal(readOrcaStackChoice(linked), "on");
	const handlers = hooks();
	const { ctx, asked } = uiContext(cwd, [ORCA_STACK_OPTIONS.off]);
	await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
	assert.deepEqual(await turn(handlers, ctx), [CONTRACT_AGENTS_MD]);
	assert.equal(asked.length, 0, "no picker");
	assert.equal(readOrcaStackChoice(linkedWorktree({ main: '{"gentleShell":"off"}', linked: '{"provider":"claude"}' }).cwd), "off", "a local file without gentleShell falls back too");
});

test("G3: the worktree's own choice wins over the main checkout's", () => {
	assert.equal(readOrcaStackChoice(linkedWorktree({ main: '{"gentleShell":"on"}', linked: '{"gentleShell":"off"}' }).cwd), "off");
	assert.equal(readOrcaStackChoice(linkedWorktree({ main: '{"gentleShell":"off"}', linked: '{"gentleShell":"on"}' }).cwd), "on");
});

test("G3 negative: neither file has the choice, so the picker shows as today", async () => {
	for (const options of [{}, { main: '{"provider":"claude"}' }, { main: "{broken" }, { main: '{"gentleShell":"OFF"}' }]) {
		const { cwd } = linkedWorktree(options);
		assert.equal(readOrcaStackChoice(cwd), undefined, JSON.stringify(options));
		const { ctx, asked } = uiContext(cwd, [undefined]);
		await hooks().get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
		assert.equal(asked.length, 1, JSON.stringify(options));
	}
	assert.equal(readOrcaStackChoice(project({ gitFile: true }).cwd), undefined, "a broken gitdir chain reads as not chosen and never throws");
});
