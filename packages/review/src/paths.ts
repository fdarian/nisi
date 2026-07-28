import { join } from "node:path";

export { getDataDirConfig } from "@repo/db";

export const getBlobsDir = (dataDir: string): string => join(dataDir, "blobs");
