import { AnimatedEllipsis } from "../../../AnimatedEllipsis";

export function GeneratingIndicator({
  text = "Generating",
  testId,
}: {
  text?: string;
  testId?: string;
}) {
  return (
    <div className="text-description flex items-center" data-testid={testId}>
      <span className="text-2xs">{text}</span>
      <AnimatedEllipsis />
    </div>
  );
}
