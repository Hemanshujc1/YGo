import { access } from "../api";

/** Where a screen reached from More or from the setup list goes Back to: More once the shop answers orders and the tab bar exists (#550), else Home. */
export const backPath = () => (access.answersOrders() ? "/more" : "/");
