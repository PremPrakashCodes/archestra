import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, toApiError } from "@/lib/utils";

const { uploadSandboxFile } = archestraApiSdk;

/**
 * Drag-and-drop / programmatic upload of a single file straight into the
 * conversation-scoped sandbox pod's `/workspace` volume. The bytes never pass
 * through the LLM, so this is the cheap path for "drop a CSV, ask the agent
 * to read it".
 *
 * Hard cap on the wire is enforced by the backend
 * (`ARCHESTRA_ORCHESTRATOR_SANDBOX_FILE_UPLOAD_MAX_MIB`); the panel's
 * pre-check just gives the user a fast rejection without a round-trip.
 */
export const SANDBOX_FILE_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;

export type SandboxUploadResult =
  archestraApiTypes.UploadSandboxFileResponses["200"];

export function useSandboxFileUpload() {
  return useMutation({
    mutationFn: async ({
      conversationId,
      file,
    }: {
      conversationId: string;
      file: File;
    }) => {
      if (file.size > SANDBOX_FILE_UPLOAD_MAX_BYTES) {
        const err = new Error(
          `File exceeds the ${SANDBOX_FILE_UPLOAD_MAX_BYTES / (1024 * 1024)} MiB upload limit`,
        );
        toast.error(err.message);
        throw err;
      }

      const formData = new FormData();
      formData.append("file", file, file.name);

      const { data, error } = await uploadSandboxFile({
        path: { conversationId },
        body: formData as unknown as never,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data as SandboxUploadResult;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success(`Uploaded ${data.filename} to sandbox`);
    },
  });
}
