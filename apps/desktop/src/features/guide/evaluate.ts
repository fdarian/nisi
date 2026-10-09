import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as ReactDom from "react-dom";
import * as kit from "./kit";

export type GuideComponent = React.ComponentType<{
	components?: Record<string, React.ComponentType<never>>;
}>;

/**
 * Guides are built with the production JSX transform (`sidecar/guide/build.ts`),
 * so this only matters for a custom component that still reaches for the dev
 * runtime — React's production build of that module exports no `jsxDEV`.
 */
const JsxDevRuntime = {
	Fragment: JsxRuntime.Fragment,
	jsxDEV: (type: unknown, props: unknown, key: unknown) =>
		JsxRuntime.jsx(type as never, props as never, key as never),
};

/** Must list exactly the bundler's `EXTERNALS` (`sidecar/guide/build.ts`). */
const MODULES = new Map<string, unknown>([
	["react", React],
	["react/jsx-runtime", JsxRuntime],
	["react/jsx-dev-runtime", JsxDevRuntime],
	["react-dom", ReactDom],
	["@nisi/guide", kit],
]);

function guideRequire(specifier: string): unknown {
	const resolved = MODULES.get(specifier);
	if (resolved === undefined) {
		throw new Error(
			`Guide imported "${specifier}", which the Guide tab doesn't provide. Use react or @nisi/guide, or a relative file.`,
		);
	}
	return resolved;
}

const MAX_CACHED = 16;
const cache = new Map<string, GuideComponent>();

/** Memoized on `version`: the Guide tab polls, and re-evaluating an unchanged bundle would remount the whole guide. */
export function evaluateGuide(version: string, code: string): GuideComponent {
	const cached = cache.get(version);
	if (cached !== undefined) return cached;

	const module: { exports: { default?: unknown } } = { exports: {} };
	new Function("require", "module", "exports", code)(
		guideRequire,
		module,
		module.exports,
	);
	const component = module.exports.default;
	if (typeof component !== "function") {
		throw new Error("guide.mdx didn't produce a default export");
	}
	if (cache.size >= MAX_CACHED) cache.clear();
	cache.set(version, component as GuideComponent);
	return component as GuideComponent;
}
