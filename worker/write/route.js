// POST /capture. Reads and checks the request, then hands the write to the pipeline.
import { cleanLabel } from "../audit.js";
import { harnessId } from "../harnesses.js";
import { badRequest, json, readJson } from "../http.js";
import { normalizeTags } from "../memory/parse.js";
import { ORIGINS } from "../memory/store.js";
import { cleanHint, HINT_ORIGINS } from "../subjects/hint.js";
import { writeMemory } from "./pipeline.js";

const SOURCE_TO_ORIGIN = { "session-capture": "capture", claude: "explicit", profile: "profile", person: "person" };

/**
 * POST /capture {content, tags?, project?, source?, origin?, harness?, session?, subject?}
 * subject is the extractor's hint {name, kind} that the memory introduces a named thing. A bad hint is ignored, never an error, and only a capture or explicit write may carry one.
 * origin comes from the body, else from source, else explicit. harness comes from the body, else the X-Anymem-Harness header, and a known
 * alias is stored as its id.
 * Replies are described in ARCHITECTURE.md under the write pipeline.
 */
export async function capture({ request, env, ctx, now, maxBody, actor, memoryIds }) {
  const body = await readJson(request, maxBody);
  if (body.project !== undefined && body.project !== null && typeof body.project !== "string") throw badRequest("project must be a string.");
  const tags = [...normalizeTags(body.tags), ...(body.project ? [`project:${body.project.trim().toLowerCase()}`] : [])];
  const source = typeof body.source === "string" ? body.source : "";
  let origin = SOURCE_TO_ORIGIN[source] ?? "explicit";
  if (body.origin !== undefined) {
    if (!ORIGINS.includes(body.origin)) throw badRequest(`origin must be one of ${ORIGINS.join(", ")}.`);
    origin = body.origin;
  }
  const subject = HINT_ORIGINS.includes(origin) ? cleanHint(body.subject) ?? undefined : undefined;
  const result = await writeMemory(
    { env, ctx, now, actorId: actor.id, actorKind: actor.kind, memoryIds },
    {
      content: body.content,
      tags,
      origin,
      harness: harnessId(cleanLabel(typeof body.harness === "string" ? body.harness : request.headers.get("x-anymem-harness"))),
      session: cleanLabel(typeof body.session === "string" ? body.session : ""),
      subject,
    },
  );
  return json(result.body, result.status, result.headers);
}
