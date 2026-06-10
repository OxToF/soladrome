import { amount as sdkAmount, Chain } from '@wormhole-foundation/sdk';
import { QuoteResult } from '../routes/operator';
import { Token } from '../config/tokens';
type Params = {
    sourceChain?: Chain;
    sourceToken: Token | undefined;
    destChain?: Chain;
    destToken: Token | undefined;
    amount?: sdkAmount.Amount;
    nativeGas: number;
    sender?: string;
    recipient?: string;
};
type HookReturn = {
    quotes: Record<string, QuoteResult | undefined>;
    failedQuotes: Record<string, QuoteResult | undefined>;
    isFetchingQuotes: boolean;
};
declare const _default: (routes: string[], params: Params) => HookReturn;
export default _default;
//# sourceMappingURL=useFetchQuotes.d.ts.map