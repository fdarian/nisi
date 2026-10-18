const pending: string[] = [];
let taken = false;

/** `forward` is called instead of buffering once the frontend has taken its backlog. */
export function receiveDeepLink(url: string, forward: (url: string) => void) {
	if (taken) {
		forward(url);
	} else {
		pending.push(url);
	}
}

export function takePendingDeepLinks(): string[] {
	taken = true;
	return pending.splice(0);
}
