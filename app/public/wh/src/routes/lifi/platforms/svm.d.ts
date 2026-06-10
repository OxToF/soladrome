import { Route } from '@lifi/sdk';
import { Network } from '@wormhole-foundation/sdk-connect';
import { PlatformContext } from '../types';
export declare function generateThrowawayAddress(): string;
export declare function executeSolanaSteps<N extends Network>(route: Route, context: PlatformContext<N>): Promise<void>;
//# sourceMappingURL=svm.d.ts.map