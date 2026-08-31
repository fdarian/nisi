/**
 * Stay-vs-close radios (default stay) + a scheme field (default `nisi`),
 * persisted to `chrome.storage.sync` — `background.js` reads both fresh on
 * every hand-off rather than caching them, so a change here takes effect
 * immediately. The scheme field is what lets the extension target a
 * `nisi-dev` build without a code edit.
 */
const DEFAULT_SCHEME = "nisi";
const DEFAULT_TAB_BEHAVIOR = "stay";

const form = /** @type {HTMLFormElement} */ (
	document.getElementById("options-form")
);
const schemeInput = /** @type {HTMLInputElement} */ (
	document.getElementById("scheme")
);
const status = /** @type {HTMLElement} */ (document.getElementById("status"));

async function loadOptions() {
	const stored = await chrome.storage.sync.get(["scheme", "tabBehavior"]);
	schemeInput.value =
		typeof stored.scheme === "string" ? stored.scheme : DEFAULT_SCHEME;

	const tabBehavior =
		stored.tabBehavior === "close" ? "close" : DEFAULT_TAB_BEHAVIOR;
	const radio = form.querySelector(
		`input[name="tabBehavior"][value="${tabBehavior}"]`,
	);
	if (radio instanceof HTMLInputElement) radio.checked = true;
}

async function saveOptions() {
	const checkedRadio = form.querySelector('input[name="tabBehavior"]:checked');
	const tabBehavior =
		checkedRadio instanceof HTMLInputElement && checkedRadio.value === "close"
			? "close"
			: DEFAULT_TAB_BEHAVIOR;
	const scheme = schemeInput.value.trim() || DEFAULT_SCHEME;

	await chrome.storage.sync.set({ scheme, tabBehavior });
	status.textContent = "Saved.";
	setTimeout(() => {
		status.textContent = "";
	}, 1500);
}

form.addEventListener("change", saveOptions);
document.addEventListener("DOMContentLoaded", loadOptions);
