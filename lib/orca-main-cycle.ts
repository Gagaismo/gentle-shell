// Port of orca-stack's Claude Code mod `main-md` (#13): with the orca-stack
// toggle on, a primary session in the main checkout of an orca-stack project
// gets MAIN.md's ### Ciclo de `main` section appended to its system prompt.
// Pi has no 10,000-character cap on that text, so the section goes in whole.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findWorktreeRoot, orcaStackLocalPath, readOrcaStackChoice } from "./orca-stack-toggle.ts";

export const MAIN_CYCLE_HEADING = "### Ciclo de `main`";

// #13 R2: as main-md does, ORCA_STACK_POLICY_PATH names ORCA-STACK.md and MAIN.md sits beside it.
export function mainDocPath(env: NodeJS.ProcessEnv, home: string = osHomedir()): string {
	const policy = env.ORCA_STACK_POLICY_PATH?.trim();
	if (policy) return join(dirname(policy), "MAIN.md");
	return join(home, "orca", "stack", "MAIN.md");
}

export function cutMainCycle(doc: string): string | undefined {
	const lines = doc.replace(/\r\n/g, "\n").split("\n");
	const first = lines.findIndex((line) => line.trim() === MAIN_CYCLE_HEADING);
	if (first === -1) return undefined;
	const after = lines.slice(first + 1).findIndex((line) => /^#{1,3} /.test(line));
	const end = after === -1 ? lines.length : first + 1 + after;
	return lines.slice(first, end).join("\n").trimEnd();
}

/** The text to append for the MAIN.md at path; a missing file or section yields one short line (#13 R4). */
export function mainCycleText(doc: string | undefined, path: string): string {
	if (doc === undefined) return `orca-stack: MAIN.md missing or unreadable at ${path}; follow the contract's pointer to MAIN.md.`;
	const cycle = cutMainCycle(doc);
	if (cycle === undefined) return `orca-stack: section ${MAIN_CYCLE_HEADING} not found in ${path}; follow the contract's pointer to MAIN.md.`;
	return `The steps of ${MAIN_CYCLE_HEADING} from ${path}, the MAIN.md the AGENTS.md contract points to; its other sections are in that file.\n\n${cycle}`;
}

export function readMainCycleText(path: string): string {
	let doc: string | undefined;
	try {
		doc = existsSync(path) ? readFileSync(path, "utf8") : undefined;
	} catch {
		doc = undefined;
	}
	return mainCycleText(doc, path);
}

/**
 * #13 R3: the main checkout is the one whose git dir equals its common dir: a `.git` directory, or a
 * `.git` file (`--separate-git-dir`) whose git dir has no `commondir` or one that resolves to itself.
 */
export function isMainCheckout(cwd: string): boolean {
	try {
		const root = findWorktreeRoot(cwd);
		if (root === undefined) return false;
		const dotGit = join(root, ".git");
		if (statSync(dotGit).isDirectory()) return true;
		const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
		if (pointer === undefined) return false;
		const gitDir = resolve(root, pointer);
		const commonDirFile = join(gitDir, "commondir");
		if (!existsSync(commonDirFile)) return true;
		return resolve(gitDir, readFileSync(commonDirFile, "utf8").trim()) === gitDir;
	} catch {
		return false;
	}
}

function stringAt(value: unknown, path: string[]): string | undefined {
	let current = value;
	for (const key of path) {
		if (typeof current !== "object" || current === null) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "string" ? current : undefined;
}

// #13 R3: the same named-agent predicate as gentle-ai.ts `readAgentStartNames`, kept here so the fork never imports core.
export function isNamedAgentStart(event: unknown): boolean {
	return [["agentName"], ["agent"], ["name"], ["agent", "name"], ["subagent", "name"]].some(
		(path) => (stringAt(event, path)?.trim() ?? "") !== "",
	);
}

/** The block to append this turn, or undefined when the session does not get it (#13 R1, R3). Never throws. */
export function mainCycleInjection(cwd: string, event: unknown, env: NodeJS.ProcessEnv, home?: string): string | undefined {
	try {
		if (env.GENTLE_PI_AGENTS_CHILD === "1" || isNamedAgentStart(event)) return undefined;
		if (orcaStackLocalPath(cwd) === undefined || readOrcaStackChoice(cwd) === "off" || !isMainCheckout(cwd)) return undefined;
		return readMainCycleText(mainDocPath(env, home));
	} catch {
		return undefined;
	}
}
