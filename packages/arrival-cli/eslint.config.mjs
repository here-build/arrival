import { shared } from "@here.build/eslint-configs";
// eslint-disable-next-line import-x/no-relative-packages -- repo-root overlay, not a package
import { arrivalOverlay } from "../../eslint.arrival.mjs";

export default [...shared, ...arrivalOverlay({ tsconfigRootDir: import.meta.dirname })];
