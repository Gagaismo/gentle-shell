import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ContextFileOptions } from "../lib/child-context-files.ts";
import {
	filterOrcaStackContextFiles,
	orcaStackLocalPath,
	readOrcaStackChoice,
	shouldAskOrcaStackChoice,
	writeOrcaStackChoice,
	type OrcaStackChoice,
} from "../lib/orca-stack-toggle.ts";

// Personal fork feature (odd/tasks/orca-stack-toggle.md). In a project whose
// git root has .orca-stack.json, a stored `"gentleShell": "off"` drops the
// orca-stack contract blocks from every turn's injected context files (S3, S7);
// the first interactive primary session with no stored choice asks once (S6).
// The toggle itself lives in /gentle:profiles (extensions/gentle-ai.ts).

export const ORCA_STACK_QUESTION = "orca-stack in this project?";
export const ORCA_STACK_OPTIONS: Record<OrcaStackChoice, string> = {
	on: "on · use orca-stack with Gentle Shell",
	off: "off · plain Gentle Shell (hide the orca-stack contract)",
};

interface HookContext {
	cwd?: string;
	hasUI?: boolean;
	ui?: {
		select?: (title: string, options: string[]) => Promise<string | undefined>;
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
	};
}

export function createOrcaStackExtension(env: NodeJS.ProcessEnv = process.env): (pi: ExtensionAPI) => void {
	return (pi) => {
		// One question per project root per process, answered or dismissed.
		const asked = new Set<string>();
		let pending: Promise<void> | undefined;

		const ask = async (ctx: HookContext, cwd: string, path: string): Promise<void> => {
			try {
				const picked = await ctx.ui!.select!(ORCA_STACK_QUESTION, [ORCA_STACK_OPTIONS.on, ORCA_STACK_OPTIONS.off]);
				const choice = picked === ORCA_STACK_OPTIONS.off ? "off" : picked === ORCA_STACK_OPTIONS.on ? "on" : undefined;
				if (choice === undefined) return;
				const error = writeOrcaStackChoice(cwd, choice);
				if (error !== undefined) ctx.ui?.notify?.(error, "warning");
				else ctx.ui?.notify?.(`orca-stack ${choice} for this project (${path}); change it in /gentle:profiles.`, "info");
			} catch {
				// A dismissed or failed dialog keeps today's behavior: the contract stays.
			}
		};

		pi.on("session_start", (_event, rawCtx) => {
			try {
				const ctx = rawCtx as HookContext | undefined;
				const cwd = ctx?.cwd;
				if (!ctx || typeof cwd !== "string" || !shouldAskOrcaStackChoice(ctx, env) || typeof ctx.ui?.select !== "function") return;
				const path = orcaStackLocalPath(cwd);
				if (path === undefined || asked.has(path) || readOrcaStackChoice(cwd) !== undefined) return;
				asked.add(path);
				// Not awaited: startup goes on; the first turn waits for the answer.
				pending = ask(ctx, cwd, path).finally(() => { pending = undefined; });
			} catch {
				// Never block or break session start.
			}
		});

		pi.on("before_agent_start", async (event, rawCtx) => {
			try {
				if (pending !== undefined) await pending;
				const cwd = (rawCtx as HookContext | undefined)?.cwd;
				if (typeof cwd !== "string" || readOrcaStackChoice(cwd) !== "off") return undefined;
				filterOrcaStackContextFiles((event as { systemPromptOptions?: ContextFileOptions | null } | undefined)?.systemPromptOptions);
			} catch {
				// Never throws; the original context files stay.
			}
			return undefined;
		});
	};
}

export default function orcaStackExtension(pi: ExtensionAPI): void {
	createOrcaStackExtension()(pi);
}
