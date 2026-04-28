"use client";

import type { UIMessage } from "@ai-sdk/react";
import { archestraApiSdk } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { FileText, Lock, Paperclip, Users } from "lucide-react";
import { use, useMemo } from "react";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Response } from "@/components/ai-elements/response";
import { extractFileAttachments } from "@/components/chat/chat-messages.utils";
import type { FileAttachment } from "@/components/chat/editable-user-message";
import {
  getAttachmentFallbackLabel,
  isCsvAttachment,
  isPlainTextAttachment,
} from "@/lib/chat/chat-attachment-display";
import { useAppName } from "@/lib/hooks/use-app-name";

const { getPublicSharedConversation } = archestraApiSdk;

export default function PublicSharedConversationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const appName = useAppName();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["public-shared-conversation", token],
    queryFn: async () => {
      const response = await getPublicSharedConversation({
        path: { token },
      });
      if (response.error) {
        return null;
      }
      return response.data;
    },
    retry: false,
    staleTime: Infinity,
  });

  // Memoize so message ids stay stable across renders — keys derived from
  // array index would otherwise re-mount rows on every parent re-render.
  const messages = useMemo(
    () => renderableMessages(data?.messages),
    [data?.messages],
  );

  if (isLoading) {
    return <CenteredMessage title="Loading shared chat…" />;
  }

  if (isError || !data) {
    return (
      <CenteredMessage
        icon={<Lock className="h-10 w-10 text-muted-foreground" />}
        title="This shared chat is no longer available"
        body="The link may have been revoked, or it never existed. Ask the person who shared it for an updated link."
      />
    );
  }

  return (
    <main className="flex h-screen w-full flex-col bg-background">
      <header className="flex items-center justify-between gap-4 border-b bg-background/95 px-6 py-4 backdrop-blur supports-backdrop-filter:bg-background/80">
        <h1 className="truncate text-base font-semibold leading-tight text-foreground">
          {data.title?.trim() || "Shared chat"}
        </h1>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">
          <Users className="h-3.5 w-3.5" />
          Shared
        </span>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-1 px-4 py-6 sm:px-6">
          {messages.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              This conversation has no visible messages.
            </p>
          ) : (
            messages.map((message) => (
              <PublicMessageRow key={message.id} message={message} />
            ))
          )}
          <p className="mt-6 text-center text-xs text-muted-foreground">
            Read-only view shared via {appName}. Replies are disabled.
          </p>
        </div>
      </div>
    </main>
  );
}

type RenderableMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  attachments: FileAttachment[];
};

// The public payload mirrors AI SDK UIMessage but we only need text + file
// parts here. Tool calls are skipped (no runtime in the read-only view).
function renderableMessages(
  rawMessages: unknown[] | undefined,
): RenderableMessage[] {
  if (!rawMessages) return [];

  const result: RenderableMessage[] = [];

  for (let i = 0; i < rawMessages.length; i++) {
    const raw = rawMessages[i];
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Partial<UIMessage>;

    const role = normalizeRole(message.role);
    if (!role) continue;
    const text = extractText(message.parts);
    const attachments = extractFileAttachments(message.parts) ?? [];

    if (!text && attachments.length === 0) continue;

    result.push({
      id: message.id ?? `idx-${i}`,
      role,
      text,
      attachments,
    });
  }

  return result;
}

function normalizeRole(
  role: string | undefined,
): RenderableMessage["role"] | null {
  if (role === "user" || role === "assistant" || role === "system") {
    return role;
  }
  return null;
}

function extractText(parts: UIMessage["parts"] | undefined): string {
  if (!parts?.length) return "";
  return parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function PublicMessageRow({ message }: { message: RenderableMessage }) {
  const images = message.attachments.filter((a) =>
    a.mediaType.startsWith("image/"),
  );
  const files = message.attachments.filter(
    (a) => !a.mediaType.startsWith("image/"),
  );
  const isUser = message.role === "user";
  const itemsAlign = isUser ? "items-end" : "items-start";
  const justifyAlign = isUser ? "justify-end" : "justify-start";

  return (
    <Message from={message.role}>
      <div className={`flex w-full flex-col gap-2 ${itemsAlign}`}>
        {images.length > 0 && (
          <div className={`flex flex-wrap gap-1 ${justifyAlign}`}>
            {images.map((attachment) => (
              <img
                key={attachment.url}
                src={attachment.url}
                alt={attachment.filename || "Attached image"}
                className="max-h-48 rounded-lg object-cover"
              />
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className={`flex flex-wrap gap-1 ${justifyAlign}`}>
            {files.map((attachment) => (
              <a
                key={attachment.url}
                href={attachment.url}
                target="_blank"
                rel="noopener noreferrer"
                title={attachment.filename}
                className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/50 p-2 text-sm hover:bg-muted"
              >
                {isCsvAttachment(attachment.mediaType, attachment.filename) ||
                isPlainTextAttachment(
                  attachment.mediaType,
                  attachment.filename,
                ) ? (
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="max-w-[200px] truncate">
                  {attachment.filename ||
                    getAttachmentFallbackLabel({
                      mediaType: attachment.mediaType,
                      filename: attachment.filename,
                    })}
                </span>
              </a>
            ))}
          </div>
        )}
        {message.text && (
          <MessageContent>
            <Response>{message.text}</Response>
          </MessageContent>
        )}
      </div>
    </Message>
  );
}

function CenteredMessage({
  icon,
  title,
  body,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: string;
}) {
  return (
    <main className="flex h-screen w-full items-center justify-center bg-background px-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        {icon}
        <h1 className="text-lg font-semibold">{title}</h1>
        {body && <p className="text-sm text-muted-foreground">{body}</p>}
      </div>
    </main>
  );
}
