import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";

// Structural validation for GitHub Actions workflows: YAML parses cleanly even
// when a step lost its list marker, a step carries both `run` and `uses`, or a
// job references a `needs:` that does not exist. Prettier and a YAML round-trip
// are blind to all three (they are valid YAML), so this gate checks the shape
// an Actions runner actually consumes. Optional argument: a workflow directory
// to validate instead of the repo's own (used by tests and probes).

const workflowDir = process.argv[2] ?? ".github/workflows";
const problems = [];

const entries = readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort();
if (entries.length === 0) {
  console.error(`workflow validation failed: no .yml/.yaml files found in ${workflowDir}`);
  process.exit(1);
}
for (const entry of entries) {
  const file = join(workflowDir, entry);
  const document = parseDocument(readFileSync(file, "utf8"));
  for (const error of document.errors) problems.push(`${file}: ${error.message}`);
  validateWorkflow(document.toJS(), file);
}

function validateWorkflow(workflow, file) {
  if (!workflow || typeof workflow !== "object") return problems.push(`${file}: empty workflow`);
  const jobs = workflow.jobs;
  if (!jobs || typeof jobs !== "object" || Object.keys(jobs).length === 0)
    return problems.push(`${file}: no jobs`);

  for (const [name, job] of Object.entries(jobs)) {
    const label = `${file}: job ${name}`;
    if (!job || typeof job !== "object") {
      problems.push(`${label} is not a mapping`);
      continue;
    }
    for (const needed of Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [])
      if (!(needed in jobs)) problems.push(`${label} needs '${needed}', which does not exist`);

    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      problems.push(`${label} has no steps list`);
      continue;
    }
    job.steps.forEach((step, index) => {
      const stepLabel = `${label} step ${index + 1}${step?.name ? ` (${step.name})` : ""}`;
      if (!step || typeof step !== "object" || Array.isArray(step)) {
        problems.push(`${stepLabel} is not a mapping`);
        return;
      }
      const drivers = ["run", "uses"].filter((key) => key in step);
      if (drivers.length === 0) problems.push(`${stepLabel} has neither 'run' nor 'uses'`);
      if (drivers.length === 2) problems.push(`${stepLabel} has both 'run' and 'uses'`);
      if (typeof step.uses === "string" && !step.uses.includes("@") && !step.uses.startsWith("./"))
        problems.push(`${stepLabel} uses '${step.uses}' without a version ref`);
    });
  }
}

if (problems.length > 0) {
  console.error(`workflow validation failed:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`workflow steps verified in ${workflowDir}`);
