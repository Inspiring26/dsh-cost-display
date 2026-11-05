#!/usr/bin/env node
/**
 * Turn the local development package into a publish-ready GitHub/npm package.
 *
 * Usage:
 *   node scripts/prepare-release.mjs \
 *     --name @your-scope/dsh-cost-display \
 *     --repo https://github.com/your-name/dsh-cost-display \
 *     --author "Your Name"
 *
 * The output directory (`release/` by default) is a self-contained repository:
 * package.json is publishable, every module id / patch row uses the new package
 * name, and market/index.json is a valid DSH plugin-market format-1 index.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function fail(message) {
  console.error(`prepare-release: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) fail(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === "force") {
      args.force = "true";
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const name = args.name;
const repo = (args.repo ?? "").replace(/\.git$/, "").replace(/\/$/, "");
if (name === undefined) fail("--name is required, for example @alice/dsh-cost-display");
if (!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(name)) {
  fail("--name must be a lowercase scoped npm name, for example @alice/dsh-cost-display");
}
if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
  fail("--repo must look like https://github.com/owner/repository");
}
const owner = repo.split("/")[3];
const repository = repo.split("/")[4];
const author = args.author ?? owner;
const version = args.version ?? JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const out = resolve(root, args.out ?? "release");

if (out === root) fail("--out must not be the package root");
if (existsSync(out)) {
  if (args.force !== "true") fail(`${out} already exists; pass --force to replace it`);
  rmSync(out, { recursive: true, force: true });
}
mkdirSync(out, { recursive: true });

const SKIP = new Set(["node_modules", "release", "release-test", ".preview", ".DS_Store", ".git", ".pnpm-store"]);
for (const entry of readdirSync(root)) {
  if (SKIP.has(entry)) continue;
  if (resolve(root, entry) === out) continue;
  cpSync(resolve(root, entry), resolve(out, entry), { recursive: true });
}

const rawBase = `https://raw.githubusercontent.com/${owner}/${repository}/main`;

function rewrite(relativePath, pairs) {
  const path = resolve(out, relativePath);
  if (!existsSync(path)) return;
  let text = readFileSync(path, "utf8");
  for (const [from, to] of pairs) text = text.split(from).join(to);
  writeFileSync(path, text);
}

const replacements = [
  ["@local/dsh-cost-display", name],
  ["YOUR_NPM_SCOPE", name.slice(1).split("/")[0]],
  ["YOUR_GITHUB", owner],
  ["YOUR_NAME", author],
];
for (const file of ["client.js", "src/client.js", "cordis.patch.yml", "README.md", "PUBLISHING.md", "LICENSE"]) {
  rewrite(file, replacements);
}
rewrite("LICENSE", [["Copyright (c) 2026 dsh-cost-display contributors", `Copyright (c) 2026 ${author}`]]);

// Publishable manifest.
const pkgPath = resolve(out, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.name = name;
pkg.version = version;
pkg.private = undefined;
delete pkg.private;
pkg.description = "Appends DeepSeek peak/off-peak cost estimates to the native per-turn and session usage displays.";
pkg.license = "MIT";
pkg.author = { name: author };
pkg.repository = { type: "git", url: `git+${repo}.git` };
pkg.homepage = repo;
pkg.bugs = { url: `${repo}/issues` };
pkg.keywords = [...new Set(["dsh", "dsh-plugin", "deepseek-harness", ...(pkg.keywords ?? [])])];
pkg.publishConfig = { access: "public" };
pkg.engines = { ...(pkg.engines ?? {}), dsh: pkg.engines?.dsh ?? ">=0.2.1-rc.4 <0.3.0" };
pkg.files = [
  "index.js",
  "client.js",
  "cordis.patch.yml",
  "locale/*.json",
  "icon.svg",
  "src/**",
  "build.mjs",
  "README.md",
  "LICENSE",
];
pkg.scripts = {
  build: "node build.mjs",
  check: "node --check client.js",
  test: "node test/cost-core.test.mjs && node test/load-bundle.mjs && node test/client.test.mjs",
  prepack: "node build.mjs",
};
pkg.devDependencies = {
  fflate: "^0.8.2",
  react: "^18.3.1",
  "react-dom": "^18.3.1",
};
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// A valid self-hosted DSH plugin-market index (format 1).
const publishedAt = Math.floor(Date.now() / 1000);
mkdirSync(resolve(out, "market"), { recursive: true });
const index = {
  format: 1,
  title: { en: "dsh-cost-display", zh: "DSH 峰谷费用" },
  description: {
    en: "Peak/off-peak DeepSeek cost estimates appended to the native DSH usage displays.",
    zh: "在 DSH 原生每轮用量和整体用量文字后追加 DeepSeek 峰谷费用。",
  },
  metadata: {
    categories: {
      usage: { title: { en: "Usage and cost", zh: "用量与费用" } },
    },
    labels: {},
    sortKeys: {},
  },
  plugins: [
    {
      name,
      title: { en: "DeepSeek Peak/Off-Peak Cost", zh: "DeepSeek 峰谷费用" },
      description: {
        en: "Appends DeepSeek peak/off-peak cost estimates to the native per-turn and session usage displays.",
        zh: "在原生每轮用量和整体用量文字后追加 DeepSeek 峰谷费用，点开可看高峰/空闲拆分。",
      },
      icon: `${rawBase}/assets/icon-180.png`,
      author,
      homepage: repo,
      repository: { url: repo },
      metadata: {
        category: "usage",
        keywords: ["cost", "usage", "pricing", "peak-pricing"],
      },
      versions: [
        {
          version,
          publishTimestamp: publishedAt,
          source: { type: "npm" },
          engines: { dsh: pkg.engines.dsh },
        },
      ],
    },
  ],
};
writeFileSync(resolve(out, "market/index.json"), JSON.stringify(index, null, 2) + "\n");

// The single-file entry for awesome-dsh-plugin's curated list.
const awesome = `url: ${repo}
name: ${owner}/${repository}
category: usage
description:
  en: Appends DeepSeek peak/off-peak cost estimates to the native per-turn and session usage displays.
  zh: 在原生每轮用量和整体用量文字后追加 DeepSeek 峰谷费用，点开可看高峰/空闲拆分。
icon: ${rawBase}/assets/icon-180.png
`;
writeFileSync(resolve(out, "market/awesome-dsh-plugin.yml"), awesome);

console.log(`prepared ${out}`);
console.log(`package: ${name}@${version}`);
console.log(`repo:    ${repo}`);
console.log("");
console.log("next:");
console.log(`  cd ${out}`);
console.log("  git init && git add -A && git commit -m \"feat: dsh-cost-display 0.1.0\"");
console.log(`  git remote add origin ${repo}.git && git branch -M main && git push -u origin main`);
console.log("  pnpm install && pnpm test");
console.log("  npm publish --access public");
