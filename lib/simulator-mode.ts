import type { PublicPipeline } from "./pricing";

export function simulatorModeLabel(pipeline: PublicPipeline) {
  const modes: string[] = [];

  if (pipeline.parse != null) {
    modes.push(pipeline.parse.settings?.model === "r-1" ? "r‑1 Parse (Beta)" : "Parse");
  }
  if (pipeline.classify != null) modes.push("Classify");

  if (pipeline.extract != null) {
    if (pipeline.lumos_assumptions?.conditional_extract_routing === true) {
      modes.push("Standard or Deep Extract");
    } else if (pipeline.extract.settings?.deep_extract === true) {
      modes.push("Deep Extract");
    } else {
      modes.push("Standard Extract");
    }
  }

  if (pipeline.split != null) {
    modes.push(pipeline.split.settings?.deep_split === true ? "Deep Split" : "Split");
  }

  if (pipeline.edit != null) modes.push("Edit");

  return modes.length > 0 ? modes.join(" + ") : "No priced operation";
}
