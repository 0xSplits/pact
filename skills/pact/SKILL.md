---
name: pact
description: PACT onchain rounds on Base, driven with cast. Use when the user mentions PACT, a pact.splits.org link, an Offering or PactToken address, or wants to create, quote, buy into, withdraw from, fail, refund, or issue vouchers for a cap-table raise.
---

# PACT

PACT sells a slice of a project's cap table, a liquid-split ERC-1155 with
1000 units (1 unit = 0.1%), along a linear bonding curve, in USDC on Base
mainnet. There is no server and no API: the `Offering` contract is the
whole backend, and `cast` is the whole toolchain.

## Hard facts

```sh
export ETH_RPC_URL=https://mainnet.base.org        # chain id 8453
FACTORY=0x68DA9a884A6B5758a21490CeA5A1325C5f02eCdD # deployed at block 50274529
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913    # 6 decimals; every amount below is base units
OFF=<offering>
```

Every offering is a child of `FACTORY`; nothing else is a PACT offering.
https://pact.splits.org/.well-known/pact.json is the pin if these ever
look stale; https://pact.splits.org/llms.txt indexes the architecture,
contract specification, and integration guide (every signature and revert).

## Model

- **Offering** = escrow of the for-sale units + a price curve + a
  lifecycle. Created by the factory together with its **PactToken**.
- **Two tranches, one curve.** `publicUnits` are buyable by anyone
  (`buyPublic`); the rest only through owner-signed vouchers (`buyPrivate`,
  see `references/vouchers.md`). Both price off the same `unitsSold`.
- **Curve.** Unit `n` costs `priceStart + priceSlope * n`; a batch is the
  sum of consecutive unit prices. `quote(units)` returns the exact cost.
- **Minimum.** Once `raised >= raiseMin`, `minMet` latches forever: no
  refunds, withdrawals open, the round is successful.
- **Close date.** Buys stop after it only while the minimum is unmet.

## Lifecycle and what is callable

| Phase  | Condition                                               | Callable                                                                      |
| ------ | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| live   | `state == 0` and (`minMet` or now <= `closeDate`)       | `buyPublic`, `buyPrivate`, owner admin; `withdraw` once `minMet`              |
| limbo  | `state == 0`, `!minMet`, past `closeDate`               | `markFailed` (anyone)                                                         |
| closed | `state == 2` (owner `closeAndWithdraw`, needs `minMet`) | `withdraw` if anything is left                                                |
| failed | `state == 1`                                            | `refund` (buyer), `refundAll(address[])` (owner), `sweepFailedUnits` (anyone) |

## Before any write

1. **Factory child.** `OFF` appears as `offering` in an `OfferingCreated`
   log of `FACTORY` (recipe below). A contract that merely returns
   `factory()` proves nothing. Done when the log is in hand.
2. **Phase.** Read `state`, `minMet`, `closeDate`; the table above says
   whether the call can succeed.
3. **Quote.** `maxCost = quote(units)`; approve exactly that amount.
4. **Simulate.** `cast call --from $SENDER` with the exact `cast send`
   args; the decoded custom error names the missing precondition. Done
   when the simulation returns without reverting.
5. **Sign.** With a keystore, `cast send --account`. Without one, stop
   here and hand the user `to`, `data`, `value: 0`, chain 8453 (recipe
   below); the user signs.

`buyerName` and `projectName` are emitted onchain forever.

## Recipes

### Is this a PACT offering?

```sh
cast logs --from-block 50274529 --address $FACTORY \
  'OfferingCreated(address indexed issuer,address indexed treasury,address indexed offering,address pactToken,string projectName,uint256 raiseMin,uint64 closeDate,uint256 priceStart,uint256 priceSlope,uint256 publicUnits)' \
  '' '' $OFF
```

Empty output means it is not one. Drop the last three topic args to list
every offering (decode `pactToken`, `projectName`, curve params from the
data). A public RPC may refuse the whole range; add `--to-block` and chunk
by 10k blocks.

### Read status

```sh
for f in state minMet raised withdrawn raiseMin closeDate unitsSold remainingUnits \
         publicUnits publicUnitsSold priceStart priceSlope owner treasury pactToken; do
  printf '%-16s %s\n' $f "$(cast call $OFF "$f()")"
done
cast call $OFF 'quote(uint256)(uint256)' 10          # cost of the next 10 units
cast call $OFF 'deposits(address)(uint256)' $ME       # refundable deposit
cast call $OFF 'unitsBought(address)(uint256)' $ME
```

Raw words come back as hex; append the return type (`'state()(uint8)'`)
to decode, or pipe through `cast --to-dec`.

### Buy publicly

```sh
UNITS=10
MAX=$(cast call $OFF 'quote(uint256)(uint256)' $UNITS)
cast send --account $ACCT $USDC 'approve(address,uint256)' $OFF $MAX
cast call --from $ME $OFF 'buyPublic(uint256,uint256,string)' $UNITS $MAX ''   # simulate, after the approve lands
cast send --account $ACCT $OFF 'buyPublic(uint256,uint256,string)' $UNITS $MAX ''
```

`Slippage()` means the cost moved above `MAX`: re-quote, re-approve. `PublicAllocationExceeded()` means the
public tranche is exhausted. Units arrive in the buyer's wallet as
`PactToken` id 0 in the same transaction:
`cast call $(cast call $OFF 'pactToken()(address)') 'balanceOf(address,uint256)(uint256)' $ME 0`.

### Unsigned hand-off

```sh
cast calldata 'approve(address,uint256)' $OFF $MAX
cast calldata 'buyPublic(uint256,uint256,string)' $UNITS $MAX ''
```

Two transactions, in that order; the approve must land first.

### Create an offering

```sh
cast send --account $ACCT $FACTORY \
  'createOffering(string,uint256,uint64,uint256,uint256,uint256,address,address,address[],uint32[],uint32)' \
  "$NAME" $RAISE_MIN $CLOSE_DATE $PRICE_START $PRICE_SLOPE $PUBLIC_UNITS \
  $TREASURY $OWNER "[$FOUNDER]" "[900]" 100
```

Factory rules: founder allocations + `offeringUnits` = 1000, every
allocation nonzero, `publicUnits <= offeringUnits`, `raiseMin` reachable by
selling every offered unit, `closeDate` in the future, `priceStart > 0`.
Valuation band → curve: `priceStart = floor / 1000`,
`priceSlope = (ceiling - floor) / 1000 / offeringUnits`. The new
`offering` address is topic 3 of `OfferingCreated` in the receipt
(`cast receipt <tx> --json | jq`).

### Withdraw, close, fail, refund

```sh
cast send --account $ACCT $OFF 'withdraw()'          # anyone, once minMet; pays treasury
cast send --account $ACCT $OFF 'closeAndWithdraw()'  # owner, needs minMet
cast send --account $ACCT $OFF 'markFailed()'        # anyone, past closeDate with minimum unmet
cast send --account $ACCT $OFF 'refund()'            # buyer, in failed; full unit balance must be in the wallet
cast send --account $ACCT $OFF 'refundAll(address[])' "[$A,$B]"   # owner
cast send --account $ACCT $OFF 'sweepFailedUnits()'  # anyone, after refunds
cast send --account $ACCT $OFF 'setPublicUnits(uint256)' 400      # owner
```

Simulate each with `cast call --from` first; the decoded custom error
(`MinimumNotMet()`, `CloseDateNotPassed()`, `NotFailed()`,
`UnitsNotReturned()`, ...) says which precondition is missing.

### Purchases and cap table

```sh
cast logs --address $OFF 'Bought(address indexed buyer,bytes32 indexed allocationId,uint256 units,uint256 cost,string buyerName)'
TOKEN=$(cast call $OFF 'pactToken()(address)')
cast logs --address $TOKEN 'TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)'
cast call $TOKEN 'balanceOf(address,uint256)(uint256)' $HOLDER 0
```

`allocationId` of `0x00…00` on `Bought` is a public buy; anything else was a
voucher claim.
