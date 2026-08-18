import { getAltKeyLabel, getMetaKeyLabel, isJetBrains } from "../../../../util";
import { useAppSelector } from "../../../../redux/hooks";
import { latestStreamingStatusText } from "../../../../util/streamingStatusText";
import { GeneratingIndicator } from "./GeneratingIndicator";

interface StreamingToolbarProps {
  onStop: () => void;
  displayText?: string;
}

export function StreamingToolbar({
  onStop,
  displayText = "Stop",
}: StreamingToolbarProps) {
  const jetbrains = isJetBrains();
  const history = useAppSelector((state) => state.session.history);
  const streamingStatusText = useAppSelector(
    (state) => state.session.streamingStatusText,
  );
  const statusText = streamingStatusText || latestStreamingStatusText(history);

  return (
    <div className="flex w-full items-center justify-between">
      <GeneratingIndicator text={statusText || "Generating"} />
      <div
        onClick={onStop}
        className="text-2xs cursor-pointer px-1.5 py-0.5 hover:brightness-125"
      >
        <span className="text-description">{displayText}</span>
        {/* JetBrains overrides cmd+backspace, so we have to use another shortcut */}
        <span className="text-description-muted ml-1 opacity-75">
          {jetbrains ? getAltKeyLabel() : getMetaKeyLabel()}⌫
        </span>
      </div>
    </div>
  );
}
