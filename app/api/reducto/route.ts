const REDUCTO_ORIGIN = "https://platform.reducto.ai";
const MAX_FILES = 15;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

async function reductoError(response: Response) {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown; error?: unknown };
    return String(parsed.detail ?? parsed.message ?? parsed.error ?? `HTTP ${response.status}`);
  } catch {
    return text.slice(0, 500) || `HTTP ${response.status}`;
  }
}

function smallUsageResponse(payload: JsonObject) {
  const result = payload.result as JsonObject | undefined;
  const pickUsage = (value: unknown) =>
    value && typeof value === "object" ? (value as JsonObject).usage ?? null : null;
  const pickUsageBreakdown = (value: unknown) =>
    value && typeof value === "object"
      ? (value as JsonObject).usage_breakdown ?? null
      : null;
  const mapStep = (value: unknown, picker: (item: unknown) => unknown) =>
    Array.isArray(value) ? value.map((item) => picker(item)) : picker(value);

  return {
    job_id: payload.job_id ?? null,
    usage: payload.usage ?? null,
    usage_breakdown: payload.usage_breakdown ?? null,
    step_usage: {
      parse: pickUsage(result?.parse),
      extract: mapStep(result?.extract, pickUsage),
      split: pickUsage(result?.split),
      edit: pickUsage(result?.edit),
    },
    step_usage_breakdown: {
      parse: pickUsageBreakdown(result?.parse),
      extract: mapStep(result?.extract, pickUsageBreakdown),
      split: pickUsageBreakdown(result?.split),
      edit: pickUsageBreakdown(result?.edit),
    },
  };
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const apiKey = String(form.get("api_key") ?? "").trim();
    const pipelineId = String(form.get("pipeline_id") ?? "").trim();
    const confirmed = form.get("confirmed") === "true";
    const files = form.getAll("files").filter((value): value is File => value instanceof File);

    if (!confirmed) {
      return Response.json({ error: "Paid Reducto work was not confirmed." }, { status: 400 });
    }
    if (!apiKey || !pipelineId) {
      return Response.json({ error: "A Reducto API key and pipeline ID are required." }, { status: 400 });
    }
    if (!files.length || files.length > MAX_FILES) {
      return Response.json({ error: `Upload between 1 and ${MAX_FILES} files.` }, { status: 400 });
    }
    if (files.some((file) => file.size > MAX_FILE_BYTES)) {
      return Response.json({ error: "Direct verification supports files up to 100 MB each." }, { status: 413 });
    }

    const authorization = { Authorization: `Bearer ${apiKey}` };
    const jobs: Array<{
      document: string;
      job_id: unknown;
      usage: unknown;
      usage_breakdown: unknown;
      step_usage: unknown;
      step_usage_breakdown: unknown;
    }> = [];

    for (const file of files) {
      const uploadBody = new FormData();
      uploadBody.append("file", file, file.name);
      const uploadResponse = await fetch(`${REDUCTO_ORIGIN}/upload`, {
        method: "POST",
        headers: authorization,
        body: uploadBody,
      });
      if (!uploadResponse.ok) {
        throw new Error(`Upload failed for ${file.name}: ${await reductoError(uploadResponse)}`);
      }
      const upload = (await uploadResponse.json()) as { file_id?: string };
      if (!upload.file_id) throw new Error(`Reducto did not return a file ID for ${file.name}.`);

      const pipelineResponse = await fetch(`${REDUCTO_ORIGIN}/pipeline`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ input: upload.file_id, pipeline_id: pipelineId }),
      });
      if (!pipelineResponse.ok) {
        throw new Error(`Pipeline failed for ${file.name}: ${await reductoError(pipelineResponse)}`);
      }
      const payload = (await pipelineResponse.json()) as JsonObject;
      jobs.push({ document: file.name, ...smallUsageResponse(payload) });
    }

    return Response.json({
      verified_by: "reducto",
      note: "These are Reducto's returned usage fields. Your contract rate card remains the billing source of truth.",
      jobs,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The Reducto verification failed." },
      { status: 502 },
    );
  }
}
