import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OG_PAGES, OG_SITE_ORIGIN } from "../lib/og.ts";
import "./og-preview.css";

function OgImage() {
  return (
    <div className="og-frame">
      <div className="og-paper">
        <h2>Purchase Agreement for Community Tokens</h2>
        <p className="og-disclaimer">
          THE TOKENS ISSUED PURSUANT TO THIS INSTRUMENT CARRY NO INHERENT VALUE
          AND ENTITLE THEIR HOLDERS TO NOTHING EXCEPT AS THE PROJECT&rsquo;S
          CREATOR MAY EXPRESSLY PROVIDE. THEY EXIST SOLELY TO ALIGN THEIR
          HOLDERS WITH THE PROJECT.
        </p>
        <div className="og-document-copy">
          <p>
            This Purchase Agreement for Community Tokens (this
            &ldquo;PACT&rdquo;) certifies that{" "}
            <span className="og-document-input og-document-input-project">
              Stepentine Studios
            </span>{" "}
            (the &ldquo;Project&rdquo;) shall issue community tokens to those
            who buy into the Offering described below, upon and subject to the
            terms set forth herein.
          </p>
          <p>
            <strong>&sect;1. The Offering.</strong> The Project intends to raise
            no less than ${" "}
            <span className="og-document-input og-document-input-amount">
              10,000
            </span>{" "}
            (the &ldquo;Minimum&rdquo;) and no more than ${" "}
            <span className="og-document-input og-document-input-amount">
              15,000
            </span>{" "}
            (the &ldquo;Maximum&rdquo;) of new capital and, in consideration
            thereof, shall make available for purchase no more than{" "}
            <span className="og-document-input og-document-input-percent">
              20
            </span>
            % of the Units (the &ldquo;Offering&rdquo;). Should the Maximum not
            be met, any unsold Units may be reclaimed solely by the Treasury.
          </p>
        </div>
      </div>
    </div>
  );
}

function OgPreview() {
  return (
    <main className="og-gallery">
      <header className="og-gallery-header">
        <p>PACT · Local design review</p>
        <h1>Open Graph concepts</h1>
        <span>
          These cards display the actual 1200×630 PNG and the metadata attached
          to each page.
        </span>
      </header>

      <div className="og-grid">
        {OG_PAGES.map((page) => (
          <figure className="og-concept" key={page.path}>
            <img
              className="og-image-preview"
              src={page.image}
              width="1200"
              height="630"
              alt="Purchase Agreement for Community Tokens Open Graph image"
            />
            <figcaption>
              <div className="og-concept-heading">
                <strong>{page.label}</strong>
                <code>{page.path}</code>
              </div>
              <dl className="og-metadata">
                <div>
                  <dt>Title</dt>
                  <dd>{page.title}</dd>
                </div>
                <div>
                  <dt>Description</dt>
                  <dd>{page.description}</dd>
                </div>
                <div>
                  <dt>Canonical URL</dt>
                  <dd>
                    <code>{new URL(page.path, OG_SITE_ORIGIN).href}</code>
                  </dd>
                </div>
                <div>
                  <dt>Image</dt>
                  <dd>
                    <code>{new URL(page.image, OG_SITE_ORIGIN).href}</code>
                  </dd>
                </div>
                <div>
                  <dt>Type</dt>
                  <dd>website</dd>
                </div>
                <div>
                  <dt>Twitter card</dt>
                  <dd>summary_large_image</dd>
                </div>
              </dl>
            </figcaption>
          </figure>
        ))}
      </div>
    </main>
  );
}

const renderImage = new URLSearchParams(window.location.search).has("render");

createRoot(document.getElementById("app")!).render(
  <StrictMode>{renderImage ? <OgImage /> : <OgPreview />}</StrictMode>,
);
