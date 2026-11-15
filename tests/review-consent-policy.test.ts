import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { setWindowsAclAuthorityForTesting } from "../lib/review-candidate-view-owner.ts";
import { CandidateViewRegistry } from "../lib/review-candidate-view.ts";
import { NativeReviewConsentRequiredError, type NativeReviewCli } from "../lib/native-review-cli.ts";
import { decodeReviewConsentV3, type ReviewStatusV3 } from "../lib/review-integration-v2.ts";
import {
	decideOrcaStackConsent,
	ORCA_STACK_CONSENT_ANSWERED,
	readOrcaStackConsentPolicy,
} from "../lib/review-consent-policy.ts";

// odd/tasks/orca-main-autonomo.md G2: an orca-stack worker's RDD consent is
// answered from `<per-worktree git dir>/orca-stack/rdd-consentimiento.json`.

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

test("G2 decision: granted only when HEAD is listed, declined otherwise", () => {
	assert.equal(decideOrcaStackConsent(JSON.stringify({ version: 1, granted: [HEAD] }), HEAD), "granted");
	assert.equal(decideOrcaStackConsent(JSON.stringify({ version: 1, granted: [HEAD.toUpperCase()] }), HEAD), "granted", "sha comparison ignores case");
	assert.equal(decideOrcaStackConsent(JSON.stringify({ version: 1, granted: [] }), HEAD), "declined");
	assert.equal(decideOrcaStackConsent(JSON.stringify({ version: 1, granted: [OTHER] }), HEAD), "declined");
});

test("G2 decision negatives: invalid JSON, wrong version or shape fall back to today's behaviour", () => {
	for (const text of ["", "{not json", "[]", "null", JSON.stringify({ version: 2, granted: [HEAD] }), JSON.stringify({ granted: [HEAD] }),
		JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, granted: HEAD }), JSON.stringify({ version: 1, granted: [42] })]) {
		assert.equal(decideOrcaStackConsent(text, HEAD), undefined, text);
	}
	assert.equal(decideOrcaStackConsent(JSON.stringify({ version: 1, granted: [HEAD] }), "not-a-sha"), undefined, "an unknown HEAD never answers");
});

test("G2: a linked worktree's policy file answers; the main checkout is never read", async t => {
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "review-consent-policy-")));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const main = join(scratch, "main"), linked = join(scratch, "linked");
	mkdirSync(main);
	const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
	git(main, "init", "-q"); writeFileSync(join(main, "a.txt"), "a\n"); git(main, "add", "."); git(main, "commit", "-qm", "base");
	git(main, "worktree", "add", "-q", "-b", "worker", linked);
	const head = git(linked, "rev-parse", "HEAD");
	const linkedGitDir = git(linked, "rev-parse", "--absolute-git-dir");
	const write = (gitDir: string, value: unknown) => { mkdirSync(join(gitDir, "orca-stack"), { recursive: true }); writeFileSync(join(gitDir, "orca-stack", "rdd-consentimiento.json"), typeof value === "string" ? value : JSON.stringify(value)); };

	assert.equal(await readOrcaStackConsentPolicy(linked), undefined, "no file keeps today's behaviour");
	write(linkedGitDir, { version: 1, granted: [] });
	assert.deepEqual(await readOrcaStackConsentPolicy(linked), { answer: "declined", head, path: join(linkedGitDir, "orca-stack", "rdd-consentimiento.json") });
	mkdirSync(join(linked, "sub"), { recursive: true });
	assert.equal((await readOrcaStackConsentPolicy(join(linked, "sub")))?.answer, "declined", "a nested cwd reads its worktree's file");
	write(linkedGitDir, { version: 1, granted: [head] });
	assert.equal((await readOrcaStackConsentPolicy(linked))?.answer, "granted");
	write(linkedGitDir, "{broken");
	assert.equal(await readOrcaStackConsentPolicy(linked), undefined, "invalid JSON keeps today's behaviour");
	write(linkedGitDir, { version: 9, granted: [head] });
	assert.equal(await readOrcaStackConsentPolicy(linked), undefined, "a wrong version keeps today's behaviour");

	write(join(main, ".git"), { version: 1, granted: [git(main, "rev-parse", "HEAD")] });
	assert.equal(await readOrcaStackConsentPolicy(main), undefined, "the main checkout (.git directory) is never read");
	assert.equal(await readOrcaStackConsentPolicy(join(scratch, "missing")), undefined, "outside a repository nothing answers");
	assert.match(ORCA_STACK_CONSENT_ANSWERED("declined", "/x/rdd-consentimiento.json"), /orca-stack policy answered declined/);
});

// --- host wiring: the real gentle_review controller --------------------------

let fixtureAclChecks = 0;
before(() => { if (process.platform === "win32") setWindowsAclAuthorityForTesting(() => { fixtureAclChecks++; }); });
after(() => setWindowsAclAuthorityForTesting());

function piConsent() {
	const raw = JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "devbinary", "consent-v3.captured.json"), "utf8")) as Record<string, unknown>;
	raw.agent = "pi";
	const decoded = decodeReviewConsentV3(raw, "pi");
	return { ...decoded, choices: [
		{ ...decoded.choices[0], invocation: decoded.choices[0].invocation.replace(" --consent ", " --agent pi --consent ") },
		{ ...decoded.choices[1], invocation: decoded.choices[1].invocation.replace(" --consent ", " --agent pi --consent ") },
	] as const };
}

function startStatus(cwd: string): ReviewStatusV3 {
	const views = new CandidateViewRegistry();
	const candidate = views.create({ contributorRoot: cwd });
	try {
		const digest = `sha256:${"a".repeat(64)}`;
		return { contract: "gentle-ai.review-integration/v2", applicability: "unrelated", action: "start", replayability: "not_replayable", targetIdentity: digest,
			projection: { schema: "gentle-ai.review-candidate-projection/v1", kind: "current-changes", projection: "workspace", baseTree: candidate.baseTree,
				initialReviewTree: candidate.candidateTree, currentCandidateTree: candidate.candidateTree, pathsDigest: digest, paths: [...candidate.paths],
				intendedUntracked: [], intendedUntrackedProof: digest, initialSnapshotIdentity: digest, currentSnapshotIdentity: digest },
			candidates: [], raw: { schema: "gentle-ai.review-integration.status/v5" } } as unknown as ReviewStatusV3;
	} finally { views.cleanup(candidate.token); }
}

function harness(cwd: string) {
	const tools = new Map<string, { execute(id: string, parameters: unknown, signal: undefined, onUpdate: undefined, context: ExtensionContext): Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> }>();
	const answers: string[] = [];
	const consent = piConsent();
	const native = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "", cloneLocal: "", effective: "on", source: "default" } }),
		targetStatus: async () => startStatus(cwd),
		start: async () => { throw new NativeReviewConsentRequiredError(consent); },
		answerConsent: async (request: { answer: "granted" | "declined" }) => {
			answers.push(request.answer);
			if (request.answer === "declined") return { kind: "declined", targetIdentity: consent.targetIdentity, projection: consent.projection, riskLevel: consent.riskLevel,
				changedFiles: consent.changedFiles, changedLines: consent.changedLines, consent: "declined_this_candidate", raw: { operation: "review/start", action: "declined", consent: "declined_this_candidate" } };
			return { kind: "started", start: { lineageId: `lineage-${answers.length}`, state: "approved", riskLevel: "high", selectedLenses: [], changedFiles: 1, changedLines: 2, correctionBudget: 0, action: "closed", lensesRequired: false, riskReasons: [] } };
		},
	} as unknown as NativeReviewCli;
	createGentleAiExtension({ nativeReviewCli: native, candidateViews: new CandidateViewRegistry(), processEnv: {} })({
		on() {}, registerCommand() {}, registerTool(definition: { name: string }) { tools.set(definition.name, definition as never); }, events: { emit() {} },
	} as unknown as ExtensionAPI);
	let prompts = 0;
	const ctx = { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "orca-worker" },
		ui: { custom: async () => { prompts++; return undefined; }, notify() {}, setStatus() {}, theme: { fg: (_color: string, text: string) => text } } } as unknown as ExtensionContext;
	const start = () => tools.get("gentle_review")!.execute(`start-${answers.length}-${prompts}`, { operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, undefined, undefined, ctx);
	return { answers, start, prompts: () => prompts };
}

test("G2 host: the policy answers instead of the dialog, through the same native answer, and says so", async t => {
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "review-consent-host-")));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const main = join(scratch, "main"), linked = join(scratch, "linked");
	mkdirSync(main);
	const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
	git(main, "init", "-q", "-b", "main"); writeFileSync(join(main, "app.ts"), "export const value = 1;\n"); git(main, "add", "."); git(main, "commit", "-qm", "base");
	git(main, "worktree", "add", "-q", "-b", "worker", linked);
	writeFileSync(join(linked, "app.ts"), "export const value = 2;\n");
	writeFileSync(join(main, "app.ts"), "export const value = 3;\n");
	const head = git(linked, "rev-parse", "HEAD");
	const policy = (gitDir: string, granted: string[]) => { mkdirSync(join(gitDir, "orca-stack"), { recursive: true }); writeFileSync(join(gitDir, "orca-stack", "rdd-consentimiento.json"), JSON.stringify({ version: 1, granted })); };

	policy(git(linked, "rev-parse", "--absolute-git-dir"), []);
	const declinedRun = harness(linked);
	const declined = await declinedRun.start();
	assert.equal(declined.details.outcome, "consent-declined-this-candidate", "recorded exactly as a declined dialog answer");
	assert.match(String(declined.details.consentAnsweredBy), /orca-stack policy answered declined/);
	assert.match(declined.content[0].text, /orca-stack policy answered declined/);
	assert.deepEqual(declinedRun.answers, ["declined"]);
	assert.equal(declinedRun.prompts(), 0, "no consent dialog is shown");

	policy(git(linked, "rev-parse", "--absolute-git-dir"), [head]);
	const grantedRun = harness(linked);
	const granted = await grantedRun.start();
	assert.deepEqual(grantedRun.answers, ["granted"]);
	assert.match(String(granted.details.consentAnsweredBy), /orca-stack policy answered granted/);
	assert.equal(grantedRun.prompts(), 0);

	policy(join(main, ".git"), [git(main, "rev-parse", "HEAD")]);
	const mainRun = harness(main);
	const asked = await mainRun.start();
	assert.equal(asked.details.outcome, "native-review-consent-required", "the main checkout keeps today's dialog");
	assert.equal(asked.details.consentAnsweredBy, undefined);
	assert.equal(mainRun.prompts(), 1);
	assert.deepEqual(mainRun.answers, []);
});
