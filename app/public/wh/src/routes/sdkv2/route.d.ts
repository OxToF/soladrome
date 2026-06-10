import { Chain, ChainContext, Network, TokenId as TokenId, TransactionId, Signer, routes, amount as sdkAmount } from '@wormhole-foundation/sdk';
import { Token } from '../../config/tokens';
import { QuoteMetadata } from '../types';
type Amount = sdkAmount.Amount;
export default class SDKv2Route {
    readonly rc: routes.RouteConstructor;
    IS_TOKEN_BRIDGE_ROUTE: boolean;
    IS_MONAD_BRIDGE_ROUTE: boolean;
    constructor(rc: routes.RouteConstructor);
    private tokenCache;
    get AUTOMATIC_DEPOSIT(): boolean;
    get NATIVE_GAS_DROPOFF_SUPPORTED(): boolean;
    getV2ChainContext<C extends Chain>(chain: C): Promise<{
        chain: C;
        context: ChainContext<Network, C>;
    }>;
    isRouteSupported(sourceToken: Token, destToken: Token, fromChain: Chain, toChain: Chain): Promise<boolean>;
    isSupportedChain(chain: Chain): boolean;
    supportedDestTokens(sourceToken: Token | undefined, fromChain?: Chain | undefined, toChain?: Chain | undefined): Promise<TokenId[]>;
    getQuote(amount: Amount, sourceToken: Token, destToken: Token, sourceChain: Chain, destChain: Chain, options?: routes.AutomaticTokenBridgeRoute.Options, sender?: string, recipient?: string): Promise<QuoteMetadata>;
    createRouteInstance(): Promise<routes.Route<"Mainnet" | "Testnet" | "Devnet", routes.Options, routes.ValidatedTransferParams<routes.Options>, routes.Receipt>>;
    createRequest(sourceToken: Token, destToken: Token, sourceChain: Chain, destChain: Chain, sender?: string, recipient?: string): Promise<routes.RouteTransferRequest<Network>>;
    send(quoteMetadata: QuoteMetadata, signer: Signer, toChain: Chain, recipientAddress: string): Promise<[routes.Route<Network>, routes.Receipt]>;
    resumeIfManual(tx: TransactionId): Promise<routes.Receipt | null>;
    isIlliquidDestToken(sourceToken: Token, toChain: Chain): Promise<boolean>;
}
export {};
//# sourceMappingURL=route.d.ts.map