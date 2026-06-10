import { amount as sdkAmount } from '@wormhole-foundation/sdk';
import { Token } from '../config/tokens';
import { default as SDKv2Route } from '../routes/sdkv2/route';
/**
 * Round down a value to a specific number of decimal places
 * @param value - The value to round down (in base units)
 * @param decimals - The number of decimal places for the token
 * @param maxDecimals - Maximum decimal places to keep (default 6)
 */
export declare function roundDownToDecimals(value: bigint, decimals: number, maxDecimals?: number): bigint;
/**
 * Apply the offset formula to calculate how much extra to send so the user receives the desired amount after fee deduction.
 *
 * Mathematical derivation:
 * - Goal: sent - (sent × feeRate) = desired
 * - Factor out sent: sent × (1 - feeRate) = desired
 * - Solve for sent: sent = desired / (1 - feeRate)
 * - Offset = sent - desired = desired × feeRate / (1 - feeRate)
 *
 * For basis points (bps): feeRate = bps / 10000, so offset = amount × bps / (10000 - bps)
 * For deci-basis points (dbps): feeRate = dbps / 100000, so offset = amount × dbps / (100000 - dbps)
 *
 * @param amount - The desired output amount (what user wants to receive)
 * @param feeRate - The fee rate as a fraction (e.g., 0.001 for 0.1%)
 * @param feeDenominator - The denominator for the fee calculation (10000 for bps, 100000 for dbps)
 * @returns The offset amount to add to ensure user receives the desired amount
 */
export declare function applyOffsetFormula(amount: sdkAmount.Amount, feeRate: bigint, feeDenominator: bigint): sdkAmount.Amount;
/**
 * Calculate the fee offset amount needed to achieve the desired output after fee deduction
 * @param amount - The desired output amount (what user wants to receive)
 * @param routeName - The name of the route
 * @param sourceToken - The source token (required for token-specific fees)
 * @param destToken - Optional destination token (for Mayan routes)
 * @returns The additional amount to add so that after fee deduction, user receives the desired amount
 */
export declare function calculateFeeOffset(route: SDKv2Route | string | undefined, amount: sdkAmount.Amount | undefined, sourceToken: Token | undefined, destToken?: Token): sdkAmount.Amount | undefined;
//# sourceMappingURL=fees.d.ts.map