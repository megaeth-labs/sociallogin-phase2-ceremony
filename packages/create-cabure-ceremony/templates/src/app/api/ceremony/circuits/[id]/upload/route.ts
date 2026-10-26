import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

import { getCeremonyConfig } from "@/lib/ceremony-config";
import {
  getAllCircuitStates,
  getCircuitState,
  getManifest,
  hasParticipantContributedToCircuit,
  isCeremonyActive,
  pruneExpiredEntries,
} from "@/lib/ceremony-state";
import { getParticipant } from "@/lib/participant-auth";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const participant = await getParticipant(request);
        if (!participant) {
          throw new Error("Unauthorized");
        }

        // Bind the upload to this participant's own namespace. The contribute
        // route deletes rejected uploads with the server's RW token and accepts
        // any URL under the circuit prefix; enforcing the per-participant path
        // here means a caller can only ever place (and thus later trigger
        // deletion of) blobs under their own id, never another participant's.
        const expectedPath = `contributions/${id}/${participant.participantId}/pending.zkey`;
        if (pathname !== expectedPath) {
          throw new Error("Invalid upload path");
        }

        const config = getCeremonyConfig();
        const manifest = await getManifest();
        const allCircuits = await getAllCircuitStates();

        if (!isCeremonyActive(manifest, allCircuits)) {
          throw new Error("Ceremony is not active");
        }

        if (
          await hasParticipantContributedToCircuit(
            participant.participantId,
            id,
          )
        ) {
          throw new Error("You have already contributed to this circuit");
        }

        const circuit = await getCircuitState(id);
        const pruned = pruneExpiredEntries(
          circuit.queue,
          config.queueTimeoutSeconds,
        );

        if (pruned[0]?.participantId !== participant.participantId) {
          throw new Error("Not at front of the queue");
        }

        return {
          allowedContentTypes: ["application/octet-stream"],
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({
            participantId: participant.participantId,
            circuitId: id,
          }),
        };
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "Unauthorized" ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
