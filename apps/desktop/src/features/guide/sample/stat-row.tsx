import { Note } from "@nisi/guide";
import { useState } from "react";

/** A custom component that lives next to the guide: a tiny stateful counter, to prove local `.tsx` bundles and hooks run. */
export default function StatRow(props: { label: string; values: number[] }) {
	const [index, setIndex] = useState(0);
	return (
		<Note label={props.label}>
			<button
				onClick={() => setIndex((index + 1) % props.values.length)}
				type="button"
			>
				value {index + 1} of {props.values.length}: {props.values[index]}{" "}
				(click)
			</button>
		</Note>
	);
}
