/// <reference types="vite/client" />

// Analytics environment variables
interface ImportMetaEnv {
    readonly VITE_ANALYTICS_ENABLED?: string;
    readonly VITE_ANALYTICS_API_KEY?: string;
    readonly VITE_ANALYTICS_ENDPOINT?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

// Monaco Editor worker imports for Vite bundling
declare module 'monaco-editor/esm/vs/editor/editor.worker?worker' {
    const WorkerFactory: new () => Worker;
    export default WorkerFactory;
}

declare module 'monaco-editor/esm/vs/language/json/json.worker?worker' {
    const WorkerFactory: new () => Worker;
    export default WorkerFactory;
}

declare module 'monaco-editor/esm/vs/language/css/css.worker?worker' {
    const WorkerFactory: new () => Worker;
    export default WorkerFactory;
}

declare module 'monaco-editor/esm/vs/language/html/html.worker?worker' {
    const WorkerFactory: new () => Worker;
    export default WorkerFactory;
}

declare module 'monaco-editor/esm/vs/language/typescript/ts.worker?worker' {
    const WorkerFactory: new () => Worker;
    export default WorkerFactory;
}
