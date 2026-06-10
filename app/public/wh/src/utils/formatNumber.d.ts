import { amount as sdkAmount } from '@wormhole-foundation/sdk';
/**
 * Format a numeric string with locale‑aware grouping, preserving any
 * fractional part (including a trailing dot).
 */
export declare const formatNumberIntl: (value: string) => string;
/**
 * Strip locale‑specific grouping separators and replace the decimal separator with "."
 * Important: This is required for Number() to parse correctly
 */
export declare const removeFormatting: (value: string) => string;
/**
 * Validate raw input as a non‑negative decimal
 * Allows:
 *  - the empty string
 *  - just the locale's decimal separator (for "0," or "0." beginnings)
 *  - any number of digits before/after a single separator
 * * Rejects:
 *  - multiple separators
 *  - non‑digit characters
 *  - leading/trailing non‑digit characters
 */
export declare const isValidFormattedNumber: (value: string) => boolean;
export declare const formatMinAmount: (minAmount: sdkAmount.Amount) => string;
/**
 * Format a number with smart precision based on total digits and max decimal digits.
 * If the integer part is less than totalDigits, show decimals up to maxDecimals
 * (limited by remaining space from totalDigits).
 *
 * @param value - The numeric value to format (string or number)
 * @param totalDigits - Maximum total significant digits to display
 * @param maxDecimals - Maximum number of decimal places to show
 * @returns Formatted number string (decimals truncated)
 *
 * @example
 * formatMaxDigits('123.456789', 6, 4)     // '123.456' (3 int + 3 dec = 6 total)
 * formatMaxDigits('123.456789', 8, 4)     // '123.4567' (3 int + 4 dec, limited by maxDecimals)
 * formatMaxDigits('123456.789', 6, 4)     // '123456' (6 int, no space for decimals)
 * formatMaxDigits('1234567.89', 6, 4)     // '1234567' (int exceeds totalDigits, show full int)
 */
export declare const formatMaxDigits: (value: string, totalDigits: number, maxDecimals: number) => string;
//# sourceMappingURL=formatNumber.d.ts.map