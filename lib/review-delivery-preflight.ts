import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, resolve, win32 } from "node:path";
import { NATIVE_UNTRACKED_SCOPE, normalizeNativeReviewCwd, type NativeReviewCli } from "./native-review-cli.ts";
import { recognizeReviewDeliveryActions, type ReviewDeliveryMerge } from "./destructive-command-guard.ts";
import { resolvePiScriptFromCmd } from "./agents-runner.ts";
import { findWorktreeRoot, ORCA_STACK_CONFIG_FILE } from "./orca-stack-toggle.ts";
import { resolveSessionWorktree, worktreeGitEnvironment } from "./session-worktree-registry.ts";

type Denial = { block: true; reason: string };
const deny = (reason: string): Denial => ({ block: true, reason: `RDD pre-delivery: ${reason} This delivery command was not run. Review outcomes do not authorize delivery.` });

// Compare HEAD/base around this read, without retaining a verdict or snapshot.
async function identity(root: string, baseRef: string): Promise<string | undefined> {
	return new Promise(done => execFile("git", ["rev-parse", "--revs-only", "--end-of-options", "HEAD^{commit}", `${baseRef}^{commit}`],
		{ cwd: root, encoding: "utf8", timeout: 2_000, maxBuffer: 4096, windowsHide: true, env: worktreeGitEnvironment() },
		(error, stdout) => {
			const ids = stdout.trim().split(/\r?\n/);
			done(!error && ids.length === 2 && ids.every(id => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id)) ? ids.join("\n") : undefined);
		}));
}

/**
 * gentle-shell#3169: native assess refuses a committed-only range while any
 * untracked file exists (a PR body written for `gh pr create --body-file`)
 * unless the untracked inventory is declared. A base-diff snapshot never
 * includes untracked files, so excluding them leaves the assessed range
 * unchanged. The digest comes only from native status; without it nothing is
 * declared and native keeps deciding.
 */
export async function committedRangeUntrackedExclusion(cli: Pick<NativeReviewCli, "targetStatus"> | null | undefined, cwd: string, baseRef: string,
	signal?: AbortSignal): Promise<{ untrackedScope?: typeof NATIVE_UNTRACKED_SCOPE.EXCLUDE; expectedUntrackedInventory?: string }> {
	if (!cli?.targetStatus) return {};
	try {
		const inventory = (await cli.targetStatus({ cwd, baseRef, committedOnly: true, agent: "pi", ...(signal ? { signal } : {}) })).eligibleUntrackedInventory;
		return typeof inventory === "string" && inventory ? { untrackedScope: NATIVE_UNTRACKED_SCOPE.EXCLUDE, expectedUntrackedInventory: inventory } : {};
	} catch { return {}; }
}

/** The raw result of `orca-stack estado <n> --json`: exit code and stdout, or why it could not run. */
export type OrcaStackEstadoRun = { exitCode: number; stdout: string } | { error: string };
/** Runs `orca-stack estado <pr> --json` in an orca-stack root (odd/tasks/orca-main-autonomo.md G1). */
export type OrcaStackAttest = (root: string, pr: number, signal: AbortSignal) => Promise<OrcaStackEstadoRun>;

const ESTADO_TIMEOUT_MS = 25_000;
const ATTESTED_PREFLIGHT_MS = 30_000;

/**
 * The executable and fixed leading arguments for `orca-stack`. On Windows an
 * npm-style `orca-stack.cmd` shim is resolved to its Node script, so no
 * argument ever passes through cmd.exe.
 */
function orcaStackCommand(env: NodeJS.ProcessEnv): { command: string; args: string[] } | undefined {
	if (process.platform !== "win32") return { command: "orca-stack", args: [] };
	for (const entry of (env.Path ?? env.PATH ?? "").split(delimiter)) {
		const dir = entry.replace(/^"(.*)"$/, "$1");
		if (!dir) continue;
		const exe = win32.join(dir, "orca-stack.exe");
		if (existsSync(exe)) return { command: exe, args: [] };
		for (const ext of [".cmd", ".bat"]) {
			const shim = win32.join(dir, `orca-stack${ext}`);
			if (!existsSync(shim)) continue;
			const script = resolvePiScriptFromCmd(shim);
			if (script && /\.[cm]?js$/i.test(script) && !/pi-coding-agent|pi-launcher/i.test(script)) return { command: process.execPath, args: [script] };
		}
	}
	return undefined;
}

/** The default attestation runner: fixed argv, no shell, bounded time and output. */
export function runOrcaStackEstado(root: string, pr: number, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<OrcaStackEstadoRun> {
	const resolved = orcaStackCommand(env);
	if (!resolved) return Promise.resolve({ error: "orca-stack not found on PATH" });
	return new Promise(done => {
		try {
			execFile(resolved.command, [...resolved.args, "estado", String(pr), "--json"],
				{ cwd: root, env, encoding: "utf8", timeout: ESTADO_TIMEOUT_MS, maxBuffer: 256 * 1024, windowsHide: true, shell: false, signal },
				(error, stdout) => {
					const code = (error as { code?: unknown } | null)?.code;
					if (error && typeof code === "number") return done({ exitCode: code, stdout: String(stdout ?? "") });
					if (error) return done({ error: (error as { killed?: boolean }).killed || signal.aborted ? "timed out or cancelled" : code === "ENOENT" ? "orca-stack not found on PATH" : error.message });
					done({ exitCode: 0, stdout: String(stdout ?? "") });
				});
		} catch (error) { done({ error: error instanceof Error ? error.message : String(error) }); }
	});
}

const MERGE_METHODS = new Set(["--merge", "--squash", "--rebase"]);

/** Why a `gh pr merge` command shape cannot be attested, or its PR and pinned head. */
function attestableMerge(merge: ReviewDeliveryMerge): { pr: number; head: string } | string {
	if (!merge.plain) return "the merge must be a single foreground `gh pr merge` command, optionally after a literal cd, with no prefix, wrapper or following command";
	const [pr, verb, ...rest] = merge.args;
	if (pr !== "pr" || verb !== "merge") return "-R/--repo or another gh global flag is not allowed";
	let number: string | undefined, head: string | undefined, methods = 0;
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (/^\d+$/.test(arg) && number === undefined) number = arg;
		else if (MERGE_METHODS.has(arg)) methods++;
		else if (arg === "--delete-branch" || arg === "-d") return "--delete-branch is not allowed: it deletes the remote branch, which needs the human";
		else if (arg === "--match-head-commit" && head === undefined && index + 1 < rest.length) head = rest[++index];
		else if (arg.startsWith("--match-head-commit=") && head === undefined) head = arg.slice("--match-head-commit=".length);
		else if (["--admin", "--auto", "-R", "--repo"].includes(arg) || /^--(?:admin|auto|repo)=/.test(arg)) return `${arg.split("=")[0]} is not allowed`;
		else return `argument ${JSON.stringify(arg)} is not allowed`;
	}
	if (number === undefined || !Number.isSafeInteger(Number(number)) || Number(number) <= 0) return "the merge names no PR number";
	if (methods !== 1) return "the merge needs exactly one of --merge, --squash or --rebase";
	if (head === undefined) return "the merge has no --match-head-commit <sha>";
	if (!/^[0-9a-f]{40}$/i.test(head)) return "--match-head-commit must be a 40-character hexadecimal sha";
	return { pr: Number(number), head: head.toLowerCase() };
}

/** Why an `orca-stack estado <pr> --json` run does not attest this merge, or undefined when it does. */
export function orcaStackAttestationFailure(run: OrcaStackEstadoRun, pr: number, head: string): string | undefined {
	if ("error" in run) return `could not run orca-stack estado: ${run.error}`;
	let parsed: unknown;
	try { parsed = JSON.parse(run.stdout); } catch { parsed = undefined; }
	const record = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	if (record?.ok === false) {
		const falta = Array.isArray(record.falta) ? record.falta.filter((item): item is string => typeof item === "string") : [];
		return `orca-stack estado says the PR is not ok: ${falta.length ? falta.join("; ") : "no reason given"}`;
	}
	if (run.exitCode !== 0) return `orca-stack estado exited with code ${run.exitCode}`;
	if (!record) return "orca-stack estado output is not one JSON object";
	if (record.pr !== pr) return `orca-stack estado answered for PR ${String(record.pr)}, not ${pr}`;
	if (record.ok !== true) return "orca-stack estado did not report ok: true";
	if (typeof record.head !== "string" || !/^[0-9a-f]{40}$/i.test(record.head)) return "orca-stack estado reported no 40-character head";
	if (record.head.toLowerCase() !== head) return `orca-stack estado attests head ${record.head.toLowerCase()}, but --match-head-commit is ${head}`;
	return undefined;
}

/** One fresh check per repository/batch. The existing session registry supplies only a base-ref hint. */
export async function checkReviewDeliveryPreflight(cwd: string, toolName: string, command: string, cli: NativeReviewCli | null,
	baseRefFor: (root: string) => string | undefined, declined: (root: string, target: string) => boolean,
	signal?: AbortSignal, current: () => boolean = () => true, attest?: OrcaStackAttest): Promise<Denial | undefined> {
	const actions = recognizeReviewDeliveryActions(command), deliveries = actions.filter(action => action.kind === "delivery");
	if (!deliveries.length || !cli?.reviewMode) return undefined;
	// G1 (odd/tasks/orca-main-autonomo.md): only a command with a `gh pr merge`
	// delivery can carry an orca-stack attestation; every denial of such a
	// command says why the attestation did not apply.
	let attestation: { pr: number; head: string } | undefined, notApplied: string | undefined;
	if (deliveries.some(delivery => delivery.merge)) {
		const only = deliveries.length === 1 && actions.length === 1 ? deliveries[0] : undefined;
		const shape = !only?.merge ? "the merge must be the only delivery or candidate-changing action in the command"
			: toolName !== "bash" || only.background ? "the merge must run in the foreground bash tool"
			: only.unresolvedDirectory ? "the merge repository cannot be resolved"
			: !attest ? "no attestation runner is available" : attestableMerge(only.merge);
		if (typeof shape === "string") notApplied = shape; else attestation = shape;
	}
	const explain = (denial: Denial | undefined): Denial | undefined => denial && notApplied !== undefined
		? { block: true, reason: `${denial.reason} The orca-stack attestation did not apply: ${notApplied}.` } : denial;
	if (deliveries.some(delivery => delivery.unresolvedDirectory)) return explain(deny("The delivery repository cannot be resolved from this directory or Git/environment redirect; run delivery inside its repository or use literal cd or git -C."));
	if (signal?.aborted || !current()) return explain(deny("Preflight was cancelled or its session changed."));
	const bounded = AbortSignal.any([AbortSignal.timeout(attestation ? ATTESTED_PREFLIGHT_MS : 30_000), ...(signal ? [signal] : [])]);
	let abort!: () => void;
	const expired = new Promise<Denial>(done => { abort = () => done(deny("The bounded preflight was cancelled or timed out.")); bounded.addEventListener("abort", abort, { once: true }); });
	const run = async (): Promise<Denial | undefined> => {
		try {
			const checked: Array<{ root: string; baseRef: string; before: string }> = [];
			const roots = new Set(deliveries.map(delivery => {
				// Git Bash drive paths (`/c/repo`) name `C:\repo` on Windows; resolving them raw yields `C:\c\repo`.
				const target = (delivery.directories ?? []).reduce((base, directory) => resolve(base, normalizeNativeReviewCwd(directory)), cwd);
				return resolveSessionWorktree(target, cwd)?.root ?? target;
			}));
			if ([...roots].some(root => !existsSync(root))) return deny("The delivery repository cannot be resolved from this directory or Git/environment redirect; run delivery inside its repository or use literal cd or git -C.");
			for (const root of roots) {
				const mode = await cli.reviewMode!({ cwd: root, operation: "status", signal: bounded });
				if (bounded.aborted || !current()) return deny("Session changed during preflight; assess again.");
				if (mode.status.effective === "off") continue;
				if (mode.status.effective !== "on") return deny("RDD mode is unavailable; resolve it before delivery.");
				if (attestation) {
					const orcaRoot = findWorktreeRoot(root);
					if (orcaRoot === undefined || !existsSync(join(orcaRoot, ORCA_STACK_CONFIG_FILE))) notApplied = `no ${ORCA_STACK_CONFIG_FILE} at the repository root`;
					else {
						notApplied = orcaStackAttestationFailure(await attest!(orcaRoot, attestation.pr, bounded), attestation.pr, attestation.head);
						if (bounded.aborted || !current()) return deny("Session changed during preflight; assess again.");
						// GitHub itself refuses the merge if the PR head moved off the attested sha.
						if (notApplied === undefined) continue;
					}
				}
				if (toolName !== "bash" || deliveries.some(delivery => delivery.background) || actions.some(action => action.kind === "change")) return deny("Finish candidate-changing commands or background waits separately, then issue delivery so the resulting commits can be assessed.");
				const baseRef = baseRefFor(root);
				if (!baseRef) return deny('Select the actual committed range with gentle_review assess input {"baseRef":"<slice base>","committedOnly":true}.');
				const before = await identity(root, baseRef);
				if (!before || !cli.assess) return deny("The selected base or native assessment is unavailable; resolve it before delivery.");
				if (bounded.aborted || !current()) return deny("Session changed during preflight; assess again.");
				const untracked = await committedRangeUntrackedExclusion(cli, root, baseRef, bounded);
				if (bounded.aborted || !current()) return deny("Session changed during preflight; assess again.");
				const assessment = await cli.assess({ cwd: root, baseRef, committedOnly: true, ...untracked, signal: bounded });
				if (bounded.aborted || !current()) return deny("Session changed during preflight; assess again.");
				if (assessment.candidate.kind !== "base-diff" || assessment.candidate.baseRef !== baseRef || typeof assessment.reviewDue !== "boolean") return deny("Native assessment did not confirm the selected committed range.");
				if (assessment.reviewDue) {
					const status = await cli.targetStatus?.({ cwd: root, baseRef, committedOnly: true, agent: "pi", signal: bounded });
					if (!status || status.applicability !== "current_target" || status.projection.kind !== "base-diff" || !declined(root, status.targetIdentity)) return deny("Native assessment reports a due review. Resume the bound review or inspect and follow its native transitions and human consent before delivery.");
				}
				checked.push({ root, baseRef, before });
			}
			for (const { root, baseRef, before } of checked) {
				if (bounded.aborted || !current() || baseRefFor(root) !== baseRef || await identity(root, baseRef) !== before || !current()) return deny("The range or session changed during preflight; assess again.");
			}
			return undefined;
		} catch { return deny("Native preflight is unavailable; resolve it before delivery."); }
	};
	try { return explain(await Promise.race([run(), expired])); }
	finally { bounded.removeEventListener("abort", abort); }
}
