import { native } from "#/infra/native";

/** `async` so `native()` throwing outside the app becomes a rejection callers can `.catch`. */
export async function sendOsNotification(message: {
	title: string;
	body: string;
}): Promise<void> {
	return native().sendNotification(message);
}
