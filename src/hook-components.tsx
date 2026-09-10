import { AlertCircle } from "lucide-react";
import type { HookDelivery } from "../shared/hooks";
import { StatusBadge, type StatusTone } from "./components/ui/status";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { useDateTime } from "./date-time";

export const HOOK_REQUEST_TIMEOUT_MS = 30000;
export function restoreHookFocus(target: HTMLElement | null) {
  const element = target?.isConnected
    ? target
    : document.querySelector<HTMLElement>(".hooks-workspace h1");
  element?.focus();
}
export const HOOK_STATUS_LABELS: Record<HookDelivery["status"], string> = {
  pending: "Awaiting queue",
  queued: "Queued",
  processing: "Delivering",
  retrying: "Retrying",
  delivered: "Delivered",
  filtered: "Filtered",
  exhausted: "Needs attention",
};
const HOOK_STATUS_TONES: Record<HookDelivery["status"], StatusTone> = {
  pending: "info",
  queued: "info",
  processing: "info",
  retrying: "warning",
  delivered: "success",
  filtered: "neutral",
  exhausted: "danger",
};
export function HookStatus({ status }: { status: HookDelivery["status"] }) {
  return (
    <StatusBadge tone={HOOK_STATUS_TONES[status]} data-hook-status={status}>
      {HOOK_STATUS_LABELS[status]}
    </StatusBadge>
  );
}
export function HookTime({ value }: { value: string | null }) {
  const date = useDateTime();
  return value ? (
    <time dateTime={value} title={date.tooltip(value)}>
      {date.dateTime(value)}
    </time>
  ) : (
    <span>Not recorded</span>
  );
}
export function HookError({ error }: { error: unknown }) {
  return (
    <Alert variant="destructive" className="hook-notice">
      <AlertCircle aria-hidden="true" />
      <AlertTitle>Unable to complete this request</AlertTitle>
      <AlertDescription>
        {error instanceof Error
          ? error.message
          : "Try again after checking workspace access and provider availability."}
      </AlertDescription>
    </Alert>
  );
}
