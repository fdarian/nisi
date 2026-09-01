/**
 * Mirrors `AUTO_CLOSE_STORAGE_KEY` in `interstitial.js`, which sets this
 * flag once the user confirms — via the interstitial's own button — that
 * nisi actually opened. This checkbox is the reverse path: turning
 * auto-close back off without clearing extension data.
 */
const AUTO_CLOSE_STORAGE_KEY = "autoCloseAfterHandoff";

const checkbox = /** @type {HTMLInputElement} */ (
	document.getElementById("auto-close")
);
const status = /** @type {HTMLElement} */ (document.getElementById("status"));

async function loadSetting() {
	const stored = await chrome.storage.sync.get([AUTO_CLOSE_STORAGE_KEY]);
	checkbox.checked = stored[AUTO_CLOSE_STORAGE_KEY] === true;
}

async function saveSetting() {
	await chrome.storage.sync.set({ [AUTO_CLOSE_STORAGE_KEY]: checkbox.checked });
	status.textContent = "Saved.";
	setTimeout(() => {
		status.textContent = "";
	}, 1500);
}

checkbox.addEventListener("change", saveSetting);
document.addEventListener("DOMContentLoaded", loadSetting);
