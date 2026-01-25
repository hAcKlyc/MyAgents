/**
 * MonacoEditor - Lightweight Monaco Editor wrapper for file editing
 * 
 * Features:
 * - Auto language detection based on file extension
 * - Custom warm theme matching preview background
 * - Optimized for performance (minimal features enabled)
 * - Loading state handling
 * - Local bundle (no CDN) for Tauri CSP compatibility
 */
import Editor, { loader, type Monaco } from '@monaco-editor/react';
import { Loader2 } from 'lucide-react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
// CRITICAL: Must import Monaco CSS for styles to work in Vite bundled mode
import 'monaco-editor/min/vs/editor/editor.main.css';
import { useCallback, useMemo } from 'react';

// Configure Monaco Environment for bundled workers (required for Tauri CSP)
self.MonacoEnvironment = {
    getWorker(_: unknown, label: string) {
        if (label === 'json') {
            return new jsonWorker();
        }
        if (label === 'css' || label === 'scss' || label === 'less') {
            return new cssWorker();
        }
        if (label === 'html' || label === 'handlebars' || label === 'razor') {
            return new htmlWorker();
        }
        if (label === 'typescript' || label === 'javascript') {
            return new tsWorker();
        }
        return new editorWorker();
    }
};

// Configure Monaco to use local bundle instead of CDN
loader.config({ monaco });

// Custom theme name
const CUSTOM_THEME_NAME = 'warmLight';

// Re-export language utilities from shared module for backward compatibility
export { getMonacoLanguage, shouldShowLineNumbers } from '@/utils/languageUtils';

interface MonacoEditorProps {
    value: string;
    onChange: (value: string) => void;
    language?: string;
    readOnly?: boolean;
    className?: string;
}

export default function MonacoEditor({
    value,
    onChange,
    language = 'plaintext',
    readOnly = false,
    className = ''
}: MonacoEditorProps) {
    const handleChange = useCallback((newValue: string | undefined) => {
        onChange(newValue ?? '');
    }, [onChange]);

    // Register custom theme in beforeMount using the callback's monaco instance
    // This ensures we're defining the theme on the exact instance the Editor will use
    // Colors are aligned with Prism oneLight theme for consistency between preview and edit modes
    const handleBeforeMount = useCallback((monacoInstance: Monaco) => {
        monacoInstance.editor.defineTheme(CUSTOM_THEME_NAME, {
            base: 'vs',
            inherit: true,
            rules: [
                // Prism oneLight colors (with warm background adaptation)
                { token: 'comment', foreground: '9ea1a7', fontStyle: 'italic' },  // hsl(230, 4%, 64%)
                { token: 'keyword', foreground: 'a626a4' },                        // hsl(301, 63%, 40%) - purple
                { token: 'keyword.control', foreground: 'a626a4' },
                { token: 'storage', foreground: 'a626a4' },
                { token: 'storage.type', foreground: 'a626a4' },
                { token: 'string', foreground: '50a14f' },                         // hsl(119, 34%, 47%) - green
                { token: 'string.quoted', foreground: '50a14f' },
                { token: 'number', foreground: 'b76b01' },                         // hsl(35, 99%, 36%) - orange
                { token: 'constant', foreground: 'b76b01' },
                { token: 'constant.numeric', foreground: 'b76b01' },
                { token: 'type', foreground: 'b76b01' },                           // class-name color
                { token: 'type.identifier', foreground: 'b76b01' },
                { token: 'class', foreground: 'b76b01' },
                { token: 'function', foreground: '4078f2' },                       // hsl(221, 87%, 60%) - blue
                { token: 'function.call', foreground: '4078f2' },
                { token: 'variable', foreground: '4078f2' },
                { token: 'variable.other', foreground: '4078f2' },
                { token: 'operator', foreground: '4078f2' },
                { token: 'tag', foreground: 'e45649' },                            // hsl(5, 74%, 59%) - red
                { token: 'attribute.name', foreground: 'b76b01' },
                { token: 'attribute.value', foreground: '50a14f' },
                { token: 'delimiter', foreground: '383a42' },                      // punctuation
                { token: 'delimiter.bracket', foreground: '383a42' },
            ],
            colors: {
                // Editor background - matching preview warm tone
                'editor.background': '#f8f5ef',
                'editor.foreground': '#383a42',  // Prism oneLight foreground
                'editor.lineHighlightBackground': '#f3f0ea',
                'editor.selectionBackground': '#e5e5e6',  // hsl(230, 1%, 90%)
                'editor.inactiveSelectionBackground': '#f0ede6',
                // Line numbers
                'editorLineNumber.foreground': '#9ea1a7',  // match comment color
                'editorLineNumber.activeForeground': '#383a42',
                // Scrollbar - subtle to match preview
                'scrollbar.shadow': '#00000000',
                'scrollbarSlider.background': '#c8b8a840',
                'scrollbarSlider.hoverBackground': '#b8a08860',
                'scrollbarSlider.activeBackground': '#a0906880',
                // Gutter and margins - matching preview exactly
                'editorGutter.background': '#f8f5ef',
                // Cursor
                'editorCursor.foreground': '#383a42',
                // Indent guides
                'editorIndentGuide.background': '#e8e4db',
                'editorIndentGuide.activeBackground': '#d8d4cb',
            }
        });
    }, []);

    // Force apply theme after mount to ensure it takes effect
    // This handles the case where beforeMount's defineTheme might not sync immediately
    const handleOnMount = useCallback((_editor: unknown, monacoInstance: Monaco) => {
        monacoInstance.editor.setTheme(CUSTOM_THEME_NAME);
    }, []);

    // Monaco editor options optimized for performance
    const options = useMemo(() => ({
        readOnly,
        minimap: { enabled: false },
        lineNumbers: 'on' as const,
        lineNumbersMinChars: 4,
        scrollBeyondLastLine: false,
        wordWrap: 'on' as const,
        wrappingStrategy: 'advanced' as const,
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        tabSize: 2,
        automaticLayout: true,
        padding: { top: 16, bottom: 16 },
        scrollbar: {
            vertical: 'auto' as const,
            horizontal: 'auto' as const,
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
            useShadows: false,
        },
        // Disable features for performance
        folding: true,
        foldingHighlight: false,
        showFoldingControls: 'mouseover' as const,
        renderWhitespace: 'none' as const,
        guides: {
            indentation: true,
            bracketPairs: false,
        },
        bracketPairColorization: { enabled: false },
        contextmenu: false,
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        acceptSuggestionOnEnter: 'off' as const,
        hover: { enabled: false },
        parameterHints: { enabled: false },
    }), [readOnly]);

    return (
        <div className={`relative h-full w-full overflow-hidden ${className}`}>
            <Editor
                height="100%"
                language={language}
                value={value}
                onChange={handleChange}
                theme={CUSTOM_THEME_NAME}
                options={options}
                beforeMount={handleBeforeMount}
                onMount={handleOnMount}
                loading={
                    <div className="flex h-full items-center justify-center gap-2 text-[var(--ink-muted)]">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        <span className="text-sm">加载编辑器...</span>
                    </div>
                }
            />
        </div>
    );
}

