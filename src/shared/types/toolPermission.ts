/** Per-request constraints supplied by the runtime; never session preferences. */
export interface ToolPermissionHints {
    defaultToNo?: boolean;
    suppressAlwaysAllowRule?: boolean;
}

/** Request-scoped choices offered by a runtime. The display label and selection ID are opaque. */
export interface ToolPermissionOption {
    optionId: string;
    name: string;
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}
