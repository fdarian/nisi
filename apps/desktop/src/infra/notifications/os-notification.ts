import { native } from "#/infra/native";

export function sendOsNotification(message: {
	title: string;
	body: string;
}): Promise<void> {
	return native().sendNotification(message);
}
