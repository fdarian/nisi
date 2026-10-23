import { scan } from "react-scan";

declare global {
	interface Window {
		/** DevTools console switch for render highlighting; persists and reloads the window. */
		nisiReactScan: (on: boolean) => void;
	}
}

const STORAGE_KEY = "nisi:react-scan";
// react-scan persists its own options under this key and lets them override `enabled`.
const REACT_SCAN_STORAGE_KEY = "react-scan-options";

const enabled = localStorage.getItem(STORAGE_KEY) === "1";

// A stale copy would override the flag above.
localStorage.removeItem(REACT_SCAN_STORAGE_KEY);

scan({
	enabled,
	showToolbar: enabled,
	dangerouslyForceRunInProduction: true,
});

// Reloads instead of toggling live: a scan that booted disabled never instruments React,
// and `setOptions` can't enable it afterwards.
window.nisiReactScan = (on) => {
	if (on) {
		localStorage.setItem(STORAGE_KEY, "1");
	} else {
		localStorage.removeItem(STORAGE_KEY);
	}
	location.reload();
};
