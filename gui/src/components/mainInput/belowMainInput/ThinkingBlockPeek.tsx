// src/components/ThinkingBlockPeek.tsx
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { ChevronUpIcon } from "@heroicons/react/24/solid";
import { ChatHistoryItem } from "core";
import { useEffect, useRef, useState } from "react";
import styled from "styled-components";

import { AnimatedEllipsis } from "../../AnimatedEllipsis";
import StyledMarkdownPreview from "../../StyledMarkdownPreview";
import { Button } from "../../ui";
import {
  lastNonEmptyLine,
  looksLikeAoProgress,
  sanitizeThinkingLine,
  thinkingLogLines,
} from "../../../util/streamingStatusText";

const MarkdownWrapper = styled.div`
  font-size: 0.6875rem;
  line-height: 1.45;
  color: var(--vscode-descriptionForeground, #9d9d9d);

  & > div > *:first-child {
    margin-top: 0 !important;
  }

  p,
  li {
    font-size: inherit;
    line-height: inherit;
  }
`;

interface ThinkingBlockPeekProps {
  content: string;
  redactedThinking?: string;
  index: number;
  prevItem: ChatHistoryItem | null;
  inProgress?: boolean;
  signature?: string;
  tokens?: number;
}

function ThinkingBlockPeek({
  content,
  redactedThinking,
  index,
  prevItem,
  inProgress,
  tokens,
}: ThinkingBlockPeekProps) {
  const [open, setOpen] = useState(() => looksLikeAoProgress(content));
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState<string>("");
  const logRef = useRef<HTMLDivElement>(null);
  const progressLabel = lastNonEmptyLine(content);
  const logLines = thinkingLogLines(content)
    .map(sanitizeThinkingLine)
    .filter((line): line is string => line !== null);
  const showAoLog = looksLikeAoProgress(content);

  const duplicateRedactedThinkingBlock =
    prevItem &&
    prevItem.message.role === "thinking" &&
    redactedThinking &&
    prevItem.message.redactedThinking;

  useEffect(() => {
    if (looksLikeAoProgress(content)) {
      setOpen(true);
    }
  }, [content]);

  useEffect(() => {
    if (inProgress) {
      setStartTime(Date.now());
      setElapsedTime("");
    } else if (startTime) {
      const endTime = Date.now();
      const diff = endTime - startTime;
      const diffString = `${(diff / 1000).toFixed(1)}s`;
      setElapsedTime(diffString);
    }
  }, [inProgress]);

  useEffect(() => {
    if (inProgress && open && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [content, inProgress, open]);

  return duplicateRedactedThinkingBlock ? null : (
    <div className="thread-message">
      <div className="mt-1 flex flex-col px-4">
        <div>
          <Button
            variant="outline"
            className="text-description flex-0 border-border text-2xs m-0 mb-1.5 flex min-w-0 cursor-pointer flex-row items-center gap-1.5 rounded-full border-[0.5px] border-solid px-3 transition-colors duration-200 ease-in-out hover:brightness-125"
            data-testid="thinking-block-peek"
            aria-expanded={open}
            aria-controls={`thinking-block-content-${index}`}
            onClick={() => setOpen(!open)}
          >
            {inProgress ? (
              <span>
                {redactedThinking
                  ? "Redacted Thinking"
                  : progressLabel || "Thinking"}
                <AnimatedEllipsis />
              </span>
            ) : redactedThinking ? (
              "Redacted Thinking"
            ) : (
              "Thought" +
              (elapsedTime ? ` for ${elapsedTime}` : "") +
              (tokens ? ` (${tokens} tokens)` : "")
            )}
            {open ? (
              <ChevronUpIcon className="h-3 w-3" />
            ) : (
              <ChevronDownIcon className="h-3 w-3" />
            )}
          </Button>
        </div>
        <div
          id={`thinking-block-content-${index}`}
          ref={logRef}
          className={`overflow-y-auto transition-all duration-300 ease-in-out ${
            open ? "max-h-[30vh] opacity-100" : "max-h-0 opacity-0"
          }`}
        >
          {redactedThinking ? (
            <div className="text-description-muted text-2xs pl-5 italic">
              Thinking content redacted due to safety reasons.
            </div>
          ) : showAoLog ? (
            <ul className="text-description-muted text-2xs m-0 list-none py-0.5 pl-1 pr-2 leading-snug">
              {logLines.map((line, lineIndex) => (
                <li
                  key={`${lineIndex}:${line}`}
                  className={
                    inProgress && lineIndex === logLines.length - 1
                      ? "text-description"
                      : ""
                  }
                >
                  {line}
                </li>
              ))}
            </ul>
          ) : (
            <MarkdownWrapper>
              <StyledMarkdownPreview
                isRenderingInStepContainer
                source={content}
                itemIndex={index}
              />
            </MarkdownWrapper>
          )}
        </div>
      </div>
    </div>
  );
}

export default ThinkingBlockPeek;
