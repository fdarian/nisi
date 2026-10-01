import { useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { sendOsNotification } from "#/infra/os-notification";

export function TestNotificationButton(props: {
	disabled: boolean;
}): React.ReactElement {
	const [deadline, setDeadline] = useState<number | null>(null);
	const [now, setNow] = useState(Date.now);
	const disabled = useRef(props.disabled);
	disabled.current = props.disabled;

	useEffect(() => {
		if (props.disabled) {
			setDeadline(null);
			return;
		}
		if (deadline === null) return;

		const timer = window.setInterval(() => {
			if (disabled.current) {
				window.clearInterval(timer);
				setDeadline(null);
				return;
			}
			const currentTime = Date.now();
			setNow(currentTime);
			if (currentTime < deadline) return;
			window.clearInterval(timer);
			setDeadline(null);
			sendOsNotification({
				title: "nisi",
				body: "Notifications are working.",
			});
		}, 100);
		return () => window.clearInterval(timer);
	}, [deadline, props.disabled]);

	const remaining =
		deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
	return (
		<Button
			className="min-w-36 tabular-nums"
			disabled={props.disabled || deadline !== null}
			onClick={() => {
				const currentTime = Date.now();
				setNow(currentTime);
				setDeadline(currentTime + 5000);
			}}
			size="sm"
			variant="outline"
		>
			{remaining === null ? "Send test" : `Sending in ${remaining}s…`}
		</Button>
	);
}
