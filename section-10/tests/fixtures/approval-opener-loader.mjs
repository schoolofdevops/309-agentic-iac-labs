const opener = new URL("../../scripts/open-gitops-approval-gate.mjs", import.meta.url).href;

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (url !== opener) return loaded;
  let source = String(loaded.source);
  const begin = source.indexOf("async function createLearnerApprovalGate(input) {");
  const end = source.indexOf("\nasync function main() {", begin);
  if (begin < 0 || end < 0) throw new Error("TEST_FIXTURE_OPENER_SHAPE_CHANGED");
  const fixture = `async function createLearnerApprovalGate(input) {
    const observed = { sync: "Synced", health: "Healthy", operation: "Succeeded", revision: "1111111111111111111111111111111111111111" };
    const gate = openApprovalGate(resolve(input.approval), input.revision, input.purpose, observed);
    return {
      approval: resolve(input.approval), gate: gate.binding.path, gateBinding: gate.binding,
      gateOwnership: gate.ownership, observed, purpose: input.purpose, revision: input.revision,
    };
  }
`;
  source = `${source.slice(0, begin)}${fixture}${source.slice(end)}`;
  source = source.replace("const PROMPT_TIMEOUT_MS = 300_000;", "const PROMPT_TIMEOUT_MS = 40;");
  return { ...loaded, source };
}
