// Offering lifecycle status shared by the status page and the home dashboard,
// derived from the contract state enum (0 active, 1 failed, 2 closed), minMet,
// and the close date (unix seconds). Framework-free so node tests exercise it
// directly.
export interface StatusInfo {
  label: string;
  tone: string;
  note: string;
}

export function offeringStatus(
  offering: { state: number; minMet: boolean; closeDate: number },
  nowMs: number = Date.now(),
): StatusInfo {
  if (offering.state === 1)
    return {
      label: "Failed",
      tone: "failed",
      note: "Minimum amount not met by close date",
    };
  // closeAndWithdraw requires minMet, so closed always means a successful round.
  if (offering.state === 2)
    return { label: "Completed", tone: "secured", note: "Round closed" };
  if (offering.minMet)
    return { label: "Open", tone: "secured", note: "Minimum reached" };
  if (nowMs > offering.closeDate * 1000)
    return {
      label: "Below minimum",
      tone: "failed",
      note: "Close date passed",
    };
  return { label: "Open", tone: "funding", note: "Minimum not yet reached" };
}
