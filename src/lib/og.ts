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
    description: "Raise a friends & family round without the paperwork.",
    image: "/og/pact.png",
  },
  {
    path: "/status",
    label: "Offering status",
    title: "PACT: Offering status",
    description: "Raise a friends & family round without the paperwork.",
    image: "/og/pact.png",
  },
  {
    path: "/buy",
    label: "Buy",
    title: "PACT: Allocation details",
    description: "Raise a friends & family round without the paperwork.",
    image: "/og/pact.png",
  },
];

export function ogPageForPath(pathname: string): OgPage | undefined {
  const withoutExtension = pathname.replace(/\.html$/, "") || "/";
  const cleanPath = withoutExtension === "/index" ? "/" : withoutExtension;
  return OG_PAGES.find((page) => page.path === cleanPath);
}
