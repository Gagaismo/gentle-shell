import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { AGENT_MODE, type AgentDefinition } from "../lib/agents-config.ts";
import { promptText, type TaskRequest } from "../lib/agents-runner.ts";

// odd/tasks/architect-agent.md T4 (S7): the packaged gentle-ai-architect and
// gentle-ai-verify children drop Pi's skills catalog, so the runtime names the
// absolute path of the packaged architecture-gate skill in their prompt. It
// must resolve from the package, never from the child's project cwd.

const ROOT = join(import.meta.dirname, "..");
const PACKAGED_SKILL = realpathSync(join(ROOT, "skills", "architecture-gate", "SKILL.md"));
const HEADING = "## Packaged skill paths";
const LINE = /^- `gentle-ai-architecture-gate`: (.+)$/m;

function packagedAgent(name: string, home: string): AgentDefinition {
	return { name, description: name, filePath: join(home, ".pi", "agent", "agents", `${name}.md`), scope: "global", instructions: "body", model: undefined, thinking: undefined, mode: undefined, tools: ["read"] };
}

function request(agent: AgentDefinition, cwd: string, overrides: Partial<TaskRequest> = {}): TaskRequest {
	return { agent, prompt: "Review the change", label: undefined, context: undefined, mode: AGENT_MODE.TASK, cwd, parentSessionId: "s1", model: undefined, thinking: undefined, sessionDir: join(cwd, "sessions"), resumeSessionPath: undefined, env: {}, ...overrides };
}

function withProject(run: (project: string, home: string) => void): void {
	const project = mkdtempSync(join(tmpdir(), "architect-skill-path-"));
	try { run(project, mkdtempSync(join(project, "home-"))); }
	finally { rmSync(project, { recursive: true, force: true }); }
}

for (const name of ["gentle-ai-architect", "gentle-ai-verify"]) {
	test(`S7: the ${name} child prompt names the absolute packaged gate skill path from a project cwd outside the package`, () => {
		withProject((project, home) => {
			assert.ok(!realpathSync(project).startsWith(realpathSync(ROOT)), "the project cwd is outside the package");
			const text = promptText(request(packagedAgent(name, home), project));
			assert.ok(text.startsWith("Review the change\n\n"), "the task stays first");
			assert.ok(text.includes(`\n\n${HEADING}\n`), "the injected path has its own section");
			const injected = text.match(LINE)?.[1];
			assert.ok(injected, "the packaged gate skill line is present");
			assert.ok(isAbsolute(injected), `the injected path is absolute: ${injected}`);
			assert.ok(existsSync(injected), `the injected path exists: ${injected}`);
			assert.equal(realpathSync(injected), PACKAGED_SKILL);
			assert.match(readFileSync(injected, "utf8"), /^name: gentle-ai-architecture-gate$/m);
		});
	});

	test(`S7: the ${name} child prompt does not repeat a gate path the task already lists`, () => {
		withProject((project, home) => {
			const injected = promptText(request(packagedAgent(name, home), project)).match(LINE)![1];
			const listed = `Review the change\n\n## Skills to load before work\n- ${injected}`;
			assert.equal(promptText(request(packagedAgent(name, home), project, { prompt: listed })), listed);
			const context = promptText(request(packagedAgent(name, home), project, { context: `Skill: ${injected}` }));
			assert.equal(context, `Review the change\n\n## Context\nSkill: ${injected}`);
		});
	});
}

test("S7: the injected section precedes the parent context", () => {
	withProject((project, home) => {
		const text = promptText(request(packagedAgent("gentle-ai-verify", home), project, { context: "prior notes" }));
		assert.ok(text.indexOf(HEADING) < text.indexOf("\n## Context\nprior notes"));
		assert.ok(text.endsWith("\n\n## Context\nprior notes"));
	});
});

test("PRESERVE: other agents and non-packaged gate agents keep the prompt unchanged", () => {
	withProject((project, home) => {
		for (const name of ["gentle-ai-worker", "gentle-ai-explore", "explore"]) {
			assert.equal(promptText(request(packagedAgent(name, home), project)), "Review the change");
		}
		const projectArchitect = { ...packagedAgent("gentle-ai-architect", home), scope: "project" as const, filePath: join(project, ".pi", "agents", "gentle-ai-architect.md") };
		assert.equal(promptText(request(projectArchitect, project, { context: "c" })), "Review the change\n\n## Context\nc");
	});
});

test("S7: both agent bodies fall back to the packaged path the runtime supplies, not a cwd-relative path", () => {
	for (const agent of ["gentle-ai-architect", "gentle-ai-verify"]) {
		const body = readFileSync(join(ROOT, "assets", "agents", `${agent}.md`), "utf8");
		assert.ok(body.includes("the packaged path the runtime supplies under `## Packaged skill paths`"), `${agent} names the runtime-supplied path`);
		assert.ok(!body.includes("skills/architecture-gate/SKILL.md"), `${agent} must not fall back to a cwd-relative skill path`);
	}
});
