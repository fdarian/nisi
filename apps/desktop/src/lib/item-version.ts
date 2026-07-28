/**
 * `@pierre/diffs`' `CodeViewItem.version` is a plain number the library
 * compares to decide whether a virtualized row needs re-measuring — it isn't
 * a cache key, just a change signal. Folding every input that should trigger
 * a re-render (file fingerprint, diff style, viewed state, selection) into
 * one string and hashing it here means only the file whose inputs actually
 * changed gets a new version, so CodeView leaves every other row's layout
 * and highlight cache untouched. Same technique as codiff's `getItemVersion`.
 */
export function hashItemVersion(value: string): number {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) {
		hash = (hash << 5) - hash + value.charCodeAt(index);
		hash |= 0;
	}
	return hash >>> 0;
}
