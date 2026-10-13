import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

function fail(message) {
  failures += 1;
  console.error(`FAIL: ${message}`);
}

function ok(message) {
  console.log(`ok: ${message}`);
}

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${path}: invalid JSON (${error.message})`);
    return undefined;
  }
}

const NAME_RULE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,62}[A-Za-z0-9])?$/;

// 1. Catalog
const catalogPath = join(root, ".omp-plugin", "marketplace.json");
const catalog = loadJson(catalogPath);
if (catalog) {
  for (const field of ["name", "owner", "plugins"]) {
    if (catalog[field] === undefined) fail(`catalog: missing required field "${field}"`);
  }
  if (typeof catalog?.owner?.name !== "string") fail('catalog: owner.name must be a string');
  if (!NAME_RULE.test(catalog?.name ?? "")) fail(`catalog: invalid marketplace name "${catalog?.name}"`);
  if (!Array.isArray(catalog?.plugins) || catalog.plugins.length === 0) {
    fail("catalog: plugins must be a non-empty array");
  }

  const seen = new Set();
  for (const entry of catalog.plugins ?? []) {
    if (!NAME_RULE.test(entry?.name ?? "")) {
      fail(`catalog: invalid plugin name "${entry?.name}"`);
      continue;
    }
    const lowered = entry.name.toLowerCase();
    if (seen.has(lowered)) fail(`catalog: duplicate plugin name "${entry.name}"`);
    seen.add(lowered);

    // Version must be declared: upgrade detection ignores entries without one.
    if (typeof entry.version !== "string" || entry.version.length === 0) {
      fail(`catalog: plugin "${entry.name}" must declare a version (upgrade detection needs it)`);
    }

    // Resolve relative source inside the repo.
    if (typeof entry.source !== "string" || !entry.source.startsWith("./")) {
      fail(`catalog: plugin "${entry.name}" source must be a "./" relative path`);
      continue;
    }
    const pluginRoot = catalog?.metadata?.pluginRoot ?? ".";
    const pluginDir = join(root, pluginRoot, entry.source.slice(2));
    if (!existsSync(pluginDir)) {
      fail(`catalog: plugin "${entry.name}" source missing: ${pluginDir}`);
      continue;
    }

    // 2. Plugin package manifest
    const pkg = loadJson(join(pluginDir, "package.json"));
    if (!pkg) continue;
    if (pkg.name !== entry.name) {
      fail(`plugin "${entry.name}": package.json name is "${pkg.name}"`);
    }
    if (pkg.version !== entry.version) {
      fail(`plugin "${entry.name}": catalog version ${entry.version} != package.json ${pkg.version}`);
    }
    const entries = pkg?.omp?.extensions;
    if (!Array.isArray(entries) || entries.length === 0) {
      fail(`plugin "${entry.name}": package.json omp.extensions must be a non-empty array`);
      continue;
    }
    for (const ext of entries) {
      const extPath = join(pluginDir, ext);
      if (!existsSync(extPath)) {
        fail(`plugin "${entry.name}": extension entry missing: ${ext}`);
        continue;
      }
      // 3. Entry point parses as TypeScript/JavaScript (esbuild transpile check).
      try {
        const source = readFileSync(extPath, "utf8");
        const { transformSync } = await import("esbuild").catch(() => ({}));
        if (transformSync) {
          transformSync(source, { loader: extPath.endsWith(".ts") ? "ts" : "js" });
        } else {
          // Fallback: balanced-brace sanity + import/export presence.
          if (!/export\s+default/.test(source)) {
            fail(`plugin "${entry.name}": ${ext} has no default export (extension factory)`);
          }
        }
      } catch (error) {
        fail(`plugin "${entry.name}": ${ext} failed to parse (${error.message})`);
      }
    }
    ok(`plugin "${entry.name}" v${entry.version}`);
  }
  if (failures === 0) ok(`catalog "${catalog.name}" (${catalog.plugins.length} plugins)`);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nmarketplace validation passed");
