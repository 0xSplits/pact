// Canonical PACT document language. Consumed by terms-body (the reference and
// executed document), create-app (the drafting preview), and buy-app (the
// buyer's "I understand" checkbox) so all three stay in lockstep.

// The standing disclaimer above the recital. Rendered as inline text so the
// caller controls the wrapping element and its styling (e.g. uppercase on the
// terms/create views; plain case inside the buy-page checkbox).
export const UNITS_DISCLAIMER = (
  <>
    The Units are issued to align their holders with the Project. They confer no
    equity, voting, dividend, or other legal right in the Project itself. Any
    benefits or privileges extended to holders are granted at the sole
    discretion of the Issuer, and may be modified or withheld at any time.
  </>
);
