import { CircleAlertIcon } from "lucide-react";
import { SHORT_SHA } from "./kit/checks";

/** A guide validated at a commit other than the branch's head may describe code that has since changed. A guide never validated (`null`) says nothing about that. */
export function validatedAtOtherCommit(
	validatedSha: string | null,
	headSha: string,
): validatedSha is string {
	return validatedSha !== null && validatedSha !== headSha;
}

/** Renders nothing when the guide was validated at the head (or never). */
export function GuideValidationNotice(props: {
	validatedSha: string | null;
	headSha: string;
}): React.ReactElement | null {
	if (!validatedAtOtherCommit(props.validatedSha, props.headSha)) return null;
	return (
		<div
			className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/12 px-3 py-2 text-amber-500 text-xs"
			role="status"
		>
			<CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
			<p className="m-0">
				This guide was validated at{" "}
				<code className="font-mono">
					{props.validatedSha.slice(0, SHORT_SHA)}
				</code>
				. The branch has moved to{" "}
				<code className="font-mono">{props.headSha.slice(0, SHORT_SHA)}</code>{" "}
				since.
			</p>
		</div>
	);
}
