import { createContext, useContext } from "react";

export const AppViewActiveContext = createContext(true);

export function useAppViewActive(): boolean {
	return useContext(AppViewActiveContext);
}
