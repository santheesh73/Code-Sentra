export { chromiumExecutable, launchPulseBrowser } from "./browser.js";
export {
  ADAPTERS,
  adapterByName,
  detectPlatform,
  type PlatformAdapter,
} from "./platforms/index.js";
export { PULSE_GROUPS, runPulse } from "./pulse.js";
export { isLoopbackHost, undefinedTokenIn } from "./render.js";
export { linksFromHtml, MAX_ROUTES } from "./routes-hygiene.js";
export type {
  EvidenceDraft,
  FindingDraft,
  PlatformIdentity,
  PulseOptions,
  PulseResult,
} from "./types.js";
