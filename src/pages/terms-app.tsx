// Reference copy of the PACT template. With no ?offering= param, renders the
// blank template with bracketed placeholders. With one, loads the offering's
// live state and fills each blank so buyers can inspect the exact document
// they are agreeing to. The cap-table exhibit and curve chart are omitted —
// they belong on the status page.
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useAccount } from "wagmi";

import { useOfferingState } from "#hooks/use-offering-state.ts";
import { getProjectName } from "#lib/chain/onchain.ts";
import { currentOfferingAddress } from "#lib/routes.ts";
import {
  deriveFilledTerms,
  TermsBody,
  TermsHeading,
  TermsLoadNotice,
} from "#pages/terms-body.tsx";

const offeringAddress = currentOfferingAddress();

export function TermsApp() {
  const wallet = useAccount().address ?? null;
  const { offering } = useOfferingState({
    offeringAddress,
    buyer: wallet,
  });
  const pactToken =
    offering && offering.status === "loaded" ? offering.pactToken : null;
  const projectName =
    useQuery({
      queryKey: ["project-name", pactToken],
      enabled: !!pactToken,
      queryFn: () => getProjectName({ pactToken: pactToken! }).catch(() => ""),
    }).data ?? null;

  useEffect(() => {
    if (projectName) document.title = `${projectName} | PACT`;
  }, [projectName]);

  const filled =
    offering && offering.status === "loaded"
      ? deriveFilledTerms(offering, projectName || "")
      : null;

  const loading =
    !!offeringAddress && (!offering || offering.status === "loading");
  const loadError =
    offering && offering.status === "error" ? offering.error : null;

  return (
    <>
      <TermsHeading
        filled={filled}
        projectName={projectName}
        subtitle={
          !filled
            ? "Reference template — values are filled in for each offering."
            : undefined
        }
      />
      <TermsLoadNotice loading={loading} loadError={loadError} />
      <TermsBody filled={filled} />
    </>
  );
}
