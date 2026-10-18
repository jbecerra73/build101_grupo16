import { ghInstallScript, type Finding, type Flow } from "../shared";
import { buildFixPrompt } from "./fix-prompt";
import { run, ShellError, type Shell } from "./shell";

export const STOREFRONT_REPO = "FrissA/demo-ecommerce";
export const CODING_MODEL = "claude-opus-5-5";

// The agent may not touch what the swarm relies on to verify a build, nor
// dependencies or CI.
const PROTECTED_PATHS = [
  "next.config.mjs",
  "netlify.toml",
  "package.json",
  "package-lock.json",
  ".github/",
  "src/lib/payment.ts",
  // Tracking: a fix that changes what PostHog sees can't be measured.
  "src/lib/analytics.ts",
  "src/components/Analytics.tsx",
];
const PROTECTED_SNIPPETS = [
  { file: "src/app/layout.tsx", text: '"build-sha"' },
  { file: "src/app/checkout/success/page.tsx", text: 'data-echo="email"' },
  { file: "src/app/checkout/success/page.tsx", text: 'data-echo="address"' },
  { file: "src/app/checkout/success/page.tsx", text: 'data-echo="card"' },
];

export type CodingAgentInput = {
  runId: string;
  attempt: number;
  flow: Flow;
  findings: Finding[];
  repo?: string;
  baseBranch?: string;
  log?: (line: string) => void;
};

export type CodingAgentResult = {
  branch: string;
  commitSha: string;
  prNumber: number;
  prUrl: string;
  summary: string;
};

export class GuardrailError extends Error {}

const draftBody = (input: CodingAgentInput, summary: string) => `Automated fix by FrictionSwarm for analysis run \`${input.runId}\` (attempt ${input.attempt}).

## Findings addressed
${input.findings.map((f) => `- **${f.title}** (${f.severity}; ${f.segments.join(", ")}; step ${f.step})`).join("\n")}

## Agent summary
${summary}

---
⏳ Draft until a persona swarm shops this PR's deploy preview with fresh seeds. It is marked ready for review only if a targeted persona completes ≥20 pts more often than its segment's real users and no persona falls below its segment.`;

/** Check the agent's diff against the locked constraints before anything is pushed. */
async function checkGuardrails(shell: Shell, cwd: string) {
  const changed = (await run(shell, `cd ${cwd} && git status --porcelain | cut -c4-`)).split("\n").filter(Boolean);
  if (changed.length === 0) throw new GuardrailError("the agent made no changes");
  const touched = changed.filter((f) => PROTECTED_PATHS.some((p) => f === p || f.startsWith(p)));
  if (touched.length) throw new GuardrailError(`the agent changed protected files: ${touched.join(", ")}`);
  for (const { file, text } of PROTECTED_SNIPPETS) {
    const { exitCode } = await shell.exec(`grep -qF -- '${text}' ${cwd}/${file}`);
    if (exitCode !== 0) throw new GuardrailError(`${file} no longer contains ${text}`);
  }
  return changed;
}

/** Clone the storefront, let Claude Code fix the findings, push a branch and
 * open a draft PR. The agent never sees this repo, only the storefront. */
export async function runCodingAgent(shell: Shell, input: CodingAgentInput): Promise<CodingAgentResult> {
  const repo = input.repo ?? STOREFRONT_REPO;
  const base = input.baseBranch ?? "main";
  const log = input.log ?? (() => {});
  const ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error("GH_TOKEN is required to clone, push and open the PR");
  const gitEnv = { GH_TOKEN: ghToken, REPO: repo, BASE: base };
  const cwd = `${shell.home}/storefront`;
  const branch = `frictionswarm/${input.runId}-fix${input.attempt}`;

  log(`cloning ${repo}@${base}`);
  await run(
    shell,
    `rm -rf ${cwd} && git clone --depth 1 --branch "$BASE" "https://x-access-token:$GH_TOKEN@github.com/$REPO.git" ${cwd}`,
    { env: gitEnv, timeoutMs: 120_000 },
  );
  log("installing dependencies");
  await run(shell, `cd ${cwd} && npm ci --no-audit --no-fund`, { timeoutMs: 600_000 });
  // The sandbox image's claude can be too old for CODING_MODEL: use the latest, under home
  const claudeBin = `${shell.home}/.npm-global/bin/claude`;
  await run(shell, `npm install -g --prefix ${shell.home}/.npm-global --no-audit --no-fund @anthropic-ai/claude-code@latest`, {
    timeoutMs: 300_000,
  });
  // Same for gh: old versions can't open or edit PRs since Projects (classic) left the API
  const ghBin = `${shell.home}/.gh/bin/gh`;
  await run(shell, ghInstallScript(`${shell.home}/.gh`), { timeoutMs: 120_000 });

  log(`running Claude Code (${CODING_MODEL}) on ${input.findings.length} finding(s)`);
  const promptFile = `${shell.home}/fix-prompt.md`;
  await shell.writeFile(promptFile, buildFixPrompt(input.flow, input.findings));
  // No GitHub token in the agent's environment: it edits files, we push
  const claudeEnv: Record<string, string> = { GH_TOKEN: "", GITHUB_TOKEN: "" };
  if (process.env.ANTHROPIC_API_KEY) claudeEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) claudeEnv.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const out = await run(
    shell,
    `cd ${cwd} && ${claudeBin} -p "$(cat ${promptFile})" --model ${CODING_MODEL} --output-format json ` +
      `--permission-mode acceptEdits --allowedTools "Read,Edit,Write,Glob,Grep,Bash(npm run build),Bash(npm run lint)"`,
    { env: claudeEnv, timeoutMs: 30 * 60_000 },
  );
  let summary: string;
  try {
    summary = String(JSON.parse(out).result ?? "").trim();
  } catch {
    summary = out.slice(-2000);
  }

  log("checking guardrails and build");
  const changed = await checkGuardrails(shell, cwd);
  try {
    await run(shell, `cd ${cwd} && npm run build`, { timeoutMs: 600_000 });
  } catch (e) {
    throw e instanceof ShellError ? new GuardrailError(`build fails after the fix: ${e.message}`) : e;
  }

  log(`pushing ${branch} (${changed.length} file(s) changed)`);
  const title = `FrictionSwarm: ${input.findings.map((f) => f.title).join("; ")}`.slice(0, 120);
  await shell.writeFile(`${shell.home}/pr-body.md`, draftBody(input, summary));
  const prEnv = { ...gitEnv, BRANCH: branch, TITLE: title };
  await run(
    shell,
    `cd ${cwd} && git checkout -b "$BRANCH" && git add -A && ` +
      `git -c user.name=FrictionSwarm -c user.email=frictionswarm@users.noreply.github.com commit -q -m "$TITLE" && ` +
      `git push -q origin "$BRANCH"`,
    { env: prEnv, timeoutMs: 120_000 },
  );
  const commitSha = await run(shell, `cd ${cwd} && git rev-parse HEAD`);
  const prUrl = await run(
    shell,
    `cd ${cwd} && ${ghBin} pr create --draft --repo "$REPO" --base "$BASE" --head "$BRANCH" --title "$TITLE" --body-file ${shell.home}/pr-body.md`,
    { env: prEnv, timeoutMs: 60_000 },
  );
  const prNumber = Number(prUrl.match(/\/pull\/(\d+)/)?.[1]);
  if (!prNumber) throw new Error(`could not read the PR number from: ${prUrl}`);
  log(`opened draft PR #${prNumber}`);
  return { branch, commitSha, prNumber, prUrl: prUrl.split("\n").at(-1)!, summary };
}
