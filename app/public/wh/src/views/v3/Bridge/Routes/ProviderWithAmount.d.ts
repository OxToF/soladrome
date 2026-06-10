interface ProviderWithAmountProps {
    destChain?: string;
    provider?: string;
    route?: string;
    sourceChain?: string;
    sourceTokenSymbol?: string;
    usdValue: string;
}
declare function ProviderWithAmount({ destChain, provider, route, sourceChain, sourceTokenSymbol, usdValue, }: ProviderWithAmountProps): string;
declare const _default: import('react').MemoExoticComponent<typeof ProviderWithAmount>;
export default _default;
//# sourceMappingURL=ProviderWithAmount.d.ts.map