import { Balances } from '../utils/wallet/types';
import { Token } from '../config/tokens';
import { Chain } from '@wormhole-foundation/sdk';
import { WalletData } from '../store/wallet';
export interface ChainBalanceRequest {
    chain: Chain;
    wallet: WalletData;
    tokens: Token[];
}
interface UseGetTokenBalancesParams {
    source?: ChainBalanceRequest;
    destination?: ChainBalanceRequest;
}
interface ChainBalanceResult {
    balances: Balances;
}
interface UseGetTokenBalancesResult {
    isFetching: boolean;
    source: ChainBalanceResult;
    destination: ChainBalanceResult;
}
declare const useGetTokenBalances: ({ source, destination, }: UseGetTokenBalancesParams) => UseGetTokenBalancesResult;
export default useGetTokenBalances;
//# sourceMappingURL=useGetTokenBalances.d.ts.map