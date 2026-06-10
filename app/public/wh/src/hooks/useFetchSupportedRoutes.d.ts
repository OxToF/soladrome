import { Chain } from '@wormhole-foundation/sdk';
import { Token } from '../config/tokens';
import { WalletData } from '../store/wallet';
type HookReturn = {
    supportedRoutes: string[];
    isFetching: boolean;
};
interface UseFetchSupportedRoutesArgs {
    fromChain: Chain | undefined;
    toChain: Chain | undefined;
    sourceToken: Token | undefined;
    destToken: Token | undefined;
    toNativeToken: number;
    receivingWallet: WalletData | undefined;
}
declare const useFetchSupportedRoutes: ({ fromChain, toChain, sourceToken, destToken, toNativeToken, receivingWallet, }: UseFetchSupportedRoutesArgs) => HookReturn;
export default useFetchSupportedRoutes;
//# sourceMappingURL=useFetchSupportedRoutes.d.ts.map