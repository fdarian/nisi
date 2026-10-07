import { SearchIcon, SlidersHorizontalIcon, XIcon } from "lucide-react";
import { type RefObject, useRef } from "react";
import { Button, buttonVariants } from "#/components/ui/button";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "#/components/ui/input-group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import type { SearchMode } from "./files-sidebar";

export function FilesFilter(props: {
	disabled?: boolean;
	query: string;
	mode: SearchMode;
	inputRef?: RefObject<HTMLInputElement | null>;
	onQueryChange?: (query: string) => void;
	onModeChange?: (mode: SearchMode) => void;
	onSubmit?: () => void;
}): React.ReactElement {
	const localRef = useRef<HTMLInputElement>(null);
	const inputRef = props.inputRef === undefined ? localRef : props.inputRef;
	return (
		<div className="p-2">
			<InputGroup>
				<InputGroupAddon>
					<SearchIcon className="size-3.5" />
				</InputGroupAddon>
				<InputGroupInput
					disabled={props.disabled}
					aria-label={
						props.mode === "keyword" ? "Search diff content" : "Filter files"
					}
					onChange={(event) => props.onQueryChange?.(event.currentTarget.value)}
					onKeyDown={(event) => {
						// Prevent Chromium's native search clearing; Escape only blurs so navigation shortcuts work next.
						if (event.key === "Escape" || event.key === "Enter") {
							event.preventDefault();
							if (event.key === "Enter") props.onSubmit?.();
							event.currentTarget.blur();
						}
					}}
					placeholder={
						props.mode === "keyword" ? "Search in diffs…" : "Filter files…"
					}
					ref={inputRef}
					type="search"
					value={props.query}
				/>
				{props.query.length > 0 && (
					<InputGroupAddon align="inline-end">
						<Button
							disabled={props.disabled}
							variant="ghost"
							size="icon-xs"
							aria-label="Clear filter"
							onClick={() => {
								props.onQueryChange?.("");
								inputRef.current?.focus();
							}}
							type="button"
						>
							<XIcon aria-hidden="true" />
						</Button>
					</InputGroupAddon>
				)}
				<InputGroupAddon align="inline-end">
					<DropdownMenu>
						<DropdownMenuTrigger
							disabled={props.disabled}
							aria-label="Search mode"
							className={buttonVariants({ variant: "ghost", size: "icon-xs" })}
						>
							<SlidersHorizontalIcon aria-hidden="true" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuRadioGroup
								onValueChange={(value) => {
									if (value === "files" || value === "keyword")
										props.onModeChange?.(value);
								}}
								value={props.mode}
							>
								<DropdownMenuRadioItem closeOnClick value="files">
									Files
								</DropdownMenuRadioItem>
								<DropdownMenuRadioItem closeOnClick value="keyword">
									Keyword
								</DropdownMenuRadioItem>
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				</InputGroupAddon>
			</InputGroup>
		</div>
	);
}
