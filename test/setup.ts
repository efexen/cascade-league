import { afterAll } from "vitest";
import { cleanupTrackedTestTempRoots } from "./helpers/temp-roots.js";

afterAll(async () => {
  await cleanupTrackedTestTempRoots();
});
