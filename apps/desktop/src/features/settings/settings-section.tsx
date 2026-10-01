import {
	Card,
	CardAction,
	CardContent,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";

export function SettingsSection(props: {
	title?: string;
	action?: React.ReactNode;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<Card>
			{(props.title !== undefined || props.action !== undefined) && (
				<CardHeader>
					{props.title !== undefined && <CardTitle>{props.title}</CardTitle>}
					{props.action !== undefined && (
						<CardAction>{props.action}</CardAction>
					)}
				</CardHeader>
			)}
			<CardContent className="flex flex-col divide-y divide-border">
				{props.children}
			</CardContent>
		</Card>
	);
}

export function SettingsRowHeader(props: {
	title: string;
	description: string;
}): React.ReactElement {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="font-medium text-foreground text-sm">{props.title}</span>
			<span className="text-muted-foreground text-sm">{props.description}</span>
		</div>
	);
}

export function SettingsRow(props: {
	title: string;
	description: string;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<div className="flex items-center justify-between gap-6 py-3 first:pt-0 last:pb-0">
			<SettingsRowHeader description={props.description} title={props.title} />
			{props.children}
		</div>
	);
}
