# Vouchers with cast

A private allocation is two EIP-712 signatures under the offering's domain
(`name "PACT"`, `version "1"`, `chainId 8453`, `verifyingContract = offering`):

1. `Voucher(bytes32 allocationId, string buyerName, uint256 amountCapUsdc, address linkKey)`,
   signed by the offering owner. `linkKey` is a throwaway key generated per
   allocation; `allocationId = keccak256(linkKey)` (over the 20 address bytes).
2. `Claim(bytes32 allocationId, address buyer)`, signed by the link key at
   claim time, binding the claim to the caller.

One-shot, capped in USDC, no expiry. `cancelAllocation(id)` (owner) and
ownership transfer revoke; `allocationConsumed(id)` reads the onchain flag.

## Issue (owner side)

```sh
read -r LINK_KEY LINK_PK < <(cast wallet new --json | jq -r '.[0] | "\(.address) \(.private_key)"')
ID=$(cast keccak $LINK_KEY)
cat > voucher.json <<JSON
{
  "types": {
    "EIP712Domain": [{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],
    "Voucher": [{"name":"allocationId","type":"bytes32"},{"name":"buyerName","type":"string"},{"name":"amountCapUsdc","type":"uint256"},{"name":"linkKey","type":"address"}]
  },
  "primaryType": "Voucher",
  "domain": {"name":"PACT","version":"1","chainId":8453,"verifyingContract":"$OFF"},
  "message": {"allocationId":"$ID","buyerName":"$NAME","amountCapUsdc":"$CAP","linkKey":"$LINK_KEY"}
}
JSON
OWNER_SIG=$(cast wallet sign --account $OWNER_ACCT --data --from-file voucher.json)
```

If the owner is a smart wallet, hand it the typed data (`eth_signTypedData_v4`)
and take the returned ERC-1271 blob as `OWNER_SIG` instead.

The share link the web app understands:

```sh
FRAG=$(printf '{"v":1,"a":"%s","n":"%s","c":"%s","s":"%s","k":"%s"}' "$ID" "$NAME" "$CAP" "$OWNER_SIG" "$LINK_PK" \
  | base64 | tr -d '\n=' | tr -- '+/' '-_')
echo "https://pact.splits.org/buy?offering=$OFF#$FRAG"
```

The link is the sole capability and exists nowhere onchain until claimed:
store it (id, name, cap, link, createdAt) somewhere the issuer controls and
share it privately.

## Claim (buyer side)

Decode a link (`base64 -d` silently drops the tail without padding):

```sh
printf '%s' "$FRAG" | tr -- '-_' '+/' \
  | awk '{p=(4-length%4)%4; printf "%s%s",$0,substr("===",1,p)}' | base64 -d
```

Then, with `ID`, `NAME`, `CAP`, `OWNER_SIG`, `LINK_PK` from the payload and
`LINK_KEY=$(cast wallet address $LINK_PK)`:

```sh
cat > claim.json <<JSON
{
  "types": {
    "EIP712Domain": [{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],
    "Claim": [{"name":"allocationId","type":"bytes32"},{"name":"buyer","type":"address"}]
  },
  "primaryType": "Claim",
  "domain": {"name":"PACT","version":"1","chainId":8453,"verifyingContract":"$OFF"},
  "message": {"allocationId":"$ID","buyer":"$ME"}
}
JSON
CLAIM_SIG=$(cast wallet sign --private-key $LINK_PK --data --from-file claim.json)
MAX=$(cast --to-dec $(cast call $OFF 'quote(uint256)' $UNITS))   # must be <= CAP
SIG='buyPrivate((bytes32,string,uint256,address),bytes,bytes,uint256,uint256)'
cast call --from $ME $OFF "$SIG" "($ID,\"$NAME\",$CAP,$LINK_KEY)" $OWNER_SIG $CLAIM_SIG $UNITS $MAX
cast send --account $ACCT $USDC 'approve(address,uint256)' $OFF $MAX
cast send --account $ACCT $OFF "$SIG" "($ID,\"$NAME\",$CAP,$LINK_KEY)" $OWNER_SIG $CLAIM_SIG $UNITS $MAX
```

Units must fit the private tranche: `remainingUnits() - (publicUnits() - publicUnitsSold())`.
Reverts: `AllocationAlreadyConsumed()`, `AllocationCapExceeded()`,
`InvalidVoucherSignature()` (owner changed or bad domain),
`InvalidClaimSignature()` (claim signed for a different buyer).
