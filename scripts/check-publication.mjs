import { checkPublication } from "./check-publication.ts";

if (!(await checkPublication())) process.exitCode = 1;
