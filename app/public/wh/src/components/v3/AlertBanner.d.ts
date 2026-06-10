import { default as React, ReactNode } from 'react';
import { SxProps } from '@mui/material';
interface AlertBannerProps {
    children: ReactNode;
    warning?: boolean;
    error?: boolean;
    testId?: string;
    color?: string;
    sx?: SxProps;
    className?: string;
}
declare function AlertBanner({ children, warning, error, testId, color, sx, className, }: AlertBannerProps): React.JSX.Element;
export default AlertBanner;
//# sourceMappingURL=AlertBanner.d.ts.map