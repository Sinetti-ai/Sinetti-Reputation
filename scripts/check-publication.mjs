import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const ignored = new Set([
  ".git",
  "node_modules",
  "artifacts",
  "cache",
  "cache_forge",
  "out",
  "dist",
  "typechain-types",
  "coverage",
  "data"
]);
const textExtensions = new Set([
  ".cjs", ".css", ".env", ".html", ".js", ".json", ".jsonc", ".md",
  ".mjs", ".sh", ".sol", ".toml", ".ts", ".txt", ".yaml", ".yml"
]);
// Structural patterns: local paths and phrasing that only makes sense inside a private
// tree. Maintainers keep a further list of names in `.publication-blocklist.local`
// (gitignored, one regular expression per line, `#` comments); it is merged in when
// present, so the private vocabulary never has to appear in this public file.
const forbidden = [
  /\/Users\//,
  /\/home\/[A-Za-z0-9._-]+\//,
  /\bprivate Sinetti repo\b/i
];
try {
  const local = readFileSync(path.join(root, ".publication-blocklist.local"), "utf8");
  for (const line of local.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    forbidden.push(new RegExp(trimmed));
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const failures = [];

function walk(directory) {
  for (const name of readdirSync(directory)) {
    if (ignored.has(name)) continue;
    const absolute = path.join(directory, name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      failures.push(`${relative}: tracked publication tree must not contain symlinks`);
      continue;
    }
    if (stat.isDirectory()) {
      walk(absolute);
      continue;
    }
    if (stat.size > 1_000_000) failures.push(`${relative}: file exceeds 1 MB`);
    const extension = name === ".env.example" ? ".env" : path.extname(name);
    if (!textExtensions.has(extension) && !["LICENSE", "NOTICE"].includes(name)) continue;
    const text = readFileSync(absolute, "utf8");
    for (const pattern of forbidden) {
      if (relative !== "scripts/check-publication.mjs" && pattern.test(text)) {
        failures.push(`${relative}: matches forbidden publication pattern ${pattern}`);
      }
    }
    if (extension !== ".md") continue;
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = match[1].replace(/^<|>$/g, "").split("#", 1)[0];
      if (!raw || /^(?:https?:|mailto:)/.test(raw)) continue;
      const target = path.resolve(path.dirname(absolute), decodeURIComponent(raw));
      try {
        lstatSync(target);
      } catch {
        failures.push(`${relative}: broken local Markdown link ${match[1]}`);
      }
    }
  }
}

walk(root);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("publication tree: clean");
}
