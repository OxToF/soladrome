import { WormholeConnectConfig } from './config/types';
import { WormholeConnectTheme } from 'theme';
export interface HostedParameters {
    config?: WormholeConnectConfig;
    theme?: WormholeConnectTheme;
    version?: string;
    cdnBaseUrl?: string;
}
export declare function wormholeConnectHosted(parentNode: HTMLElement, params?: HostedParameters): void;
//# sourceMappingURL=hosted.d.ts.map