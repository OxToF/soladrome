import { Chain } from '@wormhole-foundation/sdk';
import { Alignment } from '../components/Header';
export type UiConfig = {
    title?: string;
    cta?: {
        text: string;
        link: string;
    };
    explorer?: ExplorerConfig;
    defaultInputs?: DefaultInputs;
    pageHeader?: string | PageHeader;
    menu?: MenuEntry[];
    searchTx?: SearchTxConfig;
    partnerLogo?: string;
    walletConnectProjectId?: string;
    previewMode?: boolean;
    getHelpUrl?: string;
    showInProgressWidget?: boolean;
    showFooter?: boolean;
    disableUserInputtedTokens?: boolean;
    onlyOfferManualRoutesAsFallback?: boolean;
    testOptions?: TestOptions;
    experimental?: Experimental;
    tokenNameOverrides?: {
        [chain in Chain]?: {
            [address: string]: string;
        };
    };
    termsOfServiceUrl?: string;
    hideSwapInputs?: boolean;
    hideHistory?: boolean;
    hideSourceChangeWallet?: boolean;
    hideSourceDisconnectWallet?: boolean;
    hideDestinationChangeWallet?: boolean;
    hideDestinationDisconnectWallet?: boolean;
    transactionHistoryChains?: Chain[];
    disableSourceTokenPicker?: boolean;
    disableDestinationTokenPicker?: boolean;
    autoEnableGasDropOffChains?: Chain[];
    routeSortPriority?: 'fastest' | 'cheapest';
    hideRouteSelectionPills?: boolean;
    hideRouteSelection?: boolean;
    hideRouteDetails?: boolean;
};
export type TestOptions = {
    enableHeadlessSigner?: boolean;
};
export type Experiments = 'feeOffsetting';
export type Experimental = {
    [Experiment in Experiments]?: boolean;
};
export interface ChainTokenPair {
    chain: Chain;
    token?: string;
}
export interface DefaultInputs {
    source?: ChainTokenPair;
    destination?: ChainTokenPair;
    requiredChain?: Chain;
    preferredRouteName?: string;
}
export type ExplorerConfig = {
    href: string;
    label?: string;
    target?: '_blank' | '_self';
};
export type PageHeader = {
    text: string;
    align: Alignment;
};
export type SearchTxConfig = {
    txHash?: string;
    chainName?: string;
};
export interface MenuEntry {
    label: string;
    href: string;
    target?: string;
    order?: number;
}
export declare function createUiConfig(customConfig: UiConfig): UiConfig;
//# sourceMappingURL=ui.d.ts.map