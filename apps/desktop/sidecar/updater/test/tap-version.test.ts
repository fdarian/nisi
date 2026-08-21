import { describe, expect, test } from "bun:test";
import {
	compareSemver,
	isNewerVersion,
	parseCaskFileVersion,
	parseSemver,
} from "../tap-version.ts";

describe("parseSemver", () => {
	test("parses a plain x.y.z release", () => {
		expect(parseSemver("0.2.3")).toEqual({
			major: 0,
			minor: 2,
			patch: 3,
			prerelease: null,
		});
	});

	test("parses a prerelease suffix", () => {
		expect(parseSemver("1.0.0-beta.1")).toEqual({
			major: 1,
			minor: 0,
			patch: 0,
			prerelease: "beta.1",
		});
	});

	test("returns undefined for a non-semver string", () => {
		expect(parseSemver("not-a-version")).toBeUndefined();
		expect(parseSemver("1.2")).toBeUndefined();
		expect(parseSemver("v1.2.3")).toBeUndefined();
	});
});

describe("compareSemver", () => {
	const v = (raw: string) => {
		const parsed = parseSemver(raw);
		if (parsed === undefined)
			throw new Error(`unparseable test fixture: ${raw}`);
		return parsed;
	};

	test("compares major/minor/patch in order", () => {
		expect(compareSemver(v("2.0.0"), v("1.9.9"))).toBe(1);
		expect(compareSemver(v("1.3.0"), v("1.4.0"))).toBe(-1);
		expect(compareSemver(v("1.2.5"), v("1.2.4"))).toBe(1);
		expect(compareSemver(v("1.2.3"), v("1.2.3"))).toBe(0);
	});

	test("a prerelease sorts below the plain release of the same triple", () => {
		expect(compareSemver(v("1.2.3-beta"), v("1.2.3"))).toBe(-1);
		expect(compareSemver(v("1.2.3"), v("1.2.3-beta"))).toBe(1);
	});

	test("two prereleases of the same triple compare lexically", () => {
		expect(compareSemver(v("1.2.3-alpha"), v("1.2.3-beta"))).toBe(-1);
		expect(compareSemver(v("1.2.3-beta"), v("1.2.3-alpha"))).toBe(1);
	});
});

describe("isNewerVersion", () => {
	test("true when the candidate is strictly newer", () => {
		expect(isNewerVersion("0.2.4", "0.2.3")).toBe(true);
	});

	test("false on a tie", () => {
		expect(isNewerVersion("0.2.3", "0.2.3")).toBe(false);
	});

	test("false on a regression", () => {
		expect(isNewerVersion("0.2.2", "0.2.3")).toBe(false);
	});

	test("false when either side fails to parse", () => {
		expect(isNewerVersion("not-a-version", "0.2.3")).toBe(false);
		expect(isNewerVersion("0.2.4", "not-a-version")).toBe(false);
	});
});

describe("parseCaskFileVersion", () => {
	test("reads the version out of a rendered cask file", () => {
		const rendered = `cask "nisi" do
  version "0.2.4"
  sha256 "deadbeef"

  url "https://github.com/fdarian/nisi/releases/download/v#{version}/nisi-macos-arm64.dmg"
end
`;
		expect(parseCaskFileVersion(rendered)).toBe("0.2.4");
	});

	test("returns undefined when there's no version line", () => {
		expect(parseCaskFileVersion('cask "nisi" do\nend\n')).toBeUndefined();
	});
});
