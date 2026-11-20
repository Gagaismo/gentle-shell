// Personal fork feature (odd/tasks/orca-main-autonomo.md G2): a worker that
// orca-stack dispatched answers RDD consent from orca-stack's policy instead of
// asking the human. orca-stack writes
// `<per-worktree git dir>/orca-stack/rdd-consentimiento.json` =
// `{"version":1,"granted":["<sha>",...]}`; the answer is `granted` when the
// worktree HEAD is listed, else `declined`. It applies only when the host pi
// process carries GENTLE_PI_ORCA_RDD_POLICY=1, which orca-stack sets at launch.
// Any other content, a missing file, or the main checkout (`.git` as a
// directory) leaves today's behaviour.

import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { worktreeGitEnvironment } from "./session-worktree-registry.ts";

export type OrcaStackConsentAnswer = "granted" | "declined";
export interface OrcaStackConsentPolicy { answer: OrcaStackConsentAnswer; head: string; path: string }

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** The tool-result note that says the policy, not a human, answered. */
export const ORCA_STACK_CONSENT_ANSWERED = (answer: OrcaStackConsentAnswer, path: string): string =>
	`orca-stack policy answered ${answer} (${path}); no consent dialog was shown.`;

/** The pure decision: undefined unless the file is exactly version 1 with a string `granted` list and HEAD is a sha. */
export function decideOrcaStackConsent(text: string, head: string): OrcaStackConsentAnswer | undefined {
	if (!SHA.test(head)) return undefined;
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { return undefined; }
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const { version, granted } = parsed as Record<string, unknown>;
	if (version !== 1 || !Array.isArray(granted) || !granted.every(item => typeof item === "string")) return undefined;
	return granted.some(item => item.toLowerCase() === head.toLowerCase()) ? "granted" : "declined";
}

function revParse(cwd: string): Promise<{ toplevel: string; gitDir: string; head: string } | undefined> {
	return new Promise(done => {
		try {
			execFile("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--verify", "HEAD^{commit}"],
				{ cwd, encoding: "utf8", timeout: 2_000, maxBuffer: 16 * 1024, windowsHide: true, env: worktreeGitEnvironment() },
				(error, stdout) => {
					const [toplevel, gitDir, head] = String(stdout ?? "").trim().split(/\r?\n/);
					done(!error && toplevel && gitDir && head ? { toplevel, gitDir, head } : undefined);
				});
		} catch { done(undefined); }
	});
}

// Opt-in (review R1): every file the worker can read it can also write (its worktree, its git dir, its local
// refs), so the trust anchor is the host process environment. orca-stack launches pi with
// GENTLE_PI_ORCA_RDD_POLICY=1 only under its consent policy; the agent's own commands run as child processes and
// cannot set it on their host. Without it, the dialog shows as today.
export const ORCA_STACK_RDD_POLICY_ENV = "GENTLE_PI_ORCA_RDD_POLICY";

/** The policy answer for the worktree holding `cwd`, or undefined to keep today's behaviour. Never throws. */
export async function readOrcaStackConsentPolicy(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<OrcaStackConsentPolicy | undefined> {
	if (env[ORCA_STACK_RDD_POLICY_ENV] !== "1") return undefined;
	try {
		const git = await revParse(cwd);
		if (git === undefined) return undefined;
		// Only a linked worktree (its `.git` is a file) carries a per-worktree policy.
		if (!(await lstat(join(git.toplevel, ".git"))).isFile()) return undefined;
		const path = join(git.gitDir, "orca-stack", "rdd-consentimiento.json");
		const answer = decideOrcaStackConsent(await readFile(path, "utf8"), git.head);
		return answer === undefined ? undefined : { answer, head: git.head, path };
	} catch {
		return undefined;
	}
}
