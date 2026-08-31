/**
 * Stay-vs-close radios (default stay), persisted to `chrome.storage.sync` —
 * `background.js` reads it fresh on every hand-off rather than caching it,
 * so a change here takes effect immediately.
 */
const DEFAULT_TAB_BEHAVIOR = "stay";

const form = /** @type {HTMLFormElement} */ (
	document.getElementById("options-form")
);
const status = /** @type {HTMLElement} */ (document.getElementById("status"));

async function loadOptions() {
	const stored = await chrome.storage.sync.get(["tabBehavior"]);

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

	await chrome.storage.sync.set({ tabBehavior });
	status.textContent = "Saved.";
	setTimeout(() => {
		status.textContent = "";
	}, 1500);
}

form.addEventListener("change", saveOptions);
document.addEventListener("DOMContentLoaded", loadOptions);
