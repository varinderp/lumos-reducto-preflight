import type { PublicPipeline } from "@/lib/pricing";

export function serializeLumosProfile(pipeline: PublicPipeline) {
  return JSON.stringify(pipeline, null, 2);
}
