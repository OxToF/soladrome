import { Chain } from '@wormhole-foundation/sdk';
import { Balances } from '../utils/wallet/types';
export interface UseAutoEnableGasDropOffParams {
    route: string | undefined;
    destChain: Chain | undefined;
    receivingWalletAddress: string | undefined;
    destinationBalances: Balances;
    hasUserManuallyChangedGas: boolean;
    currentToNativeToken: number;
    isFetchingBalances: boolean;
    allowedChains?: Chain[];
}
/**
 * Automatically enables gas drop-off when the destination
 * wallet has zero native token balance for executor routes,
 * unless the user has manually changed the gas setting.
 * Only applies to chains specified in allowedChains if provided.
 */
export declare function useAutoEnableGasDropOff({ route, destChain, receivingWalletAddress, destinationBalances, hasUserManuallyChangedGas, currentToNativeToken, isFetchingBalances, allowedChains, }: UseAutoEnableGasDropOffParams): void;
//# sourceMappingURL=useAutoEnableGasDropoff.d.ts.map