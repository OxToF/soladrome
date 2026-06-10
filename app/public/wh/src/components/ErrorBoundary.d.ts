import { default as React } from 'react';
export default class ErrorBoundary extends React.Component<{
    children: React.ReactElement;
}, {
    hasError: boolean;
}> {
    constructor(props: any);
    static getDerivedStateFromError(error: any): {
        hasError: boolean;
    };
    componentDidCatch(error: any, errorInfo: any): void;
    render(): React.JSX.Element;
}
//# sourceMappingURL=ErrorBoundary.d.ts.map