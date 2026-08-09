import type { Logger } from "../../common/logging";
import type { ClineAdapter } from "./types";
import { LegacyCline416Adapter } from "./legacy_4_1_6";

export function createClineAdapter(logger: Logger): ClineAdapter {
  return new LegacyCline416Adapter(logger);
}
