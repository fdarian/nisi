#!/usr/bin/env bun
/**
 * Renders `Casks/nisi.rb` and pushes it to the `fdarian/homebrew-tap` repo.
 * Run from CI (release.yml), after the release DMG has been built, tagged,
 * and uploaded — never by hand. No copy of the cask lives in this repo; it
 * only ever exists in the tap.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dmgPath = path.resolve("nisi-macos-arm64.dmg");
const nisiRepo = "fdarian/nisi";
const tapRepo = "fdarian/homebrew-tap";

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

async function sha256(filePath: string): Promise<string> {
	const buffer = await Bun.file(filePath).arrayBuffer();
	return new Bun.CryptoHasher("sha256").update(buffer).digest("hex");
}

function renderCask(version: string, sha256Hash: string): string {
	return `cask "nisi" do
  version "${version}"
  sha256 "${sha256Hash}"

  url "https://github.com/${nisiRepo}/releases/download/v#{version}/nisi-macos-arm64.dmg"
  name "nisi"
  desc "A simpler way to review code"
  homepage "https://github.com/fdarian/nisi"

  depends_on arch: :arm64
  depends_on macos: ">= :catalina"

  app "nisi.app"
  binary "#{appdir}/nisi.app/Contents/MacOS/nisi-cli", target: "nisi"

  zap trash: [
    "~/Library/Application Support/com.nisi.desktop",
    "~/Library/Caches/com.nisi.desktop",
  ]
end
`;
}

function run(command: string[], options: { cwd?: string } = {}): void {
	const result = Bun.spawnSync(command, {
		cwd: options.cwd,
		stdout: "inherit",
		stderr: "inherit",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`Command failed (exit ${result.exitCode}): ${command.join(" ")}`,
		);
	}
}

/** True once `Casks/nisi.rb` is staged with content that differs from HEAD. */
function hasStagedChanges(cwd: string): boolean {
	const result = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], {
		cwd,
	});
	return result.exitCode !== 0;
}

const version = requiredEnv("VERSION");
const tapToken = requiredEnv("HOMEBREW_TAP_TOKEN");

const hash = await sha256(dmgPath);
const cask = renderCask(version, hash);

const tempDir = mkdtempSync(path.join(os.tmpdir(), "homebrew-tap-"));
try {
	run([
		"git",
		"clone",
		`https://x-access-token:${tapToken}@github.com/${tapRepo}`,
		tempDir,
	]);
	run(["mkdir", "-p", path.join(tempDir, "Casks")]);
	await Bun.write(path.join(tempDir, "Casks/nisi.rb"), cask);
	run(["git", "config", "user.name", "github-actions[bot]"], {
		cwd: tempDir,
	});
	run(
		[
			"git",
			"config",
			"user.email",
			"github-actions[bot]@users.noreply.github.com",
		],
		{ cwd: tempDir },
	);
	run(["git", "add", "Casks/nisi.rb"], { cwd: tempDir });
	if (hasStagedChanges(tempDir)) {
		run(["git", "commit", "-m", `nisi ${version}`], { cwd: tempDir });
		run(["git", "push"], { cwd: tempDir });
	} else {
		console.log(`Casks/nisi.rb already up to date for ${version}, skipping.`);
	}
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
