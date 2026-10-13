import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Only enforced on pull_request (github.base_ref set). On push, nothing to diff.
const baseRef = process.env.GITHUB_BASE_REF;
if (!baseRef) {
  console.log("version-bump check: no base ref (push event), skipping");
  process.exit(0);
}

let failures = 0;

function changedFiles() {
  try {
    const out = execSync(`git diff --name-only origin/${baseRef}...HEAD`, {
      cwd: root,
      encoding: "utf8",
    });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (error) {
    console.error(`version-bump check: could not diff against origin/${baseRef}: ${error.message}`);
    process.exit(1);
  }
}

const catalog = JSON.parse(
  readFileSync(join(root, ".omp-plugin", "marketplace.json"), "utf8"),
);
const pluginRoot = catalog?.metadata?.pluginRoot ?? "plugins";
const files = changedFiles();

for (const entry of catalog.plugins ?? []) {
  const dir = join(pluginRoot, entry.source.replace(/^\.\//, ""));
  const touchedSrc = files.some(
    (f) => f.startsWith(`${dir}/src/`) || f === `${dir}/package.json`,
  );
  if (!touchedSrc) continue;

  const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
  if (pkg.version !== entry.version) {
    console.error(
      `FAIL: plugin "${entry.name}": package.json (${pkg.version}) != catalog (${entry.version}) — run scripts/validate.mjs`,
    );
    failures += 1;
    continue;
  }

  // Did the version actually move vs the base ref?
  let oldVersion;
  try {
    oldVersion = execSync(`git show origin/${baseRef}:${dir}/package.json`, {
      cwd: root,
      encoding: "utf8",
    });
    oldVersion = JSON.parse(oldVersion).version;
  } catch {
    oldVersion = undefined; // new plugin, version is fresh by definition
  }
  if (oldVersion !== undefined && oldVersion === pkg.version) {
    console.error(
      `FAIL: plugin "${entry.name}": src/ changed but version stayed at ${pkg.version} — bump package.json + catalog or omp upgrade will never fire`,
    );
    failures += 1;
  } else {
    console.log(`ok: plugin "${entry.name}" v${pkg.version} (bumped)`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nversion-bump check passed");
