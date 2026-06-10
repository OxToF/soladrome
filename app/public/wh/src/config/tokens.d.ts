import { Chain, TokenId, TokenAddress } from '@wormhole-foundation/sdk';
import { TokenIcon, TokenConfig, WrappedTokenAddresses } from './types';
declare class TokenIdLazy<C extends Chain = Chain> implements TokenId<C> {
    chain: C;
    addressString: string;
    _address?: TokenAddress<Chain>;
    constructor(chain: C, addr: string);
    get address(): TokenAddress<C>;
    static fromTokenTuple(tuple: TokenTuple): TokenIdLazy;
}
type TokenConstructorProps = {
    chain: Chain;
    address: string;
    decimals: number;
    symbol: string;
    name?: string;
    icon?: TokenIcon | string;
    tokenBridgeOriginalTokenId?: TokenId;
    coingeckoId?: string;
    isUnattested?: boolean;
};
export declare class Token extends TokenIdLazy {
    decimals: number;
    symbol: string;
    name?: string;
    icon?: TokenIcon | string;
    tokenBridgeOriginalTokenId?: TokenId;
    coingeckoWebId?: string;
    isBuiltin?: boolean;
    isUnattested?: boolean;
    constructor({ chain, address, decimals, symbol, name, icon, tokenBridgeOriginalTokenId, coingeckoId, isUnattested, }: TokenConstructorProps);
    get display(): string;
    get shortAddress(): string;
    get tuple(): TokenTuple;
    get key(): string;
    get tokenId(): TokenId;
    get isNativeGasToken(): boolean;
    get isTokenBridgeWrappedToken(): boolean;
    get nativeChain(): "Solana" | "Ethereum" | "Bsc" | "Polygon" | "Avalanche" | "Algorand" | "Fantom" | "Klaytn" | "Celo" | "Near" | "Moonbeam" | "Injective" | "Osmosis" | "Sui" | "Aptos" | "Arbitrum" | "Optimism" | "Pythnet" | "Btc" | "Base" | "Sei" | "Scroll" | "Mantle" | "Xlayer" | "Linea" | "Berachain" | "Seievm" | "Unichain" | "Worldchain" | "Ink" | "HyperEVM" | "Monad" | "Mezo" | "Fogo" | "Sonic" | "Converge" | "Plume" | "XRPLEVM" | "Plasma" | "CreditCoin" | "Stacks" | "Moca" | "MegaETH" | "ZeroGravity" | "Wormchain" | "Cosmoshub" | "Evmos" | "Kujira" | "Neutron" | "Celestia" | "Stargaze" | "Seda" | "Dymension" | "Provenance" | "Noble" | "Sepolia" | "ArbitrumSepolia" | "BaseSepolia" | "OptimismSepolia" | "Holesky" | "PolygonSepolia" | "MonadTestnet" | "HyperCore";
    equals(other: Token): boolean;
    toJson(): TokenJson;
    static fromJson({ chain, address, decimals, symbol, name, icon, tokenBridgeOriginalTokenId, coingeckoWebId, }: TokenJson): Token;
}
interface TokenJson {
    chain: string;
    address: string;
    decimals: number;
    symbol: string;
    name: string;
    icon: string;
    tokenBridgeOriginalTokenId: TokenTuple | undefined;
    coingeckoWebId: string | undefined;
}
export declare class TokenMapping<T> {
    lastUpdate: Date;
    _localStorageKey?: string;
    _mapping: Map<Chain, Map<string, T>>;
    size: number;
    constructor();
    add(token: TokenId, value: T): void;
    get(key: string): T | undefined;
    get(tokenId: TokenId): T | undefined;
    get(tokenTuple: TokenTuple): T | undefined;
    get(chain: Chain, address: string): T | undefined;
    mustGet(key: string): T;
    mustGet(tokenId: TokenId): T;
    mustGet(tokenTuple: TokenTuple): T;
    mustGet(chain: Chain, address: string): T;
    getList(keys: string[]): Token[];
    getList(keys: TokenId[]): Token[];
    getList(keys: TokenTuple[]): Token[];
    getAllForChain(chain: Chain): T[];
    getAll(): T[];
    get chains(): Chain[];
    merge(other: TokenMapping<T>): void;
    clear(): void;
    forEach(callback: (tokenId: TokenId, val: T) => void): void;
    get empty(): boolean;
    clone(): TokenMapping<T>;
}
export declare class TokenCache extends TokenMapping<Token> {
    add(token: Token): void;
    getGasToken(chain: Chain): Token | undefined;
    findByAddressOrSymbol(chain: Chain, addressOrSymbol: string): Token | undefined;
    queryBySymbol(chain: Chain, query: string): Token[];
    findBySymbol(chain: Chain, symbol: string): Token | undefined;
    setLocalStorageKey(key: string): void;
    addFromTokenId(tokenId: TokenId): Promise<Token>;
    persist(): void;
    static load(localStorageKey: string): TokenCache;
}
export declare function buildTokenCache(tokens: TokenConfig[], wrappedTokens: WrappedTokenAddresses, cacheKey: string): TokenCache;
export type TokenTuple = [Chain, string];
export declare function isTokenTuple(thing: any): thing is TokenTuple;
export declare function tokenIdToTuple(tokenId: TokenId): TokenTuple;
export declare function tokenIdFromTuple(tokenTuple: TokenTuple): TokenId;
export declare function tokenKey(chain: Chain, address: string): string;
export declare function tokenKey(tokenId: TokenId): string;
export declare function parseTokenKey(key: string): TokenId;
export declare function addressString(tokenId: TokenId): string;
export declare function isSameToken(a: Token, b: Token): boolean;
export {};
//# sourceMappingURL=tokens.d.ts.map