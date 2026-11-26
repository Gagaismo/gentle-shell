#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .+/;
const GIT_REVERT = /^Revert ".+"$/;
const USAGE = "usage: node scripts/orca-check-commits.mjs <base>..<head> [--exclude <ref>]...";

function parseArgs(argv) {
	const excluded = [];
	let range;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--exclude") {
			const ref = argv[++i];
			if (!ref) return { error: "--exclude needs a ref" };
			if (ref.startsWith("-")) return { error: `--exclude needs a ref, got a flag: ${ref}` };
			excluded.push(ref);
		} else if (range === undefined && !arg.startsWith("-")) {
			range = arg;
		} else {
			return { error: `unexpected argument: ${arg}` };
		}
	}
	if (!range) return { error: "missing revision range" };
	return { range, excluded };
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.error) {
	process.stderr.write(`${parsed.error}\n${USAGE}\n`);
	process.exit(2);
}

const args = ["log", "--no-merges", "--format=%H%x00%s", parsed.range];
if (parsed.excluded.length > 0) args.push("--not", ...parsed.excluded);
args.push("--");
const git = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (git.status !== 0) {
	process.stderr.write(git.stderr || `git exited with ${git.status ?? git.signal}\n`);
	process.exit(2);
}

const commits = git.stdout.split("\n").filter(Boolean).map((line) => {
	const [sha, subject] = line.split("\0");
	return { sha, subject };
});
const offending = commits.filter(({ subject }) => !CONVENTIONAL.test(subject) && !GIT_REVERT.test(subject));

for (const { sha, subject } of offending) process.stdout.write(`${sha.slice(0, 7)} ${subject}\n`);
const noun = commits.length === 1 ? "commit" : "commits";
if (offending.length > 0) {
	process.stdout.write(`Conventional Commits check failed for ${offending.length} of ${commits.length} ${noun}; use type(scope)!: subject.\n`);
	process.exit(1);
}
process.stdout.write(`${commits.length} ${noun} checked, all follow Conventional Commits.\n`);
