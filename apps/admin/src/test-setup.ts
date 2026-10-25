// Testing Library waits 1 s for an element by default. The first render in a
// cold test worker takes longer on a busy CI runner (#286). A test can wait
// several times, so vite.config.ts gives each test 10 s in all.
import { configure } from "@testing-library/react";

configure({ asyncUtilTimeout: 4_000 });
