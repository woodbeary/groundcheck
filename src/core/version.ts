import { readFileSync } from "node:fs";

/** This package's version, recorded as the reference readers' version in the provenance log. */
export const VERSION: string = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
