import { default as React } from 'react';
import { ExplorerConfig } from '../../../../config/ui';
import { SxProps, Theme } from '@mui/material';
type ExplorerLinkProps = {
    address: string;
    sx?: SxProps<Theme>;
} & ExplorerConfig;
declare const ExplorerLink: (props: ExplorerLinkProps) => React.JSX.Element;
export default ExplorerLink;
//# sourceMappingURL=ExplorerLink.d.ts.map