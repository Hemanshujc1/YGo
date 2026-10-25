// Testing Library waits 1 s for an element by default. The first render in a
// cold test worker takes longer on a busy CI runner (#286); 4 s stays inside
// Vitest's 5 s limit for a test.
import { configure } from "@testing-library/react";

configure({ asyncUtilTimeout: 4_000 });
