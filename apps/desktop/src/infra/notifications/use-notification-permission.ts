import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useWindowFocused } from "../use-window-focused";
import { notificationPermission } from "./os-notification";

export function useNotificationPermission() {
	const focused = useWindowFocused();
	const query = useQuery({
		queryKey: ["notification-permission"],
		queryFn: notificationPermission,
	});
	const refetch = query.refetch;
	useEffect(() => {
		if (focused) void refetch();
	}, [focused, refetch]);
	return query;
}
