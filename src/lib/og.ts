export const OG_SITE_ORIGIN = "https://pact.splits.org";

export function ogOriginForDeployment({
  vercelEnvironment,
  vercelUrl,
}: {
  vercelEnvironment?: string | undefined;
  vercelUrl?: string | undefined;
}): string {
  if (vercelEnvironment !== "preview" || !vercelUrl) return OG_SITE_ORIGIN;
  return `https://${vercelUrl.replace(/^https?:\/\//, "")}`;
}

export interface OgPage {
  path: string;
  label: string;
  title: string;
  description: string;
  image: string;
}

export const OG_PAGES: OgPage[] = [
  {
    path: "/",
    label: "Home",
    title: "PACT: Purchase Agreement for Community Tokens",
    description: "Raise a friends & family round without the paperwork.",
    image: "/og/pact.png",
  },
  {
    path: "/create",
    label: "Create",
    title: "PACT: New offering",
    description:
      "Deploy an offering: set the raise, the valuation band, and the public tranche, then sign once.",
    image: "/og/pact.png",
  },
  {
    path: "/status",
    label: "Offering status",
    title: "PACT: Offering status",
    description:
      "Issuer dashboard: allocations, raise progress, lifecycle actions, and the cap table.",
    image: "/og/pact.png",
  },
  {
    path: "/buy",
    label: "Buy",
    title: "PACT: Allocation details",
    description:
      "Buy units along the bonding curve in USDC on Base, or claim a private allocation link.",
    image: "/og/pact.png",
  },
  {
    path: "/terms",
    label: "Terms",
    title: "PACT: Terms",
    description:
      "The offering's terms and, per purchase, the executed receipt.",
    image: "/og/pact.png",
  },
];

export function ogPageForPath(pathname: string): OgPage | undefined {
  const withoutExtension = pathname.replace(/\.html$/, "") || "/";
  const cleanPath = withoutExtension === "/index" ? "/" : withoutExtension;
  return OG_PAGES.find((page) => page.path === cleanPath);
}
