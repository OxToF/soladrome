import { Token } from '../config/tokens';
import { Chain } from '@wormhole-foundation/sdk';
type Props = {
    sourceChain: Chain | undefined;
    sourceToken: Token | undefined;
    destChain: Chain | undefined;
};
type ReturnProps = {
    supportedDestTokens: Token[];
    isFetching: boolean;
};
declare const useComputeDestinationTokens: (props: Props) => ReturnProps;
export default useComputeDestinationTokens;
//# sourceMappingURL=useComputeDestinationTokens.d.ts.map