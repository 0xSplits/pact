import { execFileSync } from "node:child_process";

const base = process.env.E2E_IMPACT_BASE?.trim();

if (!base) {
  console.error("E2E_IMPACT_BASE must identify the base commit.");
  process.exit(2);
}

let changedFiles: string[];

try {
  changedFiles = execFileSync(
    "git",
    ["diff", "--name-only", `${base}...HEAD`],
    {
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter(Boolean);
} catch {
  console.error(`Could not compare HEAD with E2E impact base ${base}.`);
  process.exit(2);
}

const affectsBrowserFlow = changedFiles.some(
  (file) =>
    file.startsWith("src/pages/") ||
    file.startsWith("src/components/") ||
    file.startsWith("src/lib/chain/") ||
    file === "src/lib/routes.ts" ||
    (file.startsWith("packages/pact/") && !file.endsWith(".md")),
);

if (!affectsBrowserFlow) {
  console.log("No flow-sensitive frontend files changed.");
  process.exit(0);
}

const updatesPlaywright = changedFiles.some(
  (file) => file.startsWith("tests/") && file.endsWith(".spec.ts"),
);

if (updatesPlaywright) {
  console.log("Flow-sensitive frontend and Playwright spec changes detected.");
  process.exit(0);
}

const prBody = process.env.PR_BODY ?? "";
const override = prBody.match(/^E2E impact override:\s*(.+)$/im)?.[1]?.trim();
const placeholder = /^(none|n\/a|not applicable|<.+>)$/i;

if (override && !placeholder.test(override)) {
  console.log(`E2E impact override recorded: ${override}`);
  process.exit(0);
}

console.error(
  [
    "Flow-sensitive frontend files changed without a Playwright spec update.",
    "Update tests/**/*.spec.ts, or add a concrete PR-body line explaining why existing coverage is sufficient:",
    "E2E impact override: <reason>",
  ].join("\n"),
);
process.exit(1);
