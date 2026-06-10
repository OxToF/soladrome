import { Route } from '@lifi/sdk';
import { Network } from '@wormhole-foundation/sdk-connect';
import { PlatformContext } from '../types';
export declare function generateThrowawayAddress(): string;
export declare function executeSuiSteps<N extends Network>(route: Route, context: PlatformContext<N>): Promise<void>;
//# sourceMappingURL=sui.d.ts.map