// Personal fork feature (odd/tasks/orca-stack-toggle.md): per project, choose
// whether a Gentle Shell session sees the orca-stack contract, the blocks
// between `<!-- orca-stack:begin -->` and `<!-- orca-stack:end -->` in its
// context files. The choice is `"gentleShell": "on" | "off"` in
// `<worktree-root>/.orca-stack.local.json` (orca-stack's git-ignored local
// layer) and exists only where `<worktree-root>/.orca-stack.json` exists. Only
// the injected context is filtered; every file on disk keeps its blocks.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContextFile, ContextFileOptions, ManagedBlockFilterResult } from "./child-context-files.ts";

export type OrcaStackChoice = "on" | "off";

export const ORCA_STACK_CONFIG_FILE = ".orca-stack.json";
export const ORCA_STACK_LOCAL_FILE = ".orca-stack.local.json";
export const ORCA_STACK_CHOICE_KEY = "gentleShell";

// The same robustness rules as the gentle-ai managed-block filter
// (lib/child-context-files.ts), which is bound to `gentle-ai:` markers: a
// marker counts only alone on its line, fenced code is plain text, and an
// unbalanced or reopened block leaves the file unchanged.
const MARKER_LINE = /^[ \t]*<!--[ \t]*orca-stack:(begin|end)[ \t]*-->[ \t]*$/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const BLANK_LINE = /^[ \t]*\r?\n?$/;

function splitLines(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function filterOrcaStackBlocks(content: string): ManagedBlockFilterResult {
	const lines: Array<{ text: string; removed: boolean }> = [];
	let open = false;
	let fence: { char: string; length: number } | null = null;
	let removedBlocks = 0;

	for (const text of splitLines(content)) {
		const bare = text.replace(/\r?\n$/, "");
		const fenceMatch = FENCE_LINE.exec(bare);
		if (fence !== null) {
			if (fenceMatch !== null && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length && fenceMatch[2].trim() === "") {
				fence = null;
			}
			lines.push({ text, removed: open });
			continue;
		}
		if (fenceMatch !== null && !(fenceMatch[1][0] === "`" && fenceMatch[2].includes("`"))) {
			fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
			lines.push({ text, removed: open });
			continue;
		}
		const marker = MARKER_LINE.exec(bare);
		if (marker === null) {
			lines.push({ text, removed: open });
			continue;
		}
		if (marker[1] === "begin") {
			if (open) return { content, removedBlocks: 0, failSafe: true };
			open = true;
			removedBlocks += 1;
		} else if (!open) {
			return { content, removedBlocks: 0, failSafe: true };
		}
		lines.push({ text, removed: true });
		if (marker[1] === "end") open = false;
	}
	if (open) return { content, removedBlocks: 0, failSafe: true };
	if (removedBlocks === 0) return { content, removedBlocks: 0, failSafe: false };

	// Blank lines right after a removal collapse to at most one at that seam; a
	// removal at the start or end of the file leaves no blank edge behind.
	const output: string[] = [];
	let trailingBlanks = 0;
	let afterRemoval = false;
	for (const line of lines) {
		if (line.removed) {
			afterRemoval = true;
			continue;
		}
		const blank = BLANK_LINE.test(line.text);
		if (afterRemoval && blank && (output.length === 0 || trailingBlanks >= 1)) continue;
		if (!blank) afterRemoval = false;
		output.push(line.text);
		trailingBlanks = blank ? trailingBlanks + 1 : 0;
	}
	if (afterRemoval) {
		while (output.length > 0 && BLANK_LINE.test(output[output.length - 1])) output.pop();
	}
	return { content: output.join(""), removedBlocks, failSafe: false };
}

/**
 * Replaces contextFiles on the SAME options object (pi-claude-bridge rebuilds
 * its prompt from it) with filtered copies; entries are never mutated. Returns
 * the removed block count. Never throws; on any error the files stay in place.
 */
export function filterOrcaStackContextFiles(options: ContextFileOptions | null | undefined): number {
	try {
		if (!options || !Array.isArray(options.contextFiles)) return 0;
		let removed = 0;
		const files: ContextFile[] = options.contextFiles.map((file) => {
			const filtered = filterOrcaStackBlocks(file.content);
			if (filtered.removedBlocks === 0) return file;
			removed += filtered.removedBlocks;
			return { ...file, content: filtered.content };
		});
		if (removed > 0) options.contextFiles = files;
		return removed;
	} catch {
		return 0;
	}
}

/** The git worktree root: the nearest ancestor holding `.git` (a directory, or a linked worktree's file). */
export function findWorktreeRoot(cwd: string): string | undefined {
	let current = cwd;
	for (;;) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** The local config path of an orca-stack project, or undefined when cwd is not in one (S4). */
export function orcaStackLocalPath(cwd: string): string | undefined {
	try {
		const root = findWorktreeRoot(cwd);
		if (root === undefined || !existsSync(join(root, ORCA_STACK_CONFIG_FILE))) return undefined;
		return join(root, ORCA_STACK_LOCAL_FILE);
	} catch {
		return undefined;
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The stored choice; undefined when not an orca-stack project, not chosen, unreadable, or not "on"/"off" (S5). */
export function readOrcaStackChoice(cwd: string): OrcaStackChoice | undefined {
	try {
		const path = orcaStackLocalPath(cwd);
		if (path === undefined || !existsSync(path)) return undefined;
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		const value = isPlainObject(parsed) ? parsed[ORCA_STACK_CHOICE_KEY] : undefined;
		return value === "on" || value === "off" ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Merges the choice into `.orca-stack.local.json`, creating it when missing and
 * keeping every other key. Returns an error message instead of throwing; a file
 * that is not a JSON object is never overwritten.
 */
export function writeOrcaStackChoice(cwd: string, choice: OrcaStackChoice): string | undefined {
	try {
		const path = orcaStackLocalPath(cwd);
		if (path === undefined) return `orca-stack: ${cwd} is not an orca-stack project (no ${ORCA_STACK_CONFIG_FILE} at its git root).`;
		let current: Record<string, unknown> = {};
		if (existsSync(path)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				parsed = undefined;
			}
			if (!isPlainObject(parsed)) return `orca-stack: ${path} is not a JSON object; fix or remove it, then choose again.`;
			current = parsed;
		}
		writeFileSync(path, `${JSON.stringify({ ...current, [ORCA_STACK_CHOICE_KEY]: choice }, null, 2)}\n`);
		return undefined;
	} catch (error) {
		return `orca-stack: choice not saved: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/** Only an interactive primary session asks the first-time question (S6). */
export function shouldAskOrcaStackChoice(ctx: { hasUI?: boolean }, env: NodeJS.ProcessEnv): boolean {
	return ctx.hasUI === true && env.GENTLE_PI_AUTONOMOUS_MODE !== "1" && env.GENTLE_PI_AGENTS_CHILD !== "1";
}

/** The `/gentle:profiles` panel's view of the toggle (S2); undefined outside an orca-stack project. */
export interface OrcaStackPanelControl {
	/** The effective state: no stored choice keeps the contract, so it reads "on". */
	read(): OrcaStackChoice;
	/** Stores the choice; returns an error message when it refuses. */
	write(choice: OrcaStackChoice): string | undefined;
}

export function orcaStackPanelControl(cwd: string): OrcaStackPanelControl | undefined {
	if (orcaStackLocalPath(cwd) === undefined) return undefined;
	return {
		read: () => readOrcaStackChoice(cwd) ?? "on",
		write: (choice) => writeOrcaStackChoice(cwd, choice),
	};
}
