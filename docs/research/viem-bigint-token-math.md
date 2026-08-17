# viem `parseUnits`/`formatUnits` and bigint-safe USDC math

> Research note (2026-08-17) for replacing float `Number` math with `bigint` throughout the frontend.
> First doc in `docs/research/` — the subfolder was created for this note.
> Verified against the **installed** viem 2.55.15 / wagmi 3.7.6 (`node_modules`) and the viem source on GitHub; the installed `src/utils/unit/Value.ts` is byte-identical to `main`. Version-pinned permalinks below use the `viem@2.55.15` tag.

## Summary

- `parseUnits(value: string, decimals: number): bigint` and `formatUnits(value: bigint, decimals: number): string` do pure decimal-string manipulation — no float ever touches the value.
- `parseUnits` **rounds half-away-from-zero** at the `decimals` boundary (it does not truncate, does not throw on excess fractional digits). It **throws** `Value.InvalidDecimalNumberError` on anything outside `/^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/` — empty string, `.`, commas, spaces, `$`, scientific notation (`1e6`).
- `formatUnits` returns minimal precision (trailing zeros stripped, `1000000n → "1"`); fixed-2-decimal display is done by splitting the string on `.` and padding — never via `Number.toFixed`.
- wagmi v3 re-exports **neither** function nor `erc20Abi`; import all three from `viem`.
- uint256 reads come back as `bigint`; `JSON.stringify` on bigint throws `TypeError`, so localStorage caching stores `.toString()` and revives with `BigInt()`.
- Money arithmetic stays in bigint: `/` floors, ceil-div is `(a + b - 1n) / b`, +1% is `x * 101n / 100n`, min/max via a ternary (Math.min throws on bigint). tsc allows `<`/`>` across bigint/number but rejects `+` and flags `===`.

## 1. Signatures and semantics

Documented signatures ([viem.sh/docs/utilities/parseUnits](https://viem.sh/docs/utilities/parseUnits), [viem.sh/docs/utilities/formatUnits](https://viem.sh/docs/utilities/formatUnits)):

```ts
parseUnits(value: string, exponent: number): bigint   // "multiplies a string repr by 10^exponent"
formatUnits(value: bigint, exponent: number): string  // "divides by 10^exponent, formats to string"
```

Both are thin wrappers over `Value.from` / `Value.format` ([src/utils/unit/parseUnits.ts](https://github.com/wevm/viem/blob/viem%402.55.15/src/utils/unit/parseUnits.ts), [src/utils/unit/formatUnits.ts](https://github.com/wevm/viem/blob/viem%402.55.15/src/utils/unit/formatUnits.ts)). All behavior below is from [src/utils/unit/Value.ts](https://github.com/wevm/viem/blob/viem%402.55.15/src/utils/unit/Value.ts) and was re-verified by executing the installed package (`node_modules/viem/utils/unit/Value.ts`).

`parseUnits` semantics:

- **Excess fractional digits: rounds half-away-from-zero, never throws, never truncates.** The digit at position `decimals` decides: `>= 5` rounds the kept fraction up (string carry, overflow propagates into the integer part), `< 5` drops the tail. Source: the `roundDigit >= 5` branch and `carry()` in `Value.from`. Verified: `parseUnits('1.2345678', 6) === 1234568n`, `parseUnits('0.9999999', 6) === 1000000n`, `parseUnits('69.23221', 2) === 6923n` (round down). Pinned by [parseUnits.test.ts](https://github.com/wevm/viem/blob/viem%402.55.15/src/utils/unit/parseUnits.test.ts) (incl. the exact-decimal-rounding cases from [wevm/viem#4855](https://github.com/wevm/viem/issues/4855)).
- **Negative values: supported**, sign handled separately, rounding is away from zero: `parseUnits('-0.0000005', 6) === -1n`.
- **Input validation: throws `Value.InvalidDecimalNumberError`** for any string not matching `/^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/` (`Value.from`, and the error class at the bottom of `Value.ts`). Verified throws: `''`, `'.'`, `'1e6'` (scientific notation is NOT accepted), `'1,000'`, `' 1 '`, `'$1'`. Accepted: `'.5'` (→ `500000n`), `'1.'`.
- **`decimals` must be a non-negative integer** or `Value.InvalidDecimalsError` is thrown (both `from` and `format`).

`formatUnits` semantics (`Value.format`): full precision, trailing fractional zeros stripped, no fixed-width padding. Verified: `formatUnits(1500000n, 6) === '1.5'`, `formatUnits(1000000n, 6) === '1'`, `formatUnits(1n, 6) === '0.000001'`, `formatUnits(-1500000n, 6) === '-1.5'`.

## 2. Why the implementation is precision-safe

`Value.from` never converts the value to a JS `Number`. It splits the string on `.`, pads/slices the fraction to `decimals` digits, performs rounding with a digit-by-digit string `carry()` (its comment: "without converting to a JS Number (avoids float precision loss)"), and finally does one `BigInt(integerString + fractionString)`. `Value.format` is the inverse: `value.toString()`, `padStart`, slice into integer/fraction. Source: [Value.ts](https://github.com/wevm/viem/blob/viem%402.55.15/src/utils/unit/Value.ts).

`Math.floor(n * 10 ** 6)` is not safe for the same job, for two independent reasons (both verified by execution):

1. **IEEE-754 products land below the true value**: `2.01 * 1e6 === 2009999.9999999998`, so `Math.floor(2.01 * 1e6) === 2009999` — a real dollar amount (`$2.01`) loses a micro-USDC. Same for 2.03, 2.05, 2.07, 2.09, …
2. **`Number` silently caps at 2^53**: `Number.MAX_SAFE_INTEGER === 9007199254740991` (~9 billion USDC in 6-decimal units); `9007199254740992 + 1 === 9007199254740992`, while `9007199254740992n + 1n` is exact. uint256 does not fit in a double.

## 3. Input pattern: dollar text → bigint base units

```ts
const USDC_DECIMALS = 6;
function parseUsdcInput(raw: string): bigint | null {
  try {
    return parseUnits(raw.trim(), USDC_DECIMALS);
  } catch {
    return null; // Value.InvalidDecimalNumberError → treat as invalid form input
  }
}
```

- Keep the user's text as the source of truth and pass the **string** straight to `parseUnits` — never round-trip through `Number`.
- Pitfall — `String(number)` float noise: `String(0.1 + 0.2) === '0.30000000000000004'`. `parseUnits` will happily parse that string; the half-away-from-zero rounding at 6 decimals usually absorbs ~1e-16 noise, but any code path that did real float arithmetic first (sums, percentages) can drift by whole base units (see §2). If a value only exists as a `number`, convert via a decimal-exact string (`n.toFixed(6)`), not `String(n)`.
- Pitfalls that **throw** (verified): empty string `''`, lone `'.'`, comma separators `'1,000'`, leading/trailing whitespace `' 1 '`, currency symbols `'$1'`, scientific notation `'1e6'`. Strip commas/whitespace yourself before calling; treat the throw as form-validation failure, not a crash path.

## 4. Display pattern: bigint → fixed 2 decimals

`formatUnits` gives minimal precision (`'1'`, `'1.5'`, `'0.000001'`), so fixed-cent display pads the **string** — still no floats:

```ts
function formatUsdc(units: bigint, places = 2): string {
  const s = formatUnits(units, 6); // full precision, exact
  const [int, frac = ""] = s.split(".");
  return `${int}.${frac.padEnd(places, "0").slice(0, places)}`;
}
// formatUsdc(1500000n) === '1.50'; formatUsdc(1000000n) === '1.00'
```

Note `.slice(0, places)` **truncates** sub-cent dust; if rounded cents are wanted, round in bigint first (`(units + 5000n) / 10000n` cents, half-up) and format that. For locale grouping, `Number` the integer part only, or use `Intl.NumberFormat` — which accepts `bigint` directly for whole numbers ([TC39 / MDN: `Intl.NumberFormat.prototype.format` accepts BigInt](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat/format)).

`Number(formatUnits(x, 6))` is acceptable **only for display-side math where sub-cent exactness is irrelevant**: chart scales, progress-bar percentages, sorting for display. A double has 53 bits ≈ 15–16 significant decimal digits, so USDC amounts up to ~$9 billion survive to the cent, but the result must never flow back into an amount that gets parsed, compared against a contract value, or signed.

## 5. Bigint money arithmetic idioms

All verified by execution; language semantics per ECMA-262 (see [MDN: BigInt](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/BigInt), which mirrors the spec).

- **Division floors** (truncates toward zero): `7n / 2n === 3n`. Ceil-division for positive operands: `(a + b - 1n) / b` — verified `(7n + 3n - 1n) / 3n === 3n`.
- **Percentage markup** stays integer: `+1%` is `x * 101n / 100n` (floors the sub-unit remainder; use `(x * 101n + 99n) / 100n` to ceil). `Math.ceil(x * 1.01)` differs in two ways: it ceils where bigint floors (`Math.ceil(1000001 * 1.01) === 1010002` vs `1000001n * 101n / 100n === 1010001n`), and it breaks entirely above 2^53. Pick the rounding direction deliberately in bigint; never via a float literal like `1.01`, which is not exactly representable.
- **min/max**: `Math.min`/`Math.max` **throw** `TypeError: Cannot convert a BigInt value to a number` (verified). Idiom: `a < b ? a : b` / `a > b ? a : b`, or `[...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0]` for lists.
- **Mixed bigint/number rules** (verified against the repo's tsc, strict mode, and Node 22 runtime):
  - Relational `<` `>` `<=` `>=`: allowed by tsc, correct at runtime (`1n < 2 === true`) — comparison is mathematical, no precision loss.
  - Arithmetic `+ - * /` mixing: **tsc error TS2365**; at runtime `TypeError: Cannot mix BigInt and other types`.
  - `===` across types: always `false` at runtime; tsc flags it (TS2367 "no overlap"). Loose `==` compares numerically (`1n == 1`) but don't rely on it.
  - Convert explicitly at boundaries: `BigInt(someInt)` (throws on non-integers) or `Number(someBigint)` (silently loses precision past 2^53 — display-only).

## 6. Import source: viem, not wagmi

wagmi 3.7.6 (installed) re-exports **none of** `parseUnits`, `formatUnits`, `erc20Abi` — verified by `import('wagmi')` (all three absent) and by grepping `node_modules/wagmi/dist/esm/exports/index.js`. wagmi's `package.json` `exports` map has no utils subpath (only `.`, `./actions`, `./chains`, `./codegen`, `./connectors/*`, `./query`, `./tempo`). Import from `viem` directly:

```ts
import { erc20Abi, formatUnits, parseUnits } from "viem";
```

(viem is already a direct dependency in `package.json`, so no phantom-dependency concern.)

## 7. uint256 → bigint, and localStorage

- viem returns `bigint` for every `uint256` output: the ABI→TS mapping comes from abitype, whose default register sets `BigIntType: bigint` for large int/uint types (`node_modules/abitype/dist/types/register.d.ts`, `bigIntType: bigint`; docs: [abitype.dev/config](https://abitype.dev/config)). E.g. `erc20Abi`'s `balanceOf` output is `uint256` ([src/constants/abis.ts](https://github.com/wevm/viem/blob/viem%402.55.15/src/constants/abis.ts)) and `readContract` infers `bigint`.
- `JSON.stringify` on any bigint — bare or nested — throws `TypeError: Do not know how to serialize a BigInt` (verified on Node 22; per ECMA-262 `JSON.stringify`, [MDN: BigInt "Use within JSON"](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/BigInt#use_within_json)). This bites any localStorage cache (the listings delta cache) the moment a cached shape gains a bigint field.
- Standard workaround: serialize as decimal string, revive with `BigInt()`:

```ts
JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
// revive known fields explicitly: BigInt(parsed.raised) — verified BigInt('1000000') === 1000000n
```

Revive per-field (the cache knows its own schema) rather than guessing "numeric string means bigint" globally.
