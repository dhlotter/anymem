#!/usr/bin/env node
// Fails when a tracked file contains a name that must never ship (private services, personal
// paths, the owner's name, the Doppler names) or something shaped like a real secret, or when a
// tracked file matches .gitignore (it was added with `git add -f`, so it ships anyway).
// The plugin ships from the git tree ("source": "./"), so every tracked file is scanned.
// `node scripts/check-shipped-files.mjs` scans the repo.
// `node scripts/check-shipped-files.mjs --self-test` plants one violation per rule in a temp git
// repo and checks that each one is caught, that clean files are not flagged and that the
// exception list works.
// EXCEPTIONS below are the only hits allowed to stay. Each names one file, the rule labels it may
// carry and a reason. Add a line only with a reason that would survive review.
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Pattern list. To add a rule, add one entry here with a sample for the self-test.
// Words are joined from parts so this file never contains the words it hunts for.
// ---------------------------------------------------------------------------
const w = (...parts) => parts.join("");
const SECOND_BRAIN = w("second", "-brain");

// Matched case-insensitively when ci is true, exactly otherwise. Paths are matched exactly.
const FORBIDDEN_TEXT = [
  { text: w("easy", "entropy"), ci: true },
  { text: w("dop", "pler"), ci: true },
  { text: SECOND_BRAIN, ci: true },
  { text: w("/opt", "/drive"), ci: false },
  { text: w("/Us", "ers/"), ci: false },
  { text: w("Herm", "ann"), ci: true },
  { text: w("Kurt", "osys"), ci: true },
  { text: w("Lot", "ter"), ci: false }, // a name that must not ship
  { text: w("Tes", "sa"), ci: true }, // a name that must not ship
  { text: w("anymem", "-next"), ci: true }, // a name that must not ship
  { text: w("dhlotter", ".workers"), ci: true }, // a name that must not ship
];

// Shapes of real secrets. The sample is built at runtime and only used by the self-test.
const SECRET_SHAPES = [
  { label: "secret shape sk-", re: /\bsk-[A-Za-z0-9_-]{20,}/, sample: w("sk-", "a".repeat(24)) },
  { label: "secret shape ghp_", re: /\bghp_[A-Za-z0-9]{20,}/, sample: w("gh", "p_", "a".repeat(36)) },
  { label: "secret shape AKIA", re: /\bAKIA[0-9A-Z]{16}\b/, sample: w("AK", "IA", "ABCDEFGHIJKLMNOP") },
  { label: "secret shape xox", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, sample: w("xo", "xb-", "1234567890-abcdef") },
  {
    label: "secret shape JWT",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
    sample: w("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjMifQ", ".", "abcdefghijk"),
  },
  {
    label: "secret shape PEM private key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    sample: w("-----BEGIN RSA ", "PRIVATE KEY-----"),
  },
];

// Named exceptions: a file, the rule labels it may carry, and why. Keep this list short.
const EXCEPTIONS = [
  {
    path: ".gitleaks.toml",
    rules: ["secret shape ghp_"],
    reason: "a made up GitHub token, the fixture the secret scan allows for its github-pat rule",
  },
  {
    path: "LICENSE",
    rules: [w("Herm", "ann"), w("Lot", "ter")],
    reason: "copyright holder in the license notice, which must name the holder",
  },
];

const SKIP_FILES = ["scripts/check-shipped-files.mjs"]; // this file holds the pattern list
// Known binary formats are skipped by extension, and the run reports how many were skipped.
// Every other file is scanned whatever its bytes look like.
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".zip", ".gz", ".tgz", ".pdf",
]);
const SYMLINK_LABEL = "symlink in tracked tree (not followed)";
const IGNORED_LABEL = "tracked but matches .gitignore (git rm --cached it, or the rule is wrong)";

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// Paths git tracks, relative to root. Symlinks appear here too, and they are reported, never followed.
function trackedFiles(root) {
  return git(root, ["ls-files", "-z"]).split("\u0000").filter(Boolean);
}

// Tracked files that the ignore rules would hide. They ship because the plugin takes the git tree.
function trackedButIgnored(root) {
  return git(root, ["ls-files", "-ci", "--exclude-standard", "-z"]).split("\u0000").filter(Boolean);
}

function isExcepted(rel, label, exceptions) {
  return exceptions.some((e) => e.path === rel && e.rules.includes(label));
}

function textHits(line) {
  const hits = [];
  for (const rule of FORBIDDEN_TEXT) {
    const fold = (s) => (rule.ci ? s.toLowerCase() : s);
    if (fold(line).includes(fold(rule.text))) hits.push(rule.text);
  }
  return hits;
}

// Every byte becomes one character, then NUL bytes are dropped. Plain ASCII reads as it is,
// UTF-16 text in the ASCII range becomes plain text, and a NUL planted inside a token no longer
// splits it. No byte is skipped, so a file cannot pass by containing a NUL.
function asText(buf) {
  return buf.toString("latin1").split("\u0000").join("");
}

function scan(root, rels, exceptions = EXCEPTIONS) {
  const findings = [];
  const skipped = new Map(); // extension -> count of known binary files skipped
  let scanned = 0;
  for (const rel of rels) {
    const p = join(root, rel);
    let st;
    try {
      st = lstatSync(p);
    } catch (err) {
      findings.push({ rel, line: null, label: err.code === "ENOENT" ? "tracked file missing on disk" : `unreadable path (${err.code})` });
      continue;
    }
    if (st.isSymbolicLink()) {
      findings.push({ rel, line: null, label: SYMLINK_LABEL });
      continue;
    }
    if (!st.isFile()) {
      findings.push({ rel, line: null, label: "not a regular file" });
      continue;
    }
    if (SKIP_FILES.includes(rel)) continue;
    const ext = extname(p).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      skipped.set(ext, (skipped.get(ext) ?? 0) + 1);
      continue;
    }
    let buf;
    try {
      buf = readFileSync(p);
    } catch (err) {
      findings.push({ rel, line: null, label: `unreadable file (${err.code})` });
      continue;
    }
    scanned++;
    asText(buf).split(/\r?\n/).forEach((line, i) => {
      for (const label of textHits(line)) if (!isExcepted(rel, label, exceptions)) findings.push({ rel, line: i + 1, label });
      for (const s of SECRET_SHAPES) if (s.re.test(line) && !isExcepted(rel, s.label, exceptions)) findings.push({ rel, line: i + 1, label: s.label });
    });
  }
  const binary = [...skipped.values()].reduce((a, b) => a + b, 0);
  return { scanned, binary, skipped, findings };
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "shipped-check-"));
  let checks = 0;
  let failed = 0;
  const check = (name, ok, detail = "") => {
    checks++;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${detail}`}`);
  };
  try {
    let planted = 0;
    const plant = (rel, body) => {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, typeof body === "string" ? `${body}\n` : body);
      planted++;
    };
    const expected = new Map(); // planted path -> the one label it must produce
    FORBIDDEN_TEXT.forEach((rule, i) => {
      const rel = `hooks/violation-text-${i}.txt`;
      plant(rel, `note: ${rule.ci ? rule.text.toUpperCase() : rule.text} is here`);
      expected.set(rel, rule.text);
    });
    // Paths outside the old fixed list are scanned too: a Worker file, a bench file, a top-level file.
    plant("worker/violation-worker.js", `// ${w("anymem", "-next")} is here`);
    expected.set("worker/violation-worker.js", w("anymem", "-next"));
    plant("bench/violation-bench.json", `{"q": "${w("Kurt", "osys")} is here"}`);
    expected.set("bench/violation-bench.json", w("Kurt", "osys"));
    plant("violation-top.md", `note: ${w("dop", "pler")} is here`);
    expected.set("violation-top.md", w("dop", "pler"));
    SECRET_SHAPES.forEach((shape, i) => {
      const rel = `client/violation-secret-${i}.txt`;
      plant(rel, `token ${shape.sample} end`);
      expected.set(rel, shape.label);
    });

    // Gaps the scanner used to miss: a NUL inside a token, UTF-16 text, a nested node_modules folder.
    const ghp = SECRET_SHAPES[1];
    const head = ghp.sample.slice(0, 3);
    const tail = ghp.sample.slice(3);
    plant("hooks/nul-inside-token.txt", Buffer.from(`note: ${head}\u0000${tail} end\n`, "latin1"));
    expected.set("hooks/nul-inside-token.txt", ghp.label);
    plant("client/utf16-token.txt", Buffer.from(`note: ${ghp.sample} end\n`, "utf16le"));
    expected.set("client/utf16-token.txt", ghp.label);
    plant("docs/node_modules/nested.md", `token ${ghp.sample} end`);
    expected.set("docs/node_modules/nested.md", ghp.label);

    // A named exception allows its own rule in its own file, and nothing else.
    const allowed = "bench/sets/allowed.json";
    plant(allowed, `{"q": "${w("Herm", "ann")}"}`);
    plant("bench/sets/not-allowed.json", `{"q": "${w("Herm", "ann")}"}`);
    expected.set("bench/sets/not-allowed.json", w("Herm", "ann"));

    // Tracked-but-ignored: a .gitignore rule, one file that matches it and is added with -f.
    plant(".gitignore", "*.local.json\n");
    plant("bench/sets/planted.local.json", `{"q": "clean"}`);
    plant("docs/clean-ignored-neighbour.md", "Plain text that the ignore rule does not match.");

    // Links are reported and never followed: a dangling link and a link that loops on itself.
    symlinkSync("nowhere-at-all", join(dir, "hooks/dangling-link"));
    symlinkSync("loop-link", join(dir, "hooks/loop-link"));
    expected.set("hooks/dangling-link", SYMLINK_LABEL);
    expected.set("hooks/loop-link", SYMLINK_LABEL);

    const clean = [
      "docs/clean.md",
      "docs/clean-binary.dat",
    ];
    plant("docs/clean.md", "Plain text about memory, recall and a short sk-short id.");
    plant("docs/clean-binary.dat", Buffer.from([0, 1, 2, 255, 0, 127, 10, 13, 10]));

    git(dir, ["init", "-q"]);
    git(dir, ["add", "-A"]);
    git(dir, ["add", "-f", "bench/sets/planted.local.json"]);

    const rels = trackedFiles(dir);
    const exceptions = [{ path: allowed, rules: [w("Herm", "ann")], reason: "self-test" }];
    const result = scan(dir, rels, exceptions);
    const byFile = new Map();
    for (const f of result.findings) byFile.set(f.rel, [...(byFile.get(f.rel) ?? []), f.label]);

    for (const [rel, label] of expected) {
      const got = byFile.get(rel) ?? [];
      check(`caught ${label} in ${rel}`, got.length === 1 && got[0] === label, `got ${JSON.stringify(got)}`);
    }
    for (const rel of clean) {
      check(`clean file not flagged: ${rel}`, !byFile.has(rel), `got ${JSON.stringify(byFile.get(rel))}`);
    }
    check("named exception allows its rule in its own file", !byFile.has(allowed), `got ${JSON.stringify(byFile.get(allowed))}`);

    const ignored = trackedButIgnored(dir);
    check("tracked file that matches .gitignore is caught", ignored.length === 1 && ignored[0] === "bench/sets/planted.local.json", `got ${JSON.stringify(ignored)}`);
    check("file that does not match .gitignore is not flagged as ignored", !ignored.includes("docs/clean-ignored-neighbour.md"));

    const plantedFiles = expected.size - 2 + clean.length + 3 + 1; // minus the 2 links, plus the clean files, the 3 other planted files and .gitignore
    check(`scanned every planted regular file (${plantedFiles})`, result.scanned === plantedFiles,
      `scanned ${result.scanned}`);
    console.log(`${checks - failed} of ${checks} self-test checks passed`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return failed;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv.includes("--self-test")) {
  process.exit(selfTest() ? 1 : 0);
}

const result = scan(ROOT, trackedFiles(ROOT));
const ignored = trackedButIgnored(ROOT);
console.log(`scanned ${result.scanned} tracked files${result.binary ? ` (${result.binary} known binary skipped: ${[...result.skipped].map(([ext, n]) => `${n} ${ext}`).join(", ")})` : ""}`);
for (const f of result.findings) console.log(f.line === null ? `${f.rel}  ${f.label}` : `${f.rel}:${f.line}  ${f.label}`);
for (const rel of ignored) console.log(`${rel}  ${IGNORED_LABEL}`);
if (result.scanned === 0) {
  console.log("FAIL: scanned 0 files, this is not the repository root");
  process.exit(1);
}
const total = result.findings.length + ignored.length;
if (total) {
  console.log(`FAIL: ${total} finding(s) in tracked files`);
  process.exit(1);
}
console.log("ok: no forbidden names, secret shapes or ignored files in tracked files");
