import { Chain, Network, Signer, routes } from '@wormhole-foundation/sdk-connect';
import { Quote, TransferParams, ValidationResult } from '../routes/mayan/types';
export declare function isHyperCoreChain(chain: Chain): boolean;
/**
 * Enforces HyperCore routing rules: only EVM -> HyperCore flows with USDC
 * inbound, and disallow HyperCore-originated USDC.
 */
export declare function validateHyperCoreTransfer<N extends Network>(request: routes.RouteTransferRequest<N>, params: TransferParams): ValidationResult | null;
/**
 * Fetches the HyperCore USDC permit params and asks the signer to sign them
 * when the quote indicates a permit is required.
 */
export declare function maybeGetHyperCorePermitSignature<N extends Network>(request: routes.RouteTransferRequest<N>, signer: Signer<N>, quote: Quote, destinationAddress: string): Promise<string | undefined>;
//# sourceMappingURL=hypercore.d.ts.map