/**
 * Mirrors `AUTO_CLOSE_STORAGE_KEY` in `interstitial.ts`, which sets this
 * flag once the user confirms — via the interstitial's own button — that
 * nisi actually opened. This checkbox is the reverse path: turning
 * auto-close back off without clearing extension data.
 */
const AUTO_CLOSE_STORAGE_KEY = "autoCloseAfterHandoff";

const checkbox = document.getElementById("auto-close") as HTMLInputElement;
const status = document.getElementById("status") as HTMLElement;

async function loadSetting(): Promise<void> {
	const stored = await chrome.storage.sync.get([AUTO_CLOSE_STORAGE_KEY]);
	checkbox.checked = stored[AUTO_CLOSE_STORAGE_KEY] === true;
}

async function saveSetting(): Promise<void> {
	await chrome.storage.sync.set({ [AUTO_CLOSE_STORAGE_KEY]: checkbox.checked });
	status.textContent = "Saved.";
	setTimeout(() => {
		status.textContent = "";
	}, 1500);
}

checkbox.addEventListener("change", saveSetting);
document.addEventListener("DOMContentLoaded", loadSetting);
