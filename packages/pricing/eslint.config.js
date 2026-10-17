import { base, moneyPaths } from "@ygo/eslint-config";

export default [...base, ...moneyPaths(["src/**"])];
