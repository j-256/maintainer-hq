export function pendingReview(
  kind: "organization" | "expectations" | "fleet",
  workspaceId: string,
  planId: string,
  value?: boolean,
) {
  try {
    const key = "hq." + kind + ".pending.v1." + workspaceId + "." + planId;
    if (value === true) sessionStorage.setItem(key, "1");
    if (value === false) sessionStorage.removeItem(key);
    return sessionStorage.getItem(key) === "1";
  } catch {
    return true;
  }
}
