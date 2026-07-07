import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const releaseRoot = path.join(root, "dist");
const pluginDir = path.join(releaseRoot, manifest.id);
const zipPath = path.join(releaseRoot, `${manifest.id}-${manifest.version}.zip`);

fs.rmSync(releaseRoot, { recursive: true, force: true });
fs.mkdirSync(pluginDir, { recursive: true });

for (const file of ["main.js", "manifest.json", "styles.css"]) {
  fs.copyFileSync(path.join(root, file), path.join(pluginDir, file));
}

fs.cpSync(path.join(root, "bundled-laws"), path.join(pluginDir, "bundled-laws"), {
  recursive: true
});

try {
  childProcess.execFileSync("zip", ["-qr", zipPath, manifest.id], {
    cwd: releaseRoot,
    stdio: "inherit"
  });
  console.log(`Created ${zipPath}`);
} catch {
  console.log("zip command not available; release folder created without zip archive.");
}

console.log(`Release folder: ${pluginDir}`);
