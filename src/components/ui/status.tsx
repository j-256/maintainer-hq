import type { ComponentProps } from "react";
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  Info,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "./badge";
import "./status.css";

const STATUS_ICONS = {
  success: CircleCheck,
  danger: CircleX,
  warning: TriangleAlert,
  info: Info,
  neutral: CircleHelp,
} as const;

export type StatusTone = keyof typeof STATUS_ICONS;

export function StatusIcon({
  tone,
  className,
  ...props
}: ComponentProps<typeof CircleCheck> & { tone: StatusTone }) {
  const Icon = STATUS_ICONS[tone];
  return (
    <Icon
      size={16}
      {...props}
      aria-hidden="true"
      className={cn("status-icon", className)}
      data-tone={tone}
    />
  );
}

export function StatusBadge({
  tone = "neutral",
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Badge>, "variant" | "asChild"> & {
  tone?: StatusTone;
}) {
  return (
    <Badge
      {...props}
      variant="outline"
      className={cn("status-badge", className)}
      data-tone={tone}
    >
      <StatusIcon tone={tone} />
      {children}
    </Badge>
  );
}
