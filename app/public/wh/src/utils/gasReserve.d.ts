import { Chain, amount as sdkAmount } from '@wormhole-foundation/sdk';
/**
 * Get the gas reserve amount for a given chain.
 * Returns undefined if no reserve is configured for the chain.
 *
 * @param chain - The source chain
 * @returns The amount to reserve, or undefined if no reserve configured
 */
export declare function getGasReserve(chain: Chain): sdkAmount.Amount | undefined;
//# sourceMappingURL=gasReserve.d.ts.map