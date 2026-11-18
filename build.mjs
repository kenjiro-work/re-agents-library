#!/usr/bin/env node
// Builds catalog.json, the skills library re-agents downloads, from repos.txt. No npm
// dependencies. Needs `git`, and the GitHub CLI (`gh`) signed in or given GH_TOKEN.
//
//   node build.mjs [repos.txt] [catalog.json]
//
// Per repository: one API request for its details (stars, licence, default branch), then a
// shallow, blob-less git clone that downloads only the SKILL.md files, whose YAML front matter
// (name, description, version) is read. About 50 API requests a run, well inside the limit of
// the token a GitHub Action gets. Everything fetched is data: nothing in a repository is run.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const INPUT = process.argv[2] ?? join(ROOT, "repos.txt");
const OUTPUT = process.argv[3] ?? join(ROOT, "catalog.json");
const MAX_SKILLS_PER_REPO = 80;
const MAX_DESCRIPTION = 600;

const warn = (msg) => console.error(`warning: ${msg}`);

// ---------------------------------------------------------------------------------------------
// GitHub

function gh(path) {
  try {
    const out = execFileSync("gh", ["api", "-H", "Accept: application/vnd.github+json", path], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out);
  } catch (e) {
    const detail = (e.stderr || e.message || "").toString().trim().split("\n")[0];
    throw new Error(`gh api ${path}: ${detail}`);
  }
}

/** git with hooks, LFS downloads and local-file transports off: a clone is only ever read. */
function git(args, cwd, input) {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", "-c", "advice.detachedHead=false", ...args],
    { cwd, input, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" } },
  );
}

/** A shallow clone holding the file tree and only the SKILL.md files. Returns its folder and all paths. */
function sparseClone(name, branch) {
  const dir = mkdtempSync(join(tmpdir(), "re-agents-library-"));
  git(["clone", "--quiet", "--depth", "1", "--filter=blob:none", "--no-checkout", "--branch", branch, `https://github.com/${name}.git`, dir]);
  const paths = git(["ls-tree", "-r", "--name-only", "HEAD"], dir).split("\n").filter(Boolean);
  return { dir, paths };
}

function checkout(dir, files) {
  // Exact paths, one per line, so only these blobs are downloaded (in one batch).
  git(["sparse-checkout", "set", "--no-cone", "--stdin"], dir, files.map((f) => "/" + f).join("\n") + "\n");
  git(["checkout", "--quiet", "HEAD"], dir);
}

// ---------------------------------------------------------------------------------------------
// Input

function readRepoList(file) {
  const repos = [];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(line)) {
      warn(`ignoring malformed line: ${raw.trim()}`);
      continue;
    }
    if (repos.some((r) => r.toLowerCase() === line.toLowerCase())) {
      warn(`${line} is listed twice`);
      continue;
    }
    repos.push(line);
  }
  return repos;
}

// ---------------------------------------------------------------------------------------------
// Finding skills in a tree

const SKIP_DIR = /(^|\/)(tests?|__tests__|fixtures)\//;

/** Lower is better when the same skill is shipped in several places (once per agent, etc.). */
function placeRank(dir) {
  if (dir === "skills" || dir.startsWith("skills/")) return 0;
  if (dir.startsWith(".claude/")) return 1;
  if (!dir.split("/").some((seg) => seg.startsWith("."))) return 2;
  return 3;
}

function preferred(a, b) {
  return (
    placeRank(a) - placeRank(b) ||
    a.split("/").length - b.split("/").length ||
    (a < b ? -1 : a > b ? 1 : 0)
  );
}

/** Folders (relative to the repo root, "" for the root) that hold a SKILL.md, one per skill. */
function skillDirs(tree, repo) {
  const dirs = tree
    .filter((e) => e.type === "blob" && /(^|\/)SKILL\.md$/.test(e.path) && !e.path.includes("node_modules/"))
    .map((e) => e.path.replace(/\/?SKILL\.md$/, ""))
    // Test fixtures hold copies of skills; a skill that is itself called "test" is fine.
    .filter((dir) => !SKIP_DIR.test(dir.split("/").slice(0, -1).join("/") + "/"));
  // The same skill copied per agent (.claude/skills/x, .cursor/skills/x, skills/x, ...) shares
  // its folder name; keep one copy. Two different skills with one folder name would also clash
  // when installed, so they are treated the same way.
  const byName = new Map();
  for (const dir of dirs) {
    const key = dir === "" ? repo.split("/")[1].toLowerCase() : dir.split("/").pop().toLowerCase();
    const seen = byName.get(key);
    if (!seen || preferred(dir, seen) < 0) byName.set(key, dir);
  }
  return [...byName.values()].sort();
}

// ---------------------------------------------------------------------------------------------
// Front matter: a small YAML subset, enough for name / description / version

function unquote(v) {
  v = v.trim();
  if (v.length >= 2 && v[0] === '"' && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v.replace(/\s+#.*$/, "");
}

/** Parses the block of `key: value` lines at one indentation level. */
function parseMapping(lines, indent) {
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lead = line.length - line.trimStart().length;
    if (lead !== indent || !line.trim() || line.trim().startsWith("#")) continue;
    const m = /^([A-Za-z0-9_-]+)\s*:(?:\s+(.*)|\s*)$/.exec(line.slice(indent));
    if (!m) continue;
    const key = m[1];
    const rest = (m[2] ?? "").trim();
    // Lines that belong to this key (more indented, or blank).
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].length - lines[j].trimStart().length > indent)) j++;
    const body = lines.slice(i + 1, j);
    i = j - 1;
    const block = /^([|>])([+-]?)\d*\s*$/.exec(rest);
    if (block) {
      const nonBlank = body.filter((l) => l.trim());
      const pad = nonBlank.length ? Math.min(...nonBlank.map((l) => l.length - l.trimStart().length)) : 0;
      const text = body.map((l) => l.slice(pad)).join("\n").replace(/\s+$/, "");
      out[key] = block[1] === "|" ? text : text.replace(/([^\n])\n(?=[^\n])/g, "$1 ");
    } else if (rest) {
      // A plain or quoted scalar, possibly folded over following indented lines.
      const more = body.map((l) => l.trim()).filter(Boolean);
      out[key] = unquote([rest, ...more].join(" "));
    } else {
      const nonBlank = body.filter((l) => l.trim());
      if (nonBlank.length && !/^\s*[A-Za-z0-9_-]+\s*:(\s|$)/.test(nonBlank[0])) {
        // A plain scalar that starts on the next line.
        out[key] = unquote(nonBlank.map((l) => l.trim()).join(" "));
      } else if (nonBlank.length) {
        const childIndent = nonBlank[0].length - nonBlank[0].trimStart().length;
        out[key] = parseMapping(body, childIndent);
      } else {
        out[key] = "";
      }
    }
  }
  return out;
}

function frontMatter(text) {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start++;
  if (lines[start]?.trim() !== "---") return null;
  const end = lines.findIndex((l, i) => i > start && /^(---|\.\.\.)\s*$/.test(l));
  if (end < 0) return null;
  const body = lines.slice(start + 1, end).map((l) => l.replace(/\t/g, "  "));
  return parseMapping(body, 0);
}

const asText = (v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

function clean(s, max) {
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
  return max && s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// ---------------------------------------------------------------------------------------------
// Main

function collect(repo) {
  const meta = gh(`repos/${repo}`);
  if (meta.archived) {
    warn(`${repo} is archived; skipped`);
    return null;
  }
  const name = meta.full_name;
  if (name.toLowerCase() !== repo.toLowerCase()) warn(`${repo} now lives at ${name}`);
  const branch = meta.default_branch;
  const { dir: clone, paths } = sparseClone(name, branch);
  try {
    return describe(meta, name, clone, paths);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

function describe(meta, name, clone, paths) {
  const dirs = skillDirs(paths.map((path) => ({ type: "blob", path })), name);
  const wanted = dirs.map((d) => (d ? `${d}/SKILL.md` : "SKILL.md"));
  checkout(clone, wanted);
  const skills = [];
  const names = new Set();
  let available = dirs.length;
  for (const dir of dirs) {
    if (skills.length >= MAX_SKILLS_PER_REPO) break;
    const file = dir ? `${dir}/SKILL.md` : "SKILL.md";
    let text;
    try {
      text = readFileSync(join(clone, file), "utf8");
    } catch (e) {
      warn(`${name}/${file}: ${e.message}`);
      available--;
      continue;
    }
    const fm = frontMatter(text);
    if (!fm) {
      warn(`${name}/${file}: no front matter; skipped`);
      available--;
      continue;
    }
    const folder = dir ? dir.split("/").pop() : name.split("/")[1];
    const skillName = clean(asText(fm.name), 120) || folder;
    const key = skillName.toLowerCase();
    if (names.has(key)) {
      available--; // the same skill again under another folder name
      continue;
    }
    names.add(key);
    const version = clean(asText(fm.version) || asText(fm.metadata?.version), 40) || null;
    skills.push({
      repo: name,
      path: dir,
      name: skillName,
      description: clean(asText(fm.description), MAX_DESCRIPTION),
      version,
    });
  }
  const truncated = available > skills.length;
  if (truncated) warn(`${name}: ${available} skills, keeping the first ${skills.length}`);
  if (!skills.length) warn(`${name}: no skills found`);

  return {
    skills,
    repo: {
      repo: name,
      about: clean(meta.description ?? "", MAX_DESCRIPTION),
      stars: meta.stargazers_count,
      pushedAt: meta.pushed_at,
      license: meta.license?.spdx_id && meta.license.spdx_id !== "NOASSERTION" ? meta.license.spdx_id : null,
      url: meta.html_url,
      topics: meta.topics ?? [],
      // How many distinct skills the repository has; `truncated` says not all are listed.
      skillCount: truncated ? available : skills.length,
      truncated,
    },
  };
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Pretty at the top, one line per repo and per skill: small, and readable in diffs. */
function render(catalog) {
  const rows = (xs) => xs.map((x) => "    " + JSON.stringify(x)).join(",\n");
  return (
    "{\n" +
    `  "format": ${catalog.format},\n` +
    `  "generated": ${JSON.stringify(catalog.generated)},\n` +
    `  "repos": [\n${rows(catalog.repos)}\n  ],\n` +
    `  "skills": [\n${rows(catalog.skills)}\n  ]\n` +
    "}\n"
  );
}

function main() {
  const list = readRepoList(INPUT);
  const repos = [];
  const skillsByRepo = new Map();
  for (const [i, repo] of list.entries()) {
    process.stderr.write(`[${i + 1}/${list.length}] ${repo}\n`);
    let got;
    try {
      got = collect(repo);
    } catch (e) {
      warn(`${repo}: ${e.message}; skipped`);
      continue;
    }
    if (!got || !got.skills.length) continue;
    if (skillsByRepo.has(got.repo.repo)) continue;
    repos.push(got.repo);
    skillsByRepo.set(got.repo.repo, got.skills);
  }
  repos.sort((a, b) => b.stars - a.stars || a.repo.localeCompare(b.repo));
  const skills = repos.flatMap((r) =>
    skillsByRepo.get(r.repo).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
  const catalog = { format: 1, generated: today(), repos, skills };
  const text = render(catalog);
  JSON.parse(text); // sanity check
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, text);
  console.error(`wrote ${OUTPUT}: ${repos.length} repos, ${skills.length} skills, ${(text.length / 1024).toFixed(0)} KB`);
}

main();
