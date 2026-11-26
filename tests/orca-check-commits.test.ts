import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/orca-check-commits.mjs", import.meta.url));

function makeRepo() {
	const dir = mkdtempSync(join(tmpdir(), "orca-check-commits-"));
	const git = (...args: string[]) => {
		const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	let n = 0;
	const commit = (subject: string) => {
		writeFileSync(join(dir, `f${n++}.txt`), subject);
		git("add", ".");
		git("commit", "-q", "-m", subject);
		return git("rev-parse", "HEAD");
	};
	git("init", "-q", "-b", "main");
	const base = commit("chore: initial");
	return { dir, git, commit, base, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function check(cwd: string, ...args: string[]) {
	return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
}

test("a range with a non-conventional subject exits 1 and names the commit", (t) => {
	const repo = makeRepo();
	t.after(repo.cleanup);
	repo.commit("feat: add thing");
	const bad = repo.commit("Update stuff");
	const result = check(repo.dir, `${repo.base}..HEAD`);
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stdout, new RegExp(`^${bad.slice(0, 7)} Update stuff$`, "m"));
	assert.doesNotMatch(result.stdout, /feat: add thing/);
});

test("a range with only conventional subjects exits 0 with a count line", (t) => {
	const repo = makeRepo();
	t.after(repo.cleanup);
	repo.commit("feat(cli): add flag");
	repo.commit("fix!: break api");
	const result = check(repo.dir, `${repo.base}..HEAD`);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /2 commits/);
});

test("a bad commit reachable from an --exclude ref is ignored", (t) => {
	const repo = makeRepo();
	t.after(repo.cleanup);
	repo.commit("Upstream style subject");
	repo.git("branch", "upstream-main");
	repo.commit("docs: fork change");
	const result = check(repo.dir, `${repo.base}..HEAD`, "--exclude", "upstream-main");
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /1 commit/);
	assert.doesNotMatch(result.stdout, /Upstream style subject/);
});

test("a merge commit with a non-conventional subject is ignored", (t) => {
	const repo = makeRepo();
	t.after(repo.cleanup);
	repo.git("checkout", "-q", "-b", "side");
	repo.commit("test: side change");
	repo.git("checkout", "-q", "main");
	repo.commit("ci: main change");
	repo.git("merge", "-q", "--no-ff", "-m", "Merge branch 'side'", "side");
	const result = check(repo.dir, `${repo.base}..HEAD`);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /2 commits/);
	assert.doesNotMatch(result.stdout, /Merge branch/);
});
