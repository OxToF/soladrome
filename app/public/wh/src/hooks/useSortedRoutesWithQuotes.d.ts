import { amount, Chain, routes } from '@wormhole-foundation/sdk';
import { default as useFetchQuotes } from './useFetchQuotes';
import { Token } from '../config/tokens';
import { WalletData } from '../store/wallet';
type Quote = routes.Quote<routes.Options, routes.ValidatedTransferParams<routes.Options>>;
export type RouteWithQuote = {
    route: string;
    quote: Quote;
};
type HookReturn = {
    allSupportedRoutes: string[];
    sortedRoutes: string[];
    sortedRoutesWithQuotes: RouteWithQuote[];
    quotes: ReturnType<typeof useFetchQuotes>['quotes'];
    failedQuotes: ReturnType<typeof useFetchQuotes>['failedQuotes'];
    isFetching: boolean;
};
interface UseSortedRoutesWithQuotesArgs {
    amount?: amount.Amount;
    fromChain?: Chain;
    toChain?: Chain;
    preferredRouteName?: string;
    toNativeToken: number;
    sourceToken?: Token;
    destToken?: Token;
    sendingWallet: WalletData;
    receivingWallet: WalletData;
}
export declare const useSortedRoutesWithQuotes: ({ amount, fromChain, toChain, preferredRouteName, toNativeToken, sourceToken, destToken, sendingWallet, receivingWallet, }: UseSortedRoutesWithQuotesArgs) => HookReturn;
export {};
//# sourceMappingURL=useSortedRoutesWithQuotes.d.ts.map