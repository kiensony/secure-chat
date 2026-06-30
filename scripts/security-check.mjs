import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCANNED_DIRS = ["src", "server"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".html"]);

const forbiddenSinks = [
  { label: "React raw HTML sink", pattern: /dangerouslySetInnerHTML/ },
  { label: "DOM innerHTML assignment", pattern: /\.innerHTML\s*=/ },
  { label: "DOM outerHTML assignment", pattern: /\.outerHTML\s*=/ },
  { label: "DOM HTML insertion", pattern: /insertAdjacentHTML\s*\(/ },
  { label: "Dynamic eval", pattern: /\beval\s*\(/ },
  { label: "Dynamic Function constructor", pattern: /new\s+Function\b/ },
  { label: "document.write", pattern: /document\.write(?:ln)?\s*\(/ }
];

const failures = [];

for (const file of listSourceFiles()) {
  const content = readFileSync(file, "utf8");
  for (const sink of forbiddenSinks) {
    if (sink.pattern.test(content)) {
      failures.push(`${relative(file)}: forbidden ${sink.label}`);
    }
  }
}

const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
if (!indexHtml.includes("Content-Security-Policy")) {
  failures.push("index.html: missing Content-Security-Policy meta tag");
}

const signalingServer = readFileSync(join(ROOT, "server", "signalingServer.ts"), "utf8");
if (!signalingServer.includes("helmet(")) {
  failures.push("server/signalingServer.ts: missing Helmet security header middleware");
}

const sensitiveLogPattern = /console\.(?:log|error|warn|info)\([^)]*(?:payload|sdp|candidate|private|passphrase|ciphertext|file|messageText)[^)]*\)/i;
for (const file of listSourceFiles(["server"])) {
  const content = readFileSync(file, "utf8");
  if (sensitiveLogPattern.test(content)) {
    failures.push(`${relative(file)}: console logging appears to include sensitive signaling or message data`);
  }
}

const appSource = readFileSync(join(ROOT, "src", "App.tsx"), "utf8");
if (/signalingRef\.current\?\.send\([^)]*(?:chat|file_)/s.test(appSource)) {
  failures.push("src/App.tsx: chat or file payload appears to be sent over signaling");
}

if (failures.length > 0) {
  console.error("Security static checks failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("Security static checks passed.");
}

function listSourceFiles(dirs = SCANNED_DIRS) {
  return dirs.flatMap((dir) => walk(join(ROOT, dir)));
}

function walk(path) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
  }

  const extension = path.slice(path.lastIndexOf("."));
  return SOURCE_EXTENSIONS.has(extension) ? [path] : [];
}

function relative(path) {
  return path.slice(ROOT.length + 1);
}
